import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { atomicJson } from "../../src/journal.ts";
import { withBindingFence } from "../../src/binding-fence.ts";
import { acquireWatchdog, DeliveryWatchdog } from "../../src/watchdog.ts";
import { DoriService } from "../../src/service.ts";
const [mode, dir] = process.argv.slice(2) as [string, string];
const config = { ...defaultConfig(), stateDir: dir };
if (mode === "service") {
  const service = new DoriService(config);
  await service.registry.write({ key: "lead", title: "original", thread: "none", brief: "", done: "", openedAt: new Date().toISOString() });
  await withBindingFence(dir, async () => {
    atomicJson(join(dir, "ready.json"), { ready: true });
    while (!await Bun.file(join(dir, "resume")).exists()) await Bun.sleep(10);
    await service.registry.update("lead", lane => ({ ...lane, title: "stale commit" }));
    atomicJson(join(dir, "stale.json"), { committed: true });
  });
} else {
  const release = await acquireWatchdog(dir);
  let polls = 0;
  const watchdog = new DeliveryWatchdog(config, { health: async () => { atomicJson(join(dir, "polls.json"), { polls: ++polls }); return { serviceReachable: true, phase: "ready" }; } });
  try {
    for (;;) { await watchdog.poll(); atomicJson(join(dir, "ready.json"), { ready: true }); await Bun.sleep(20); }
  } finally { await release(); }
}
