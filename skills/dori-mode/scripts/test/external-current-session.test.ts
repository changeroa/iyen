import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { hostSocket, readJson, socketDir } from "../src/ipc.ts";
import { DoriService } from "../src/service.ts";
import { operationText } from "../src/runtime/herdr.ts";
import { backendSocket, prepareBackend, runSessionHost, startSessionHost } from "../src/runtime/session-host.ts";
import { sharedDaemon } from "../src/runtime/external-current-session.ts";
import { deadPaneTick } from "../src/dead-panes.ts";
import { withState } from "./fakes.ts";
import type { Runner } from "../src/run.ts";

const threadId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
let h: ReturnType<typeof fixture>;
function fixture() {
  const state = withState(), socketPath = join(socketDir(state.dir), "shared.sock"), calls: string[][] = [], reads: string[] = [];
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, hooks: { threadReply: ["notify", "{thread}", "{text}"] }, ingress: [{ id: "test", command: ["fixture"], owners: ["owner"] }], runtime: { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 80 } };
  const thread: any = { id: threadId, cwd: realpathSync(state.dir), model: "retained-model", reasoningEffort: "high", status: { type: "idle" } };
  let cliVersion = "0.163.0", serverVersion = "0.163.0", reportedSocket = socketPath, unavailable = false;
  let turns: any[] = [], loaded = true, accept = true, queueCode = 0, queueThrows = false, loseOnQueue = false, getCount = 0, driftAtGet = Infinity, failQueuedTurn = false;
  const agent: any = { agent: "codex", pane_id: "w:p1", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: threadId } };
  const server = Bun.serve({ unix: socketPath, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
    const m = JSON.parse(String(raw)); reads.push(m.method); if (m.id === undefined) return;
    const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread } : m.method === "thread/loaded/list" ? { data: loaded ? [threadId] : [], nextCursor: null } :
      m.method === "thread/goal/get" ? { goal: null } : m.method === "thread/turns/list" ? { data: turns, nextCursor: null } : undefined;
    if (result === undefined) ws.send(JSON.stringify({ id: m.id, error: { code: -1, message: "mutation refused" } })); else ws.send(JSON.stringify({ id: m.id, result }));
  } } });
  const run: Runner = async argv => {
    calls.push([...argv]); const ok = (result: unknown) => ({ code: 0, err: "", out: JSON.stringify(result) });
    if (argv[0] === "notify") return ok({});
    if (argv[0] === "herdr") {
      if (argv[1] === "agent" && argv[2] === "get") { if (++getCount >= driftAtGet) agent.agent_session.value = otherId; return ok({ result: { agent } }); }
      if (argv[1] === "agent" && argv[2] === "list") return ok({ result: { agents: [agent] } });
      if (argv[1] === "pane" && argv[2] === "list") return ok({ result: { panes: [agent] } });
    }
    if (argv.slice(1).join(" ") === "app-server daemon version") { if (unavailable) throw new Error("Bearer private-token /private/socket"); return ok({ status: "running", cliVersion, appServerVersion: serverVersion, socketPath: reportedSocket }); }
    if (argv[1] === "queue") {
      if (accept) turns.push({ id: "real-turn-id", status: failQueuedTurn ? "failed" : "completed", items: [{ type: "userMessage", content: [{ type: "text", text: argv[5] }] }],
        error: failQueuedTurn ? { codexErrorInfo: "unauthorized", message: "Authorization: Bearer secret-token\nprivate command dump" } : null });
      if (loseOnQueue) agent.agent_session.value = otherId;
      if (queueThrows) throw new Error("transport disconnect");
      return { code: queueCode, err: "", out: "submitted" };
    }
    throw new Error(`Unexpected mutation: ${argv.join(" ")}`);
  };
  const s = new DoriService(config, run), args = { threadId, pane: agent.pane_id, cwd: state.dir };
  return { state, s, args, config, run, calls, reads, thread, agent, server,
    versions(client: string, daemon = client) { cliVersion = client; serverVersion = daemon; },
    socket(value: string) { reportedSocket = value; }, unavailable() { unavailable = true; }, setTurns: (v: any[]) => turns = v, getTurns: () => turns, failQueuedTurn: () => failQueuedTurn = true,
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

test("attached failure observed before receipt ACK waits for sent input, then notifies the exact owner once", async () => {
  await attach(); const saved = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  const operationId = "early-failure", text = "owner task", turnId = "early-failed-turn";
  h.s.inbox.put({ id: operationId, target: "lead", thread: "slack:owner", text, state: "sending", attachmentInstance: saved.instance, at: new Date().toISOString() });
  h.setTurns([{ id: turnId, status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: operationText(text, operationId) }] }], error: { codexErrorInfo: "unauthorized", message: "Bearer secret-token\nprivate command dump" } }]);
  await h.s.deps.runtime.inspect("lead"); await h.s.notifyFailures();
  expect(h.s.failures.list()).toHaveLength(1); expect(h.s.failures.list()[0]).toMatchObject({ state: "queued", source: saved.instance, turnId }); expect(h.s.outbox.list()).toHaveLength(0);
  h.s.inbox.mark(operationId, { state: "sent", turnId });
  await Promise.all([h.s.notifyFailures(), h.s.notifyFailures()]);
  expect(h.s.outbox.list()).toHaveLength(1); expect(h.s.outbox.list()[0]).toMatchObject({ target: "slack:owner", state: "sent" }); expect(h.s.outbox.list()[0]?.text).toContain("Check Codex authentication");
  const restarted = new DoriService(h.config, h.run); await restarted.deps.runtime.inspect("lead"); await restarted.notifyFailures();
  expect(restarted.failures.list()).toHaveLength(1); expect(restarted.failures.list()[0]?.state).toBe("sent"); expect(h.calls.filter(a => a[0] === "notify")).toHaveLength(1); expect(queueCalls()).toHaveLength(0);
  expect(JSON.stringify({ failures: restarted.failures.list(), notices: restarted.outbox.list() })).not.toMatch(/secret-token|private command|Bearer/);
});

test("immediate failed attached input records durable failure while sending and preserves owner notices", async () => {
  await attach(); h.failQueuedTurn();
  const mark = h.s.inbox.mark.bind(h.s.inbox); let recordedBeforeAck = false;
  h.s.inbox.mark = (id, patch) => {
    if (id === "immediate-failure" && patch.state === "sent") { recordedBeforeAck = true; expect(h.s.failures.list()).toHaveLength(1); expect(h.s.outbox.list()).toHaveLength(0); }
    return mark(id, patch);
  };
  await h.s.handle("input", { key: "lead", text: "owner task", operationId: "immediate-failure", thread: "slack:immediate" }, { role: "admin" });
  expect(recordedBeforeAck).toBe(true); await h.s.notifyFailures(); expect(h.s.outbox.list()[0]).toMatchObject({ target: "slack:immediate", state: "sent" }); expect(queueCalls()).toHaveLength(1);
});

test("later terminal failure is observed by the regular sweep and deduplicates across restart", async () => {
  await attach(); await h.s.handle("input", { key: "lead", text: "owner task", operationId: "late-failure", thread: "slack:late" }, { role: "admin" });
  expect(h.s.failures.list()).toHaveLength(0); const turn = h.getTurns()[0]; turn.status = "failed"; turn.error = { codexErrorInfo: "usageLimitExceeded" };
  await h.s.tick(); await h.s.notifyFailures(); expect(h.s.failures.list()).toHaveLength(1); expect(h.s.outbox.list()[0]).toMatchObject({ target: "slack:late", state: "sent" }); expect(h.s.outbox.list()[0]?.text).toContain("limits or quota");
  const restarted = new DoriService(h.config, h.run); await restarted.tick(); await restarted.notifyFailures();
  expect(restarted.outbox.list()).toHaveLength(1); expect(h.calls.filter(a => a[0] === "notify")).toHaveLength(1); expect(queueCalls()).toHaveLength(1);
});

test("historical, manual, unattempted and previous-generation failed turns cannot notify this attachment", async () => {
  const historicText = operationText("history", "historic");
  h.s.inbox.put({ id: "historic", target: "lead", text: "history", thread: "slack:old", state: "sent", turnId: "old-turn", attachmentInstance: "old-generation", at: "2020-01-01" });
  h.setTurns([{ id: "old-turn", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: historicText }] }], error: { codexErrorInfo: "unauthorized" } }]);
  await attach(); const saved = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  h.s.inbox.put({ id: "queued", target: "lead", text: "unattempted", thread: "slack:queued", state: "queued", attachmentInstance: saved.instance, at: new Date().toISOString() });
  h.getTurns().push({ id: "manual-turn", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: "manual session input" }] }], error: { codexErrorInfo: "unauthorized" } },
    { id: "unattempted-turn", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: operationText("unattempted", "queued") }] }] });
  await h.s.deps.runtime.inspect("lead"); await h.s.notifyFailures(); expect(h.s.failures.list()).toHaveLength(0); expect(h.s.outbox.list()).toHaveLength(0);
});

test("a failure tied to unknown input remains pending without notice or input replay", async () => {
  await attach(); const saved = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  h.s.inbox.put({ id: "unknown-input", target: "lead", text: "uncertain", thread: "slack:unknown", state: "unknown", attachmentInstance: saved.instance, at: new Date().toISOString() });
  h.setTurns([{ id: "unknown-turn", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: operationText("uncertain", "unknown-input") }] }], error: { codexErrorInfo: "unauthorized" } }]);
  const restarted = new DoriService(h.config, h.run); await restarted.tick(); await restarted.notifyFailures();
  expect(restarted.failures.list()).toHaveLength(1); expect(restarted.failures.list()[0]?.state).toBe("queued"); expect(restarted.outbox.list()).toHaveLength(0); expect(restarted.inbox.get("unknown-input")?.state).toBe("unknown"); expect(queueCalls()).toHaveLength(0);
});


test("external support is an explicit pair table independent of the managed version pin", async () => {
  const pin = h.config.runtime.requiredVersion;
  for (const version of ["0.163.0", "0.164.0", "0.165.0"]) {
    h.versions(version);
    expect(await sharedDaemon(h.run, process.execPath, h.config.runtime)).toEqual({ socketPath: join(socketDir(h.state.dir), "shared.sock"), binaryVersion: version });
  }
  for (const [client, server, code] of [["0.163.0", "0.164.0", "runtime-version-changed"], ["0.164.0", "0.163.0", "runtime-version-changed"], ["0.166.0", "0.166.0", "runtime-version-unsupported"], ["0.164.1", "0.164.1", "runtime-version-unsupported"]]) {
    h.versions(client!, server);
    await expect(sharedDaemon(h.run, process.execPath, h.config.runtime)).rejects.toMatchObject({ code });
    await expect(attach()).rejects.toThrow(/version/);
  }
  expect(h.config.runtime.requiredVersion).toBe(pin); expect(pin).toBe("0.163.0");
  expect(await h.s.registry.read("lead")).toBeNull(); expect(existsSync(join(h.state.dir, "attachments/lead.json"))).toBe(false);
});

for (const upgradeVersion of ["0.164.0", "0.165.0"]) test(`same-session 163 to ${upgradeVersion} reattach preserves accepted mail, capability and historical exclusions`, async () => {
  h.s.inbox.put({ id: "history", target: "lead", text: "old", state: "queued", at: "2020-01-01" });
  h.busy(); await attach();
  const path = join(h.state.dir, "attachments/lead.json"), saved = readJson<any>(path);
  // Represent the resolved release executable changing without a live daemon.
  saved.binary = "/fixture/codex-163"; atomicJson(path, saved);
  await h.s.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, external: { ...l.runtime!.external!, binary: saved.binary } } }));
  const event = { id: "accepted", user: "owner", thread: "chat:owner", text: "continue" };
  await h.s.receive("test", event);
  const id = "inbound:test:chat:owner:accepted", queued = { ...h.s.inbox.get(id)! };
  for (const state of ["unknown", "sending", "queued"] as const) h.s.inbox.put({ id: state, target: "lead", text: state, state, at: "2020-01-02", attachmentInstance: state === "queued" ? "previous-instance" : saved.instance });
  const before = structuredClone(h.s.inbox.list());
  h.versions("0.163.0", upgradeVersion);
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "held", runtime: { external: { holdReason: { code: "runtime-version-changed", message: expect.stringContaining(`client 0.163.0, server ${upgradeVersion}`) } } } });
  const fault = (await h.s.registry.read("lead"))!.runtime!.external!.holdReason;
  // Later generic identity faults must preserve the initial version diagnosis.
  h.versions("0.163.0"); h.agent.agent_session.value = otherId;
  await h.s.deps.runtime.inspect("lead").catch(() => {});
  expect((await h.s.registry.read("lead"))!.runtime!.external!.holdReason).toEqual(fault);
  h.agent.agent_session.value = threadId; h.versions(upgradeVersion);
  const rebound = await attach(), actual = readJson<any>(path);
  expect(rebound).toMatchObject({ reused: true, bridge: saved.bridge, lead: { readiness: "busy", runtime: { binaryVersion: upgradeVersion, held: false } } });
  for (const key of ["instance", "generation", "token", "bridge", "excludedInboxIds", "socketPath", "threadId", "pane", "cwd"]) expect(actual[key]).toEqual(saved[key]);
  expect(actual.binary).toBe(realpathSync(process.execPath)); expect(actual.binaryVersion).toBe(upgradeVersion);
  expect(rebound.lead.runtime.external.holdReason).toBeUndefined(); expect(rebound.lead.runtime.external.rebind).toBeUndefined();
  expect(await h.s.authorize(saved.token)).toMatchObject({ instance: saved.instance });
  expect(h.s.inbox.list()).toEqual(before); expect(h.s.inbox.get(id)).toEqual(queued);
  await h.s.tick(); expect(queueCalls()).toHaveLength(0); expect(h.s.inbox.get("sending")?.state).toBe("sending");
  h.idle(); const restarted = new DoriService(h.config, h.run); await restarted.tick();
  expect(restarted.inbox.get(id)).toMatchObject({ ...queued, attachmentInstance: saved.instance, state: "sent", turnId: "real-turn-id" });
  expect(queueCalls()).toHaveLength(1);
  expect(restarted.inbox.get("history")?.state).toBe("queued"); expect(restarted.inbox.get("queued")?.state).toBe("queued"); expect(restarted.inbox.get("unknown")?.state).toBe("unknown");
  // Existing sending recovery remains unknown; reattach never resets it.
  expect(restarted.inbox.get("sending")?.state).toBe("unknown");
  const twice = new DoriService(h.config, h.run); await twice.tick(); expect(queueCalls()).toHaveLength(1);
  expect(h.config.runtime.requiredVersion).toBe("0.163.0");
});

test("changed socket, pane, cwd or thread cannot rebind an attached lead", async () => {
  await attach(); const path = join(h.state.dir, "attachments/lead.json"), before = readJson<any>(path);
  for (const args of [{ ...h.args, threadId: otherId }, { ...h.args, pane: "other:pane" }, { ...h.args, cwd: realpathSync("/tmp") }])
    await expect(h.s.handle("lead-attach", args, { role: "admin" })).rejects.toThrow("different lead");
  h.versions("0.164.0"); h.socket("/fixture/other.sock");
  await expect(attach()).rejects.toThrow("affinity changed"); expect(readJson<any>(path)).toEqual(before);
  expect(await h.s.authorize(before.token)).toMatchObject({ instance: before.instance });
  expect(await h.s.registry.read("lead")).toMatchObject({ dispatchBlocked: true }); expect(queueCalls()).toHaveLength(0);
});

test("restart revalidates saved observed version and never auto-rebinds a held attachment", async () => {
  await attach(); h.versions("0.164.0");
  const restarted = new DoriService(h.config, h.run); await restarted.tick();
  expect(await restarted.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "held", runtime: { binaryVersion: "0.163.0", external: { holdReason: { code: "runtime-version-changed" } } } });
  await restarted.handle("lead-attach", h.args, { role: "admin" });
  expect(await restarted.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "ready", runtime: { binaryVersion: "0.164.0" } });
  expect(queueCalls()).toHaveLength(0);
});

test("held, detached, missing and unavailable lead ACKs promise saved intake and waiting reconnection", async () => {
  const receive = (id: string) => h.s.receive("test", { id, user: "owner", thread: "chat:owner", text: "continue" });
  const ack = (id: string) => h.s.outbox.get(`ack:inbound:test:chat:owner:${id}`)?.text;
  await receive("missing"); expect(ack("missing")).toBe("Received and saved. Delivery is waiting for the lead to reconnect.");
  await attach(); await receive("active"); expect(ack("active")).toBeUndefined();
  h.versions("0.163.0", "0.164.0"); await receive("held"); expect(ack("held")).toBe(ack("missing"));
  const status = await h.s.handle("status", { key: "lead" }, { role: "admin" });
  expect(status.runtime.external.holdReason).toMatchObject({ code: "runtime-version-changed", at: expect.any(String) });
  await h.s.handle("lead-detach", { threadId }, { role: "admin" }); await receive("detached"); expect(ack("detached")).toBe(ack("missing"));
  h.versions("0.164.0"); await attach(); h.unavailable(); await receive("unavailable"); expect(ack("unavailable")).toBe(ack("missing"));
  expect(h.s.inbox.get("inbound:test:chat:owner:unavailable")?.state).toBe("queued");
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "held", runtime: { external: { holdReason: { code: "runtime-unavailable" } } } });
  expect(JSON.stringify(h.s.outbox.list())).not.toMatch(/private-token|private\/socket|Bearer/); expect(queueCalls()).toHaveLength(0);
});


test("external binary selects the borrowed client without changing managed binary/version", async () => {
  h.versions("0.164.0");
  const config = { ...h.config, runtime: { ...h.config.runtime, binary: "/managed/codex-163", externalBinary: process.execPath } };
  const service = new DoriService(config, h.run);
  const first = await service.handle("lead-attach", h.args, { role: "admin" });
  expect(first.lead.runtime.binaryVersion).toBe("0.164.0");
  expect(first.lead.runtime.external.binary).toBe(realpathSync(process.execPath));
  expect(h.calls.filter(a => a[1] === "app-server").every(a => a[0] === realpathSync(process.execPath))).toBe(true);
  expect(config.runtime.binary).toBe("/managed/codex-163"); expect(config.runtime.requiredVersion).toBe("0.163.0");
  // Actual managed preparation still chooses binary, even with externalBinary set.
  const managed = { ...config, runtime: { ...config.runtime, binary: process.execPath, externalBinary: "/unavailable/external", roles: { ...config.runtime.roles, lane: { model: "test", effort: "high" } } } };
  mkdirSync(join(h.state.dir, "clients/worker"), { recursive: true });
  expect(prepareBackend(h.state.dir, { key: "worker", role: "lane", instance: "host", generation: 1, hostToken: "host", laneToken: "lane", cwd: h.state.dir, pane: "worker:p", blocked: false, config: managed }).binary).toBe(realpathSync(process.execPath));
});

test("old in-flight observation settles before rebind and cannot re-hold the continuing instance", async () => {
  await attach(); h.versions("0.163.0", "0.164.0");
  let release!: () => void, started!: () => void;
  const paused = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => started = resolve);
  let delay = true;
  const run: Runner = async (argv, options) => {
    if (delay && argv[1] === "app-server") { delay = false; const old = await h.run(argv, options); started(); await paused; return old; }
    return h.run(argv, options);
  };
  const service = new DoriService(h.config, run);
  const observation = service.handle("status", { key: "lead" }, { role: "admin" });
  await entered; h.versions("0.164.0");
  const rebinding = service.handle("lead-attach", h.args, { role: "admin" });
  // The candidate inspect cannot pass the serialized old observation.
  await Promise.resolve(); expect((await service.registry.read("lead"))!.runtime!.binaryVersion).toBe("0.163.0");
  release(); expect(await observation).toMatchObject({ readiness: "held" });
  expect(await rebinding).toMatchObject({ reused: true, lead: { readiness: "ready", runtime: { binaryVersion: "0.164.0" } } });
  expect((await service.registry.read("lead"))!.runtime!.external!.holdReason).toBeUndefined();
  await service.tick(); expect((await service.registry.read("lead"))!.dispatchBlocked).toBe(false); expect(queueCalls()).toHaveLength(0);
});

for (const boundary of ["intent", "attachment"] as const) test(`interrupted rebind after ${boundary} is held, keeps capability and repairs on explicit retry`, async () => {
  h.s.inbox.put({ id: "historic-rebind", target: "lead", text: "history", state: "queued", at: "2020-01-01" });
  h.busy(); await attach();
  const path = join(h.state.dir, "attachments/lead.json"), saved = readJson<any>(path);
  await input("eligible-rebind"); const before = structuredClone(h.s.inbox.list());
  h.versions("0.164.0");
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => {
    const result = await update(key, lane => {
      const next = fn(lane);
      if (armed && boundary === "attachment" && lane.runtime?.external?.rebind && !next.runtime?.external?.rebind) { armed = false; throw new Error("injected commit failure after attachment"); }
      return next;
    });
    if (armed && boundary === "intent" && result.runtime?.external?.rebind) { armed = false; throw new Error("injected failure after intent"); }
    return result;
  };
  await expect(attach()).rejects.toThrow("injected");
  expect(await h.s.authorize(saved.token)).toMatchObject({ instance: saved.instance });
  expect(h.s.inbox.list()).toEqual(before); expect(queueCalls()).toHaveLength(0);
  const restarted = new DoriService(h.config, h.run); await restarted.tick();
  expect(await restarted.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "held", runtime: { external: { holdReason: { code: "rebind-interrupted" } } } });
  expect(await restarted.authorize(saved.token)).toMatchObject({ instance: saved.instance });
  expect(queueCalls()).toHaveLength(0);
  const rebound = await restarted.handle("lead-attach", h.args, { role: "admin" });
  expect(rebound).toMatchObject({ reused: true, bridge: saved.bridge, lead: { readiness: "busy", runtime: { binaryVersion: "0.164.0" } } });
  const actual = readJson<any>(path);
  for (const key of ["instance", "generation", "token", "bridge", "excludedInboxIds"]) expect(actual[key]).toEqual(saved[key]);
  expect(restarted.inbox.list()).toEqual(before); expect(queueCalls()).toHaveLength(0);
  h.idle(); const ready = new DoriService(h.config, h.run); await ready.tick();
  expect(ready.inbox.get("eligible-rebind")).toMatchObject({ state: "sent", turnId: "real-turn-id" });
  expect(ready.inbox.get("historic-rebind")?.state).toBe("queued"); expect(queueCalls()).toHaveLength(1);
});


test("candidate rebind requires every identity read to succeed before changing persistent binding", async () => {
  await attach(); const path = join(h.state.dir, "attachments/lead.json"), saved = readJson<any>(path);
  h.versions("0.164.0");
  h.thread.cwd = "/"; await expect(attach()).rejects.toThrow("identity mismatch"); h.thread.cwd = saved.cwd;
  h.thread.status = { type: "systemError" }; await expect(attach()).rejects.toThrow("runtime failure");
  h.thread.status = { type: "active", activeFlags: [] }; h.setTurns([{ id: "a", status: "inProgress", items: [] }, { id: "b", status: "inProgress", items: [] }]);
  await expect(attach()).rejects.toThrow("Ambiguous");
  h.unloaded(); await expect(attach()).rejects.toThrow("identity mismatch");
  expect(readJson<any>(path)).toEqual(saved); expect(await h.s.authorize(saved.token)).toMatchObject({ instance: saved.instance });
  expect((await h.s.registry.read("lead"))!.runtime!.binaryVersion).toBe("0.163.0"); expect(queueCalls()).toHaveLength(0);
});

test("untrusted version output and observer connection failure leave sanitized holds and saved ACKs", async () => {
  await attach(); h.versions("Bearer private-token /private/socket");
  const unsupported = await h.s.handle("status", { key: "lead" }, { role: "admin" });
  expect(unsupported.runtime.external.holdReason).toMatchObject({ code: "runtime-version-unsupported", message: expect.stringContaining("unrecognized") });
  expect(JSON.stringify(unsupported.runtime.external.holdReason)).not.toMatch(/private-token|private\/socket|Bearer/);
  h.versions("0.163.0"); await attach(); h.server.stop(true);
  await h.s.receive("test", { id: "offline", user: "owner", thread: "chat:owner", text: "save while unavailable" });
  expect(h.s.inbox.get("inbound:test:chat:owner:offline")?.state).toBe("queued");
  expect(h.s.outbox.get("ack:inbound:test:chat:owner:offline")?.text).toContain("Delivery is waiting");
  expect(await h.s.handle("status", { key: "lead" }, { role: "admin" })).toMatchObject({ readiness: "held", runtime: { external: { holdReason: { code: "runtime-unavailable" } } } });
  expect(queueCalls()).toHaveLength(0);
});
