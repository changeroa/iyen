import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fakes.ts";
import { withBindingFence } from "../src/binding-fence.ts";

for (const mode of ["service", "watchdog"] as const) test(`unexpected acquired helper death fail-stops owning ${mode} without stale work`, async () => {
  const state = withState();
  const owner = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/fence-owner.ts"), mode, state.dir], { stdout: "pipe", stderr: "pipe" });
  try {
    for (let n = 0; n < 200 && !await Bun.file(join(state.dir, "ready.json")).exists(); n++) await Bun.sleep(10);
    expect(await Bun.file(join(state.dir, "ready.json")).exists()).toBe(true);
    // Restrict process discovery to this isolated owner and kill only its helper.
    const query = Bun.spawn(["pgrep", "-P", String(owner.pid)], { stdout: "pipe", stderr: "pipe" });
    const children = (await new Response(query.stdout).text()).trim().split(/\s+/).map(Number); await query.exited;
    expect(children).toHaveLength(1); expect(children[0]).toBeGreaterThan(0);
    process.kill(children[0]!, "SIGKILL");
    const exit = await Promise.race([owner.exited, Bun.sleep(1000).then(() => "still-running")]);
    expect(exit).toBe(74);
    expect(await new Response(owner.stderr).text()).toContain("IYEN_FENCE_LOST");
    if (mode === "service") {
      await withBindingFence(state.dir, async () => { await Bun.write(join(state.dir, "resume"), "continue"); });
      await Bun.sleep(40);
      expect(await Bun.file(join(state.dir, "stale.json")).exists()).toBe(false);
      expect((await Bun.file(join(state.dir, "lanes/lead.json")).json()).title).toBe("original");
    } else {
      const before = await Bun.file(join(state.dir, "polls.json")).text();
      await Bun.sleep(80); expect(await Bun.file(join(state.dir, "polls.json")).text()).toBe(before);
    }
  } finally { if (owner.exitCode === null) owner.kill("SIGKILL"); await owner.exited; state.done(); }
});
