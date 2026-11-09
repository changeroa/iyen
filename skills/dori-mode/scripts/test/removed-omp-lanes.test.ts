import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { serviceSocket } from "../src/ipc.ts";
import { Registry, type Lane } from "../src/registry.ts";
import { DoriService } from "../src/service.ts";
import { object } from "../src/runtime/omp/contract.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

const legacy = (cwd: string): Lane => ({
  key: "old-omp", role: "lane", title: "Existing OMP work", thread: "none",
  brief: join(cwd, "brief.md"), done: "file /not-completed", cwd,
  pane: "legacy:pane", openedAt: "2026-01-01T00:00:00.000Z", status: "working",
  runtime: { kind: "omp", backend: "herdr-tui", state: "idle",
    threadId: "existing-native-session", hostInstanceId: "old-host",
    generation: 3, binaryVersion: "18.15.0",
    omp: { kind: "omp", attachmentInstanceId: "old-host", attachmentGeneration: 3,
      attachedAt: "2026-01-01T00:00:00.000Z", excludedInboxIds: [],
      target: { kind: "omp", protocol: 1, role: "managed-lane", laneKey: "old-omp",
        sessionId: "existing-native-session", sessionFile: join(cwd, "session.jsonl"),
        cwd, paneId: "legacy:pane", terminalId: "legacy-terminal",
        instanceId: "native-controller", generation: 1, runtimeVersion: "18.15.0",
        socketPath: join(cwd, "native.sock"), tokenFile: join(cwd, "native.token") },
    },
  },
});

async function fixture() {
  const state = withState(), world = newWorld();
  const config = { ...defaultConfig(), stateDir: state.dir };
  const lane = legacy(state.dir);
  await new Registry(state.dir).write(lane);
  const service = new DoriService(config, fakeRunner(world));
  return { state, world, config, lane, service };
}

test("startup retains registered OMP lanes in individual and aggregate status after journal replay", async () => {
  const f = await fixture();
  try {
    const original = await f.service.registry.read(f.lane.key);
    if (!original) throw new Error("Fixture lane missing");
    const restarted = new DoriService(f.config, fakeRunner(f.world));
    expect(await restarted.handle("status", { key: f.lane.key }, { role: "admin" })).toEqual(original);
    expect(await restarted.handle("status", {}, { role: "admin" })).toContainEqual(original);
    expect(await restarted.registry.open()).toContainEqual(original);
    expect(f.world.calls).toEqual([]);
  } finally { f.state.done(); }
});

for (const action of ["input", "input-status", "pause", "resume", "recover", "reopen",
  "adopt", "launch", "claim-done", "object-done", "report", "retire"]) {
  test(`registered OMP lane ${action} fails with actionable removal error before mutation`, async () => {
    const f = await fixture();
    try {
      const original = await f.service.registry.read(f.lane.key);
      await expect(f.service.handle(action, {
        key: f.lane.key, text: "new work", operationId: "new-operation",
      }, { role: "admin" })).rejects.toThrow(
        /Lane old-omp: OMP lanes were removed.*close old-omp.*Codex/,
      );
      expect(await f.service.registry.read(f.lane.key)).toEqual(original);
      expect(f.service.inbox.list()).toEqual([]);
      expect(f.service.operations.list()).toEqual([]);
      expect(f.world.calls).toEqual([]);
    } finally { f.state.done(); }
  });
}

test("direct runtime controls reject removed OMP lanes even without a registered thread", async () => {
  const f = await fixture();
  try {
    await f.service.registry.update(f.lane.key, lane => {
      if (!lane.runtime) throw new Error("Fixture runtime missing");
      return { ...lane, runtime: { ...lane.runtime, threadId: undefined } };
    });
    const runtime = f.service.deps.runtime;
    const queueInput = f.service.deps.queueInput;
    if (!queueInput) throw new Error("Fixture queue missing");
    for (const control of [
      () => runtime.inspect(f.lane.key),
      () => runtime.input(f.lane.key, "work", "op"),
      () => runtime.hold(f.lane.key, "user"),
      () => runtime.release(f.lane.key, "user"),
      () => runtime.stop(f.lane.key),
      () => f.service.boot(legacy(f.state.dir)),
      () => queueInput(f.lane.key, "work", "queued"),
    ]) await expect(control()).rejects.toThrow(/Lane old-omp: OMP lanes were removed/);
    expect(f.service.inbox.list()).toEqual([]);
    expect(f.world.calls).toEqual([]);
  } finally { f.state.done(); }
});

test("queued and unknown OMP mail survives startup ticks failed dispatch and record closure", async () => {
  const f = await fixture();
  try {
    for (const state of ["queued", "unknown"] as const) f.service.inbox.put({
      id: state, target: f.lane.key, text: `original ${state}`, state,
      at: "2026-01-01T00:00:00.000Z",
    });
    const original = f.service.inbox.list();
    const restarted = new DoriService(f.config, fakeRunner(f.world));
    await restarted.tick();
    await expect(restarted.handle("input", {
      key: f.lane.key, operationId: "queued", text: "original queued",
    }, { role: "admin" })).rejects.toThrow("OMP lanes were removed");
    await expect(restarted.handle("mail-resolve", {
      box: "inbox", id: "unknown", state: "sent", evidence: "operator",
    }, { role: "admin" })).rejects.toThrow(/Lane old-omp: OMP lanes were removed/);
    expect(await restarted.handle("close", { key: f.lane.key }, { role: "admin" })).toMatchObject({ closed: true });
    expect(new DoriService(f.config, fakeRunner(f.world)).inbox.list()
      .filter(row => row.target === f.lane.key)).toEqual(original);
    expect(f.world.calls).toEqual([]);
  } finally { f.state.done(); }
});

test("close clears a partially retired OMP registration without completing an uncertain native stop", async () => {
  const f = await fixture();
  try {
    const retirement = { operationId: "old-retirement", evidence: "Prior intent",
      payloadHash: "original", scopeHash: "original", requestedAt: f.lane.openedAt,
      phase: "stop-attempted" as const, runtimeStop: "unknown" as const };
    await f.service.registry.update(f.lane.key, lane => ({ ...lane, retirement }));
    expect(await f.service.handle("close", { key: f.lane.key }, { role: "admin" })).toMatchObject({ closed: true });
    expect(await f.service.registry.read(f.lane.key)).toMatchObject({ status: "closed", retirement });
    expect(f.world.calls).toEqual([]);
  } finally { f.state.done(); }
});

for (const status of ["working", "paused", "done-claimed", "verified-done"] as const) {
  test(`close retires ${status} OMP record without native stop or completion cleanup`, async () => {
    const f = await fixture();
    try {
      await f.service.registry.update(f.lane.key, lane => ({
        ...lane, status, dispatchBlocked: true, holdReason: "recovery",
        worktrees: [join(f.state.dir, "owned-worktree")], cleanupFence: "old-fence",
      }));
      const before = await f.service.registry.read(f.lane.key);
      if (!before) throw new Error("Fixture lane missing");
      expect(await f.service.handle("close", { key: f.lane.key }, { role: "admin" })).toMatchObject({ closed: true });
      const after = await f.service.registry.read(f.lane.key);
      if (!after) throw new Error("Fixture lane missing");
      expect(after).toMatchObject({
        status: "closed", dispatchBlocked: true, runtime: before.runtime,
        pane: before.pane, worktrees: before.worktrees,
      });
      expect(f.world.calls).toEqual([]);
      await expect(f.service.handle("reopen", { key: f.lane.key }, { role: "admin" }))
        .rejects.toThrow("OMP lanes were removed");
    } finally { f.state.done(); }
  });
}

test("scoped CLI exposes legacy OMP status rejects resume and allows record-only close", async () => {
  const f = await fixture();
  atomicJson(join(f.state.dir, "control.json"), { token: "test-operator" });
  atomicJson(join(f.state.dir, "config.json"), f.config);
  const server = Bun.serve({ unix: serviceSocket(f.state.dir), async fetch(request) {
    try {
      const caller = await f.service.authorize((request.headers.get("authorization") ?? "").replace("Bearer ", ""));
      const message: unknown = await request.json();
      if (!object(message) || typeof message.action !== "string" || !object(message.args)) throw new Error("Invalid test request");
      return Response.json({ result: await f.service.handle(message.action, message.args, caller) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 409 });
    }
  } });
  const cli = async (command: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), command, f.lane.key], {
      stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, HOME: process.env.HOME,
        DORI_CONFIG: join(f.state.dir, "config.json"), DORI_STATE_DIR: f.state.dir },
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { out, err, code };
  };
  try {
    const status = await cli("status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ key: f.lane.key, runtime: { kind: "omp" } });
    const resume = await cli("resume");
    expect(resume.code).not.toBe(0);
    expect(resume.err).toMatch(/Lane old-omp: OMP lanes were removed.*close old-omp/);
    expect((await cli("close")).code).toBe(0);
    expect((await f.service.registry.read(f.lane.key))?.status).toBe("closed");
  } finally { server.stop(true); f.state.done(); }
});
