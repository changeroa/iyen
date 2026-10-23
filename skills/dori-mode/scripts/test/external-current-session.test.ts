import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { hostSocket, readJson, socketDir } from "../src/ipc.ts";
import { DoriService } from "../src/service.ts";
import { operationText } from "../src/runtime/herdr.ts";
import { backendSocket, runSessionHost, startSessionHost } from "../src/runtime/session-host.ts";
import { deadPaneTick } from "../src/dead-panes.ts";
import { withState } from "./fakes.ts";
import type { Runner } from "../src/run.ts";

const threadId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
let h: ReturnType<typeof fixture>;
function fixture() {
  const state = withState(), socketPath = join(socketDir(state.dir), "shared.sock"), calls: string[][] = [], reads: string[] = [];
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, ingress: [{ id: "test", command: ["fixture"], owners: ["owner"] }], runtime: { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 80 } };
  const thread: any = { id: threadId, cwd: realpathSync(state.dir), model: "retained-model", reasoningEffort: "high", status: { type: "idle" } };
  let turns: any[] = [], loaded = true, accept = true, queueCode = 0, queueThrows = false, loseOnQueue = false, getCount = 0, driftAtGet = Infinity;
  const agent: any = { agent: "codex", pane_id: "w:p1", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: threadId } };
  const server = Bun.serve({ unix: socketPath, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
    const m = JSON.parse(String(raw)); reads.push(m.method); if (m.id === undefined) return;
    const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread } : m.method === "thread/loaded/list" ? { data: loaded ? [threadId] : [], nextCursor: null } :
      m.method === "thread/goal/get" ? { goal: null } : m.method === "thread/turns/list" ? { data: turns, nextCursor: null } : undefined;
    if (result === undefined) ws.send(JSON.stringify({ id: m.id, error: { code: -1, message: "mutation refused" } })); else ws.send(JSON.stringify({ id: m.id, result }));
  } } });
  const run: Runner = async argv => {
    calls.push([...argv]); const ok = (result: unknown) => ({ code: 0, err: "", out: JSON.stringify(result) });
    if (argv[0] === "herdr") {
      if (argv[1] === "agent" && argv[2] === "get") { if (++getCount >= driftAtGet) agent.agent_session.value = otherId; return ok({ result: { agent } }); }
      if (argv[1] === "agent" && argv[2] === "list") return ok({ result: { agents: [agent] } });
      if (argv[1] === "pane" && argv[2] === "list") return ok({ result: { panes: [agent] } });
    }
    if (argv.slice(1).join(" ") === "app-server daemon version") return ok({ status: "running", cliVersion: "0.163.0", appServerVersion: "0.163.0", socketPath });
    if (argv[1] === "queue") {
      if (accept) turns.push({ id: "real-turn-id", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: argv[5] }] }] });
      if (loseOnQueue) agent.agent_session.value = otherId;
      if (queueThrows) throw new Error("transport disconnect");
      return { code: queueCode, err: "", out: "submitted" };
    }
    throw new Error(`Unexpected mutation: ${argv.join(" ")}`);
  };
  const s = new DoriService(config, run), args = { threadId, pane: agent.pane_id, cwd: state.dir };
  return { state, s, args, config, run, calls, reads, thread, agent, server, setTurns: (v: any[]) => turns = v,
    busy() { thread.status = { type: "active", activeFlags: [] }; turns = [{ id: "owner-turn", status: "inProgress", items: [] }]; },
    idle() { thread.status = { type: "idle" }; turns = turns.map(t => ({ ...t, status: "completed" })); },
    unloaded() { loaded = false; thread.status = { type: "notLoaded" }; }, noReceipt() { accept = false; },
    queueFailure() { queueCode = 1; }, queueDisconnect() { queueThrows = true; }, loseOnQueue() { loseOnQueue = true; },
    driftBeforeSend() { driftAtGet = getCount + 3; }, done() { s.stop(); server.stop(true); state.done(); } };
}
beforeEach(() => { h = fixture(); atomicJson(join(h.state.dir, "control.json"), { token: "admin" }); });
afterEach(() => h.done());
const attach = () => h.s.handle("lead-attach", h.args, { role: "admin" });
const input = (id = "owner-input", text = "literal $(x) `x`") => h.s.handle("input", { key: "lead", text, operationId: id }, { role: "admin" });
const queueCalls = () => h.calls.filter(a => a[1] === "queue");

test("attach current running session retains identity/model/effort, uses no TUI/backend launch, and is idempotent", async () => {
  h.busy(); const first = await attach(), second = await attach();
  expect(first).toMatchObject({ attached: true, lead: { mode: "external-current-session", readiness: "busy", identityVerified: true, runtime: { threadId, model: "retained-model", effort: "high" } } });
  expect(second).toMatchObject({ attached: true, reused: true, bridge: first.bridge });
  expect(second.lead.runtime.generation).toBe(first.lead.runtime.generation);
  expect(first.bridge.startsWith("/")).toBe(true); expect(existsSync(first.bridge)).toBe(true);
  expect(readFileSync(first.bridge, "utf8")).toContain(join(import.meta.dir, "../src/cli.ts").replace("/test/../", "/"));
  expect(JSON.stringify(first)).not.toContain(readJson<any>(join(h.state.dir, "attachments/lead.json")).token);
  expect(h.calls.every(a => a[1] === "app-server" && a.slice(2).join(" ") === "daemon version" || a.slice(0, 3).join(" ") === "herdr agent get")).toBe(true);
  expect(h.reads.every(m => ["initialize", "initialized", "thread/read", "thread/loaded/list", "thread/goal/get", "thread/turns/list"].includes(m))).toBe(true);
});

test("invalid, missing, mismatched, notLoaded and cwd identities fail before writing attachment state", async () => {
  for (const args of [{ ...h.args, threadId: "missing" }, { ...h.args, pane: "" }, { ...h.args, cwd: "." }, { ...h.args, threadId: otherId }]) await expect(h.s.handle("lead-attach", args, { role: "admin" })).rejects.toThrow();
  const alias = join(h.state.dir, "alias"); symlinkSync(h.state.dir, alias); h.thread.cwd = alias;
  h.agent.agent_session = undefined; await expect(attach()).rejects.toThrow("identity mismatch");
  h.agent.agent_session = { agent: "codex", kind: "id", value: threadId }; h.thread.cwd = "/";
  await expect(attach()).rejects.toThrow("identity mismatch"); h.thread.cwd = h.state.dir; h.unloaded(); await expect(attach()).rejects.toThrow("identity mismatch");
  expect(await h.s.registry.read("lead")).toBeNull(); expect(existsSync(join(h.state.dir, "attachments/lead.json"))).toBe(false);
});

test("lead activation is operator only and managed lead creation/recovery routes are refused", async () => {
  for (const caller of [{ role: "lane" as const, key: "worker" }, { role: "lead" as const, key: "lead" }]) await expect(h.s.handle("lead-attach", h.args, caller)).rejects.toThrow("operator");
  for (const [action, args] of [["lead", {}], ["launch", { key: "lead", role: "lead" }], ["recover", { key: "lead" }], ["reopen", { key: "lead" }]] as const)
    await expect(h.s.handle(action, args, { role: "admin" })).rejects.toThrow("lead-attach");
  expect(h.calls).toHaveLength(0);
});

test("different attached lead is refused before mutation; concurrent attachment creates one generation", async () => {
  const results = await Promise.all([attach(), attach()]); expect(results[0].bridge).toBe(results[1].bridge);
  const before = await h.s.registry.read("lead");
  await expect(h.s.handle("lead-attach", { ...h.args, threadId: otherId }, { role: "admin" })).rejects.toThrow("different lead");
  expect(await h.s.registry.read("lead")).toEqual(before);
});

test("user model and effort changes are observed without changing settings or invalidating thread identity", async () => {
  const first = await attach(); h.thread.model = "user-selected-model"; h.thread.reasoningEffort = "medium";
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ identityVerified: true, readiness: "ready", runtime: { model: "user-selected-model", effort: "medium" } });
  expect(await attach()).toMatchObject({ reused: true, bridge: first.bridge }); await input(); expect(queueCalls()).toHaveLength(1);
  h.thread.reasoningEffort = null;
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ identityVerified: true, readiness: "ready" });
  expect(h.thread.model).toBe("user-selected-model"); expect(h.thread.reasoningEffort).toBeNull();
});

test("busy inputs remain queued, then deliver exact operation receipt to the same thread once", async () => {
  h.busy(); await attach(); expect(await input()).toMatchObject({ queued: true }); expect(h.s.inbox.get("owner-input")?.state).toBe("queued"); expect(queueCalls()).toHaveLength(0);
  h.idle(); await h.s.tick(); expect(h.s.inbox.get("owner-input")).toMatchObject({ state: "sent", turnId: "real-turn-id" });
  expect(queueCalls()[0]?.slice(1)).toEqual(["queue", "--thread", threadId, "--message", operationText("literal $(x) `x`", "owner-input")]);
  await input(); expect(queueCalls()).toHaveLength(1);
});

test("unconfirmed queue attempt stays unknown across restart and is never replayed", async () => {
  await attach(); h.noReceipt(); await expect(input()).rejects.toThrow("receipt unknown"); expect(h.s.inbox.get("owner-input")?.state).toBe("unknown");
  const restarted = new DoriService(h.config, h.run);
  await restarted.tick(); expect(restarted.inbox.get("owner-input")?.state).toBe("unknown"); expect(queueCalls()).toHaveLength(1);
  await expect(restarted.handle("input", { key: "lead", text: "literal $(x) `x`", operationId: "owner-input" }, { role: "admin" })).rejects.toThrow();
  expect(queueCalls()).toHaveLength(1);
});

test("queue failure or disconnect with exact persisted receipt is sent with the real turn id", async () => {
  await attach(); h.queueFailure(); h.queueDisconnect(); expect(await input()).toEqual({ turnId: "real-turn-id" }); expect(h.s.inbox.get("owner-input")?.state).toBe("sent");
});

test("assistant echo is not evidence and duplicate exact receipts block dispatch", async () => {
  await attach(); h.noReceipt(); const text = operationText("literal $(x) `x`", "owner-input");
  h.setTurns([{ id: "echo", status: "completed", items: [{ type: "agentMessage", text }] }]); await expect(input()).rejects.toThrow("receipt unknown");
  const user = { type: "userMessage", content: [{ type: "text", text: operationText("literal $(x) `x`", "duplicate") }] };
  h.setTurns([{ id: "duplicate-turn", status: "completed", items: [user, user] }]);
  await h.s.handle("lead-attach", h.args, { role: "admin" }); await expect(input("duplicate")).rejects.toThrow("Duplicate");
  expect(h.s.inbox.get("duplicate")?.state).toBe("unknown"); expect(queueCalls()).toHaveLength(1);
});

test("identity loss before send holds dispatch with queued mail; restored identity requires explicit reattach", async () => {
  await attach(); h.agent.agent_session.value = otherId;
  await expect(input()).rejects.toThrow("identity mismatch"); expect(h.s.inbox.get("owner-input")?.state).toBe("queued");
  expect(await h.s.registry.read("lead")).toMatchObject({ dispatchBlocked: true, holdReason: "recovery" });
  h.agent.agent_session.value = threadId; const restarted = new DoriService(h.config, h.run); await restarted.tick(); expect(queueCalls()).toHaveLength(0);
  expect(await restarted.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ identityVerified: true, readiness: "held" });
  await attach(); await input(); expect(queueCalls()).toHaveLength(1);
});

test("identity is checked again immediately before queue and after submission", async () => {
  await attach(); h.driftBeforeSend(); expect(await input()).toMatchObject({ queued: true }); expect(queueCalls()).toHaveLength(0);
});

test("identity lost after queue is unknown and never accepted as a sent receipt", async () => {
  await attach(); h.loseOnQueue(); await expect(input()).rejects.toThrow("delivery unknown"); expect(h.s.inbox.get("owner-input")?.state).toBe("unknown");
  expect(await h.s.registry.read("lead")).toMatchObject({ dispatchBlocked: true });
});

test("restart revalidates borrowed attachment without host heartbeats, boot or managed-host credentials", async () => {
  const first = await attach(); const saved = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  atomicJson(join(h.state.dir, "hosts/lead.json"), { hostToken: "stale-host", laneToken: "stale-lane", role: "lead" });
  const restarted = new DoriService(h.config, h.run); await restarted.tick();
  expect(await restarted.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "ready", bridge: first.bridge, identityVerified: true });
  expect(await restarted.authorize(saved.token)).toMatchObject({ role: "lead", instance: saved.instance });
  for (const token of ["stale-host", "stale-lane"]) await expect(restarted.authorize(token)).rejects.toThrow("Forbidden");
  expect(await deadPaneTick(h.run, h.config, restarted.registry, Date.now() + 999999)).toEqual([]);
  expect(existsSync(hostSocket(h.state.dir, "lead"))).toBe(false); expect(queueCalls()).toHaveLength(0);
});

test("detach revokes old credentials and wrapper, expected identity prevents stale detach, no runtime is stopped", async () => {
  const first = await attach(), saved = readJson<any>(join(h.state.dir, "attachments/lead.json")), caller = await h.s.authorize(saved.token);
  for (const action of ["pause", "resume", "close", "recover", "reopen"]) await expect(h.s.handle(action, { key: "lead" }, caller)).rejects.toThrow("unsupported");
  await expect(h.s.handle("lead-detach", { threadId: otherId }, caller)).rejects.toThrow("mismatch");
  expect(await h.s.handle("lead-detach", { threadId }, caller)).toEqual({ detached: true, threadId });
  await expect(h.s.authorize(saved.token)).rejects.toThrow("Forbidden");
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "detached" });
  const second = await attach(); expect(second.bridge).not.toBe(first.bridge); expect(second.lead.runtime.generation).toBe(first.lead.runtime.generation + 1);
  await expect(h.s.handle("lead-detach", { threadId }, caller)).rejects.toThrow("Stale"); expect(h.thread.status.type).toBe("idle");
  expect(h.calls.some(a => ["start", "send-keys", "close", "stop"].includes(a[2] ?? ""))).toBe(false);
});

test("stale failed managed lead is archived without deleting mail, replaying prior intent, or accepting credentials", async () => {
  const old: any = { key: "lead", title: "failed", role: "lead", thread: "none", brief: "/old", done: "", pane: "old:p", openedAt: new Date().toISOString(), runtime: { kind: "codex", backend: "herdr-tui", state: "failed", hostInstanceId: "old", generation: 2, binaryVersion: "0.163.0", threadId: otherId } };
  await h.s.registry.write(old); atomicJson(join(h.state.dir, "hosts/lead.json"), { instance: "old", hostToken: "OLD_HOST", laneToken: "OLD_LEAD", role: "lead" });
  h.s.inbox.put({ id: "old-queued", target: "lead", text: "historical", state: "queued", at: "2020-01-01" });
  h.s.inbox.put({ id: "old-unknown", target: "lead", text: "unknown", state: "unknown", at: "2020-01-01" });
  h.s.operations.put({ id: "old-launch", target: "lead", text: JSON.stringify({ key: "lead", role: "lead", operationId: "old-launch" }), state: "queued", at: "2020-01-01" });
  const result = await attach(); await h.s.tick();
  expect(result.lead.runtimeHistory).toContainEqual(old.runtime); expect(result.lead.runtime.generation).toBe(3);
  expect(h.s.inbox.get("old-queued")?.state).toBe("queued"); expect(h.s.inbox.get("old-unknown")?.state).toBe("unknown"); expect(h.s.operations.get("old-launch")?.state).toBe("queued");
  const archives = [...new Bun.Glob("attachments/history/*/lane.json").scanSync(h.state.dir)]; expect(archives).toHaveLength(1);
  expect(readJson<any>(join(h.state.dir, archives[0]!)).runtime).toEqual(old.runtime); await expect(h.s.authorize("OLD_LEAD")).rejects.toThrow("Forbidden"); expect(queueCalls()).toHaveLength(0);
});

test("live prior managed host or TUI prevents archival before any state write", async () => {
  const old: any = { key: "lead", title: "live", role: "lead", thread: "none", brief: "", done: "", pane: "old:p", openedAt: new Date().toISOString(), runtime: { kind: "codex", state: "failed", hostInstanceId: "old", generation: 1, binaryVersion: "0.163.0" } };
  await h.s.registry.write(old); atomicJson(join(h.state.dir, "hosts/lead.pid.json"), { pid: process.pid });
  await expect(attach()).rejects.toThrow("host process still exists"); expect(existsSync(join(h.state.dir, "attachments/lead.json"))).toBe(false);
});

test("live historical TUI or backend cannot be silently replaced even when marked failed", async () => {
  const old: any = { key: "lead", title: "old", role: "lead", thread: "none", brief: "", done: "", pane: h.args.pane, openedAt: new Date().toISOString(), runtime: { kind: "codex", state: "failed", hostInstanceId: "old", generation: 1, binaryVersion: "0.163.0" } };
  await h.s.registry.write(old); await expect(attach()).rejects.toThrow("live TUI");
  await h.s.registry.update("lead", l => ({ ...l, pane: "old:p" }));
  const oldBackend = Bun.serve({ unix: backendSocket(h.state.dir, "lead"), fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) { const m = JSON.parse(String(raw)); if (m.id !== undefined) ws.send(JSON.stringify({ id: m.id, result: {} })); } } });
  try { await expect(attach()).rejects.toThrow("backend still live"); expect(existsSync(join(h.state.dir, "attachments/lead.json"))).toBe(false); }
  finally { oldBackend.stop(true); }
});

test("the internal managed-host entrypoints cannot boot an old lead credential", async () => {
  atomicJson(join(h.state.dir, "hosts/lead.json"), { key: "lead", role: "lead", config: h.config });
  expect(() => startSessionHost(h.state.dir, "lead")).toThrow("lead-attach");
  await expect(runSessionHost(h.state.dir, "lead")).rejects.toThrow("lead-attach");
  expect(h.calls).toHaveLength(0);
});

test("owner ingress arriving during the activation turn remains queued and reaches this same lead once idle", async () => {
  h.busy(); await attach(); const event = { id: "owner-message", user: "owner", thread: "chat:owner", text: "Continue the authorized task" };
  await h.s.receive("test", event); await h.s.tick(); expect(queueCalls()).toHaveLength(0);
  const id = "inbound:test:chat:owner:owner-message"; expect(h.s.inbox.get(id)).toMatchObject({ state: "queued", target: "lead" });
  h.idle(); // A fresh service represents the next inbox tick without wall-clock waiting.
  const restarted = new DoriService(h.config, h.run); await restarted.tick();
  expect(restarted.inbox.get(id)).toMatchObject({ state: "sent", turnId: "real-turn-id" }); expect(queueCalls()).toHaveLength(1);
  expect(queueCalls()[0]?.[5]).toBe(operationText("Owner message in chat:owner:\nContinue the authorized task", id));
});

test("queued input bound to an older generation is never sent to a newer attachment", async () => {
  await attach(); const old = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  await h.s.handle("lead-detach", { threadId }, { role: "admin" }); await attach();
  h.s.inbox.put({ id: "late-old-input", target: "lead", text: "stale request", state: "queued", at: new Date().toISOString(), attachmentInstance: old.instance });
  await h.s.tick(); expect(h.s.inbox.get("late-old-input")?.state).toBe("queued"); expect(queueCalls()).toHaveLength(0);
});

test("managed missing turn receipt stays unknown because validation runs inside mailbox callback", async () => {
  const key = "worker", instance = "host";
  await h.s.registry.write({ key, title: "worker", thread: "none", brief: "", done: "", openedAt: new Date().toISOString(), runtime: { kind: "codex", backend: "herdr-tui", threadId, state: "idle", hostInstanceId: instance, generation: 1, binaryVersion: "0.163.0" } });
  atomicJson(join(h.state.dir, `hosts/${key}.json`), { hostToken: "host" });
  const host = Bun.serve({ unix: hostSocket(h.state.dir, key), fetch() { return Response.json({ result: {} }); } });
  try { await expect(h.s.handle("input", { key, text: "task", operationId: "missing-receipt" }, { role: "admin" })).rejects.toThrow("Missing turn receipt"); expect(h.s.inbox.get("missing-receipt")?.state).toBe("unknown"); }
  finally { host.stop(true); }
});
