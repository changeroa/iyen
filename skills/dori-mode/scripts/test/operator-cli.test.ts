import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { serviceSocket } from "../src/ipc.ts";
import { withState } from "./fakes.ts";

test("operator CLI forwards explicit handoff selections and refuses an implicit or scoped transfer", async () => {
  const state = withState(), requests: any[] = [];
  const server = Bun.serve({ unix: serviceSocket(state.dir), async fetch(request) {
    requests.push(await request.json()); return Response.json({ result: { ok: true } });
  } });
  try {
    const config = join(state.dir, "config.json");
    atomicJson(config, { ...defaultConfig(), stateDir: state.dir });
    atomicJson(join(state.dir, "control.json"), { token: "test-operator" });
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: state.dir, DORI_CONFIG: config };
    const run = async (args: string[], scoped = false) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
        env: { ...env, ...(scoped ? { DORI_CONTEXT: join(state.dir, "missing-context.json") } : {}) }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    const identity = ["--from-thread-id", "11111111-1111-4111-8111-111111111111", "--thread-id", "22222222-2222-4222-8222-222222222222", "--pane", "w1:p1", "--cwd", state.dir];
    expect((await run(["lead-handoff-preview", ...identity])).code).toBe(0);
    expect(requests[0]).toMatchObject({ action: "lead-handoff-preview", args: { fromThreadId: identity[1], threadId: identity[3] } });
    expect(requests[0].args.operationId).toBeUndefined();
    expect((await run(["lead-handoff", ...identity, "--operation-id", "handoff-test"])).err).toContain("Explicit --mail-id");
    expect((await run(["lead-handoff", ...identity, "--no-mail"])).err).toContain("operation-id required");
    expect(requests).toHaveLength(1);
    expect((await run(["lead-handoff", ...identity, "--operation-id", "handoff-test", "--mail-id", "first", "--mail-id", "second"])).code).toBe(0);
    expect(requests[1]).toMatchObject({ action: "lead-handoff", args: { operationId: "handoff-test", mailIds: ["first", "second"] } });
    expect((await run(["lead-handoff", ...identity, "--operation-id", "handoff-empty", "--no-mail"])).code).toBe(0);
    expect(requests[2].args.mailIds).toEqual([]);
    expect((await run(["lead-handoff", ...identity, "--operation-id", "handoff-empty", "--no-mail", "--mail-id", "first"])).code).toBe(1);
    expect((await run(["lead-handoff-preview", ...identity], true)).err).toContain("Scoped context cannot invoke");
    expect(requests).toHaveLength(3);
  } finally { server.stop(true); state.done(); }
});

test("health CLI exposes boot progress without granting scoped clients a local fallback", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    atomicJson(config, { ...defaultConfig(), stateDir: state.dir });
    atomicJson(join(state.dir, "service.lock"), { pid: process.pid });
    atomicJson(join(state.dir, "service-health.json"), { phase: "replaying", pid: process.pid, replay: { records: 10000, lanes: 3 } });
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: state.dir, DORI_CONFIG: config };
    const run = async (scoped: boolean) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "health"], {
        env: { ...env, ...(scoped ? { DORI_CONTEXT: join(state.dir, "missing-context.json") } : {}) }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    const operator = await run(false);
    expect(operator.code).toBe(3);
    expect(JSON.parse(operator.out)).toMatchObject({ serviceReachable: false, phase: "replaying" });
    const scoped = await run(true);
    expect(scoped.code).toBe(1); expect(scoped.out).toBe("");
  } finally { state.done(); }
});
