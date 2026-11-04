import { afterEach, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { readJson } from "../src/ipc.ts";
import { DoriService, type ExternalTransport } from "../src/service.ts";
import type { Runner } from "../src/run.ts";
import { payloadHash } from "../src/runtime/omp/contract.ts";
import { ompFixture } from "./fixtures/omp.ts";

const admin = { role: "admin" as const };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function fixture(omp = true) {
  const f = ompFixture(); f.transcript([]);
  Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity);
  let held = false, observerCwd = f.directory, badAssociation = false;
  let snapshotMode = "valid", preflight: (() => Promise<void>) | undefined;
  let pane = f.identity.paneId, terminal = f.identity.terminalId;
  const methods: string[] = [];
  let inspected: (() => void) | undefined;
  await f.serve(request => {
    methods.push(request.method); inspected?.();
    return { protocol: 1, id: request.id, identity: f.identity, result: { ...f.snapshot, identity: f.identity, held } };
  });
  const row = () => ({ agent: omp ? "omp" : "codex", pane_id: pane, terminal_id: terminal, cwd: f.directory, agent_status: "idle",
    agent_session: { agent: omp ? "omp" : "codex", kind: omp ? "path" : "id", source: omp ? "herdr:omp" : "herdr:codex", value: omp ? f.identity.sessionFile : f.identity.sessionId } });
  const runner: Runner = async argv => {
    const ok = (result: unknown) => ({ code: 0, out: JSON.stringify({ result }), err: "" });
    if (argv[0] === "herdr" && argv[1] === "api") {
      const rows = [snapshotMode === "unknown-target" ? { ...row(), agent_session: undefined } : row(), ...(snapshotMode === "unrelated-unassociated" ? [{ pane_id: "other:unassociated", agent: omp ? "omp" : "codex" }] : []), ...(snapshotMode === "duplicate" ? [{ ...row(), pane_id: "duplicate:pane" }] : []), ...(snapshotMode === "mislabelled-duplicate" ? [{ ...row(), pane_id: "duplicate:pane", agent: "unknown", agent_session: { ...row().agent_session, kind: "unknown" } }] : []),
        ...(snapshotMode === "old-present" ? [{ pane_id: "w1:p1" }] : [])];
      return ok({ snapshot: { panes: rows, agents: snapshotMode === "incomplete" ? undefined : rows } });
    }
    if (argv[0] === "herdr" && argv[1] === "agent") {
      if (preflight) { const callback = preflight; preflight = undefined; await callback(); }
      return ok(argv[2] === "list" ? { agents: [badAssociation ? { ...row(), terminal_id: "bad" } : row()] } : { agent: row() });
    }
    if (argv[1] === "app-server") return { code: 0, out: JSON.stringify({ status: "running", cliVersion: "0.200.0", appServerVersion: "0.200.0", socketPath: join(f.directory, "codex.sock") }), err: "" };
    if (argv[1] === "queue" && argv[2] === "--help") return { code: 0, out: "queue --thread <UUID> --message <TEXT>", err: "" };
    throw new Error(`Unexpected production/mutation call ${argv.join(" ")}`);
  };
  const observer = { close() {}, async read(method: string, params: any): Promise<any> {
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: observerCwd, status: { type: "idle" } } };
    if (method === "thread/loaded/list") return { data: [f.identity.sessionId], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "initialize") return {};
    throw new Error("Unsupported observer method");
  } };
  const transport: ExternalTransport = { connect: async () => observer, observe: async (_r, _c, _a, action) => action(observer) };
  const defaults = defaultConfig(f.directory);
  const config = { ...defaults, stateDir: join(f.directory, "state"), defaultCwd: f.directory,
    runtime: { ...defaults.runtime, kind: omp ? "omp" as const : "codex" as const, binary: process.execPath, requiredVersion: "18.15.0", rpcTimeoutMs: 300,
      omp: { registryDir: f.directory, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "yolo" as const } } };
  const publish = () => atomicJson(join(f.directory, `${payloadHash(`${f.identity.instanceId}:${f.identity.generation}`)}.json`), { ...f.target, ...f.identity, pid: process.pid, startedAt: new Date().toISOString() });
  publish();
  let s = new DoriService(config, runner, transport);
  atomicJson(join(config.stateDir, "control.json"), { token: "admin" });
  const saved = () => readJson<any>(join(config.stateDir, "attachments/lead.json"));
  const attach = { threadId: f.identity.sessionId, pane, cwd: f.directory, ...(omp ? { sessionFile: f.identity.sessionFile, terminalId: terminal } : {}) };
  await s.handle("lead-attach", attach, admin);
  const args = async (operationId = "reconnect") => {
    const lane = (await s.registry.read("lead"))!;
    return { ...attach, pane, ...(omp ? { terminalId: terminal } : {}), operationId, expectedInstance: lane.runtime!.hostInstanceId, expectedGeneration: lane.runtime!.generation, expectedRevision: lane.revision! };
  };
  const restart = (move = false) => {
    unlinkSync(join(f.directory, `${payloadHash(`${f.identity.instanceId}:${f.identity.generation}`)}.json`));
    if (move) { pane = "w1:p2"; terminal = "term_new"; }
    Object.assign(f.identity, { instanceId: "fresh-controller", generation: 2, paneId: pane, terminalId: terminal });
    publish();
  };
  cleanup.push(() => { s.stop(); f.cleanup(); });
  return { f, get s() { return s; }, saved, args, restart, methods, config,
    reload: () => { s.stop(); s = new DoriService(config, runner, transport); },
    onInspect: (callback: () => void) => inspected = callback,
    held: () => held = true, invalid: () => badAssociation = true, wrongCwd: () => observerCwd = "/",
    snapshot: (mode: string) => snapshotMode = mode, race: (callback: () => Promise<void>) => preflight = callback,
    moveCodex: () => { pane = "w1:p2"; },
  };
}

test("OMP native restart rotates one generation, revokes old bridge, preserves mail and history; same op survives service restart", async () => {
  const h = await fixture(), old = h.saved();
  for (const id of ["old", "queued"]) h.s.inbox.put({ id, target: "lead", text: id, state: "queued", at: "2026-01-01", attachmentInstance: old.instance });
  h.s.outbox.put({ id: "sent", target: "owner", text: "history", state: "sent", at: "2026-01-01" });
  const inbox = structuredClone(h.s.inbox.list()), outbox = structuredClone(h.s.outbox.list());
  h.restart(); const args = await h.args();
  const result = await h.s.handle("lead-reconnect", args, admin), current = h.saved();
  expect(result).toMatchObject({ attached: true, bridge: current.bridge, lead: { runtime: { generation: old.generation + 1 }, readiness: "ready" } });
  expect(current.threadId).toBe(old.threadId); expect(current.pane).toBe(old.pane); expect(current.cwd).toBe(old.cwd);
  expect(current.omp.sessionFile).toBe(old.omp.sessionFile); expect(current.omp.terminalId).toBe(old.omp.terminalId);
  expect(current.instance).not.toBe(old.instance); expect(current.token).not.toBe(old.token);
  expect(current.excludedInboxIds).toEqual(expect.arrayContaining(["old", "queued"]));
  expect(h.s.inbox.list()).toEqual(inbox); expect(h.s.outbox.list()).toEqual(outbox);
  expect((await h.s.registry.read("lead"))!.runtimeHistory!.at(-1)!.hostInstanceId).toBe(old.instance);
  await expect(h.s.authorize(old.token)).rejects.toThrow("Forbidden");
  expect(await h.s.authorize(current.token)).toMatchObject({ instance: current.instance });
  expect(await h.s.handle("lead-reconnect", args, admin)).toEqual(result);
  h.reload(); expect(await h.s.handle("lead-reconnect", args, admin)).toEqual(result);
  await expect(h.s.handle("lead-reconnect", { ...args, pane: "changed" }, admin)).rejects.toThrow("different arguments");
  expect(h.methods.every(m => m === "inspect")).toBe(true);
});

test("same target reconnect reuses bridge and generation", async () => {
  const h = await fixture(), old = h.saved(), args = await h.args();
  expect(await h.s.handle("lead-reconnect", args, admin)).toMatchObject({ attached: true, reused: true, bridge: old.bridge });
  expect(h.saved()).toEqual(old);
});

for (const boundary of ["hold", "attachment", "registry", "release", "cleanup"] as const) test(`reconnect recovers ${boundary} crash with recorded generation and unchanged mail`, async () => {
  const h = await fixture(), old = h.saved(); h.restart(); const args = await h.args();
  h.s.inbox.put({ id: "keep", target: "lead", text: "keep", state: "queued", at: "2026-01-01", attachmentInstance: old.instance });
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => {
    const result = await update(key, lane => {
      const next = fn(lane);
      if (armed && boundary === "attachment" && next.runtime?.hostInstanceId !== old.instance) { armed = false; throw new Error("injected"); }
      return next;
    });
    if (armed && (boundary === "hold" && result.dispatchBlocked || boundary === "registry" && result.runtime?.hostInstanceId !== old.instance || boundary === "release" && !result.dispatchBlocked)) { armed = false; throw new Error("injected"); }
    return result;
  };
  if (boundary === "cleanup") h.s.handoffIO.removeMarker = () => { throw new Error("injected"); };
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("injected");
  h.reload();
  const result = await h.s.handle("lead-reconnect", args, admin);
  expect(result.lead.runtime.generation).toBe(old.generation + 1);
  expect(h.s.inbox.get("keep")).toMatchObject({ attachmentInstance: old.instance, state: "queued" });
  expect(existsSync(join(h.config.stateDir, "attachments/handoff.json"))).toBe(false);
});

for (const field of ["expectedInstance", "expectedGeneration", "expectedRevision"] as const) test(`reconnect rejects stale ${field}`, async () => {
  const h = await fixture(), old = h.saved(), args = await h.args(); h.restart();
  await expect(h.s.handle("lead-reconnect", { ...args, [field]: field === "expectedInstance" ? "stale" : args[field] + 1 }, admin)).rejects.toThrow("epoch/revision");
  expect(h.saved()).toEqual(old);
});
for (const status of ["paused", "done-claimed", "verified-done", "closed"] as const) test(`reconnect refuses ${status}`, async () => {
  const h = await fixture(); await h.s.registry.update("lead", l => ({ ...l, status })); h.restart();
  await expect(h.s.handle("lead-reconnect", await h.args(), admin)).rejects.toThrow("hold");
});
for (const holdReason of ["owner-pause", "done-review"] as const) test(`reconnect refuses ${holdReason}`, async () => {
  const h = await fixture(); await h.s.registry.update("lead", l => ({ ...l, holdReason })); h.restart();
  await expect(h.s.handle("lead-reconnect", await h.args(), admin)).rejects.toThrow("hold");
});
for (const state of ["sending", "unknown"] as const) test(`reconnect refuses unresolved ${state} mail without changing records`, async () => {
  const h = await fixture(), old = h.saved();
  h.s.inbox.put({ id: "uncertain", target: "lead", text: "x", state, at: "2026-01-01", attachmentInstance: old.instance });
  const before = structuredClone(h.s.inbox.list()); h.restart();
  await expect(h.s.handle("lead-reconnect", await h.args(), admin)).rejects.toThrow("reconciliation");
  expect(h.s.inbox.list()).toEqual(before); expect(h.saved()).toEqual(old);
});
test("native held target, invalid native association and scoped callers refuse reconnect", async () => {
  const h = await fixture(), old = h.saved(), args = await h.args(); h.restart();
  for (const role of ["lead", "lane", "host"] as const) await expect(h.s.handle("lead-reconnect", args, { role, key: "lead" })).rejects.toThrow("operator");
  h.held(); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("natively held");
  h.invalid(); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("association mismatch");
  expect(h.saved()).toEqual(old);
});
test("owner pause racing target preflight is preserved by revision fence", async () => {
  const h = await fixture(), old = h.saved(), args = await h.args(); h.restart();
  h.race(async () => { await h.s.registry.update("lead", l => ({ ...l, holdReason: "owner-pause", dispatchBlocked: true })); });
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("hold");
  expect(h.saved()).toEqual(old); expect((await h.s.registry.read("lead"))!.holdReason).toBe("owner-pause");
});

test("simultaneous distinct reconnect operations cannot rotate twice", async () => {
  const h = await fixture(), old = h.saved(), args = await h.args(); h.restart();
  const results = await Promise.allSettled([h.s.handle("lead-reconnect", args, admin), h.s.handle("lead-reconnect", { ...args, operationId: "racer" }, admin)]);
  expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]); expect(h.saved().generation).toBe(old.generation + 1);
});

for (const omp of [false, true]) test(`${omp ? "OMP" : "Codex"} same native session resumes in new pane only after old pane disappears`, async () => {
  const h = await fixture(omp), old = h.saved(); if (omp) h.restart(true); else h.moveCodex();
  const args = await h.args();
  h.snapshot("old-present"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("absence");
  h.snapshot("duplicate"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("ownership");
  h.snapshot("incomplete"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("snapshot");
  h.snapshot("valid"); const result = await h.s.handle("lead-reconnect", args, admin);
  expect(result.lead.pane).toBe("w1:p2"); expect(h.saved().generation).toBe(old.generation + 1); expect(h.saved().threadId).toBe(old.threadId);
});
for (const omp of [false, true]) test(`${omp ? "OMP" : "Codex"} reconnect requires target identity but tolerates unrelated unassociated agents`, async () => {
  const h = await fixture(omp), old = h.saved(); if (omp) h.restart(true); else h.moveCodex();
  const args = await h.args();
  h.snapshot("mislabelled-duplicate"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("ownership");
  h.snapshot("unknown-target"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("snapshot incomplete");
  expect(h.saved()).toEqual(old);
  h.snapshot("unrelated-unassociated"); const result = await h.s.handle("lead-reconnect", args, admin);
  expect(result.lead.pane).toBe("w1:p2"); expect(h.saved().threadId).toBe(old.threadId);
  expect(h.saved().generation).toBe(old.generation + 1);
});

test("same-pane duplicate UUID ownership is rejected; observer cwd is independently checked", async () => {
  const h = await fixture(false), old = h.saved(), args = await h.args();
  h.snapshot("duplicate"); await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("ownership");
  h.snapshot("valid"); h.moveCodex(); h.wrongCwd();
  await expect(h.s.handle("lead-reconnect", await h.args(), admin)).rejects.toThrow("identity mismatch");
  expect(h.saved()).toEqual(old);
});

test("reconnect rejects exact target changes and unbounded arguments before publication", async () => {
  const h = await fixture(), args = await h.args(), old = h.saved();
  for (const change of [{ threadId: "22222222-2222-4222-8222-222222222222" }, { cwd: "/" }, { terminalId: "other-terminal" }, { extra: true }, { expectedRevision: -1 }])
    await expect(h.s.handle("lead-reconnect", { ...args, ...change }, admin)).rejects.toThrow();
  expect(h.saved()).toEqual(old);
});

test("pending native restart and another durable reconnect fence new requests", async () => {
  const h = await fixture(), args = await h.args(); h.restart();
  const active = h.s.leadRestarts.hasActive.bind(h.s.leadRestarts);
  h.s.leadRestarts.hasActive = () => true;
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("restart incomplete");
  h.s.leadRestarts.hasActive = active;
  h.s.handoffIO.removeMarker = () => { throw new Error("interrupted"); };
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("interrupted");
  await expect(h.s.handle("lead-reconnect", { ...args, operationId: "another" }, admin)).rejects.toThrow("pending");
});

test("native hold acquired after preparation blocks transaction completion", async () => {
  const h = await fixture(), args = await h.args(), old = h.saved(); h.restart();
  let calls = 0; h.onInspect(() => { if (++calls === 5) h.held(); });
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("natively held");
  expect(h.saved()).toEqual(old);
  expect(existsSync(join(h.config.stateDir, "attachments/handoff.json"))).toBe(true);
  await expect(h.s.handle("input", { key: "lead", text: "must stay fenced", operationId: "blocked" }, admin)).rejects.toThrow("mutations are held");
});

test("plain registry revision race after intent publication cannot commit", async () => {
  const h = await fixture(), args = await h.args(), old = h.saved(); h.restart();
  let calls = 0;
  h.onInspect(() => { if (++calls === 2) h.race(async () => { await h.s.registry.update("lead", lane => ({ ...lane, brief: "changed concurrently" })); }); });
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("revision changed");
  const refused = await h.s.registry.read("lead");
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("revision changed");
  expect(await h.s.registry.read("lead")).toEqual(refused);
  h.reload();
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("revision changed");
  await expect(h.s.deps.runtime.inspect("lead")).rejects.toThrow("revision changed");
  expect(await h.s.registry.read("lead")).toEqual(refused);
  expect(h.saved()).toEqual(old);
  const intent = readJson<any>(join(h.config.stateDir, "attachments/handoffs", `${payloadHash(args.operationId)}.json`));
  expect(intent.reconnectWrites).toBeUndefined();
});

test("process death after its own hold WAL write recovers without any catch handler", async () => {
  const h = await fixture(), args = await h.args("hard-crash"), old = h.saved(); h.restart();
  const target = h.f.identity;
  const row = { agent: "omp", pane_id: target.paneId, terminal_id: target.terminalId, cwd: target.cwd,
    agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: target.sessionFile } };
  const script = `
    import { DoriService } from ${JSON.stringify(join(import.meta.dir, "../src/service.ts"))};
    const row = ${JSON.stringify(row)};
    const runner = async argv => ({code:0,err:"",out:JSON.stringify({result:argv[1] === "api" ? {snapshot:{panes:[row],agents:[row]}} : {agents:[row]}})});
    const service = new DoriService(${JSON.stringify(h.config)}, runner);
    const update = service.registry.update.bind(service.registry);
    service.registry.update = async (key, fn) => {
      const lane = await update(key, fn);
      if (key === "lead" && lane.runtime.hostInstanceId === ${JSON.stringify(old.instance)} && lane.dispatchBlocked) process.exit(73);
      return lane;
    };
    await service.handle("lead-reconnect", ${JSON.stringify(args)}, {role:"admin"});
    throw new Error("crash injection missed");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 73, stderr: "" });
  h.reload();
  const held = (await h.s.registry.read("lead"))!;
  expect(held.dispatchBlocked).toBe(true);
  expect(held.runtime!.external!.holdReason).toBeUndefined();
  const intent = readJson<any>(join(h.config.stateDir, "attachments/handoffs", `${payloadHash(args.operationId)}.json`));
  expect(intent.reconnectWrites).toHaveLength(1);
  expect(intent.reconnectWrites[0].before.revision).toBe(args.expectedRevision);
  expect(intent.reconnectWrites[0].after).toEqual(held);
  await h.s.deps.runtime.inspect("lead");
  expect(h.saved().generation).toBe(old.generation + 1);
  expect((await h.s.handle("lead-reconnect", args, admin)).attached).toBe(true);
});

test("a recorded own hold cannot authorize a later unrelated source revision", async () => {
  const h = await fixture(), args = await h.args(), old = h.saved(); h.restart();
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => {
    const lane = await update(key, fn);
    if (armed && lane.dispatchBlocked) { armed = false; throw new Error("interrupted own hold"); }
    return lane;
  };
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("interrupted own hold");
  await h.s.registry.update("lead", lane => ({ ...lane, brief: "unrelated later source update" }));
  h.reload();
  await expect(h.s.handle("lead-reconnect", args, admin)).rejects.toThrow("revision changed");
  await expect(h.s.deps.runtime.inspect("lead")).rejects.toThrow("revision changed");
  expect(h.saved()).toEqual(old);
});
