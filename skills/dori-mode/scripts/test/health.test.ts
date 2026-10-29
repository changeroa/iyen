import { expect, test } from "bun:test";
import { join } from "node:path";
import { atomicJson } from "../src/journal.ts";
import { readStartupHealth } from "../src/health.ts";
import { withState } from "./fakes.ts";

test("startup fallback exposes progress, never confirms RPC readiness or arbitrary saved fields", () => {
  const state = withState();
  try {
    atomicJson(join(state.dir, "service.lock"), { pid: process.pid });
    atomicJson(join(state.dir, "service-health.json"), { pid: process.pid, phase: "replaying", updatedAt: new Date().toISOString(), replay: { records: 500000, lanes: 3 }, token: "private-token", message: "untrusted extra details" });
    const result = readStartupHealth(state.dir);
    expect(result).toMatchObject({ serviceReachable: false, phase: "replaying", processAlive: true, replay: { records: 500000, lanes: 3 } });
    expect(JSON.stringify(result)).not.toMatch(/private-token|untrusted extra/);
    atomicJson(join(state.dir, "service-health.json"), { pid: process.pid, phase: "ready" });
    expect(readStartupHealth(state.dir)).toMatchObject({ serviceReachable: false, phase: "unavailable", recordedPhase: "ready" });
    atomicJson(join(state.dir, "service.lock"), { pid: process.pid + 1 });
    atomicJson(join(state.dir, "service-health.json"), { pid: process.pid, phase: "replaying" });
    expect(readStartupHealth(state.dir)).toMatchObject({ phase: "unavailable", processAlive: false });
  } finally { state.done(); }
});

test("missing or malformed startup data is unavailable rather than healthy", async () => {
  const state = withState();
  try {
    expect(readStartupHealth(state.dir)).toMatchObject({ phase: "unavailable", processAlive: false });
    await Bun.write(join(state.dir, "service-health.json"), "{");
    expect(readStartupHealth(state.dir).phase).toBe("unavailable");
  } finally { state.done(); }
});
