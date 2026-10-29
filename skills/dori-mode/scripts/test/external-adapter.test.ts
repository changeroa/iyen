import { expect, test } from "bun:test";
import { realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { DeliveryDeferred } from "../src/mailbox.ts";
import type { Runner } from "../src/run.ts";
import { discoverExternal, ExternalCurrentSession, observeExternal, sharedDaemon } from "../src/runtime/external-current-session.ts";
import { operationText } from "../src/runtime/herdr.ts";
import { readLoadedThreads, readTurns, receiptInTurns, type Observer, type ObserverMethod } from "../src/runtime/observer.ts";
import { RpcError } from "../src/runtime/protocol.ts";
import { withState } from "./fakes.ts";

const threadId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const config = { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 150 };
const ok = (value: unknown) => ({ code: 0, out: JSON.stringify(value), err: "" });
const turn = (id: string, text = "manual") => ({ id, status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text }] }] });
const observerFor = (read: (method: ObserverMethod, params: any) => any): Observer => ({ read: async (method, params) => read(method, params), close() {} });

function fixture() {
  const calls: string[][] = [], lost: unknown[] = [];
  const thread: any = { id: threadId, cwd: realpathSync(import.meta.dir), status: { type: "idle" }, model: "user-model", reasoningEffort: "high" };
  const agent: any = { agent: "codex", pane_id: "w:p1", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: threadId } };
  let turns: any[] = [], loaded: any = { data: [threadId], nextCursor: null }, goal: any = { goal: null };
  let failMethod: string | undefined, failCode = -32601, gets = 0, driftAt = Infinity;
  let onQueue = (_argv: readonly string[]) => {};
  const observer = observerFor(method => {
    if (method === failMethod) throw new RpcError("Bearer secret private response", failCode);
    if (method === "thread/read") return { thread };
    if (method === "thread/loaded/list") return loaded;
    if (method === "thread/turns/list") return { data: turns, nextCursor: null };
    if (method === "thread/goal/get") return goal;
    throw new Error("Unexpected observer method");
  });
  const run: Runner = async argv => {
    calls.push([...argv]);
    if (argv[0] === "herdr" && argv.slice(1, 3).join(" ") === "agent get") {
      if (++gets >= driftAt) agent.agent_session.value = otherId;
      return ok({ result: { agent } });
    }
    if (argv[1] === "queue") { onQueue(argv); return ok({}); }
    throw new Error("Unexpected command");
  };
  const clock = { at: 0, now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; } };
  const session = new ExternalCurrentSession(observer, run, config, { threadId, pane: agent.pane_id, cwd: thread.cwd }, process.execPath, clock);
  return { session, observer, thread, agent, calls, lost, onLoss: async (error: unknown) => { lost.push(error); },
    setTurns(value: any[]) { turns = value; }, setLoaded(value: any) { loaded = value; }, setGoal(value: any) { goal = value; },
    fail(method: string, code = -32601) { failMethod = method; failCode = code; },
    driftAt(get: number) { driftAt = get; }, onQueue(fn: typeof onQueue) { onQueue = fn; },
  };
}

test("future matching releases discover read-only queue capabilities independently of the managed pin", async () => {
  const calls: string[][] = [];
  const run: Runner = async argv => {
    calls.push([...argv]);
    return argv[1] === "queue" ? { code: 0, out: "Usage: queue --thread <ID> --message <TEXT>", err: "" } :
      ok({ status: "running", cliVersion: "0.999.42", appServerVersion: "0.999.42", socketPath: "/fixture/shared.sock" });
  };
  expect(await discoverExternal(run, { ...config, binary: "/missing/managed", externalBinary: process.execPath })).toEqual({
    binary: realpathSync(process.execPath), socketPath: "/fixture/shared.sock", binaryVersion: "0.999.42",
  });
  expect(calls.map(argv => argv.slice(1))).toEqual([["app-server", "daemon", "version"], ["queue", "--help"]]);
  expect(config.requiredVersion).toBe("0.163.0");
  expect(await fixture().session.inspect()).toMatchObject({ state: "idle", capabilities: { messaging: true, goal: true } });
});

test("discovery resolves the configured executable again after a symlink changes", async () => {
  const state = withState(), binary = join(state.dir, "codex");
  const run: Runner = async argv => argv[1] === "queue" ? { code: 0, out: "--thread=ID --message=TEXT", err: "" } :
    ok({ status: "running", cliVersion: "1.0.0", appServerVersion: "1.0.0", socketPath: "/fixture/shared.sock" });
  try {
    symlinkSync(process.execPath, binary);
    expect((await discoverExternal(run, { ...config, externalBinary: binary })).binary).toBe(realpathSync(process.execPath));
    unlinkSync(binary); symlinkSync("/bin/sh", binary);
    expect((await discoverExternal(run, { ...config, externalBinary: binary })).binary).toBe(realpathSync("/bin/sh"));
  } finally { state.done(); }
});

test("discovery rejects mismatched, malformed or unavailable daemon identity with sanitized errors", async () => {
  for (const [cliVersion, appServerVersion, code] of [
    ["0.164.0", "0.999.42", "runtime-version-changed"],
    ["Bearer secret /private/path", "Bearer secret /private/path", "runtime-incompatible"],
    [undefined, undefined, "runtime-incompatible"],
  ]) {
    const run: Runner = async () => ok({ status: "running", cliVersion, appServerVersion, socketPath: "/fixture/shared.sock" });
    const error = await sharedDaemon(run, process.execPath, config).catch(error => error);
    expect(error.code).toBe(code); expect(error.message).not.toMatch(/secret|private\/path/);
  }
  const failed: Runner = async () => { throw new Error("Bearer secret /private/path"); };
  await expect(discoverExternal(failed, config)).rejects.toMatchObject({ code: "runtime-unavailable" });
  await expect(discoverExternal(failed, { ...config, externalBinary: "/missing/private/path" })).rejects.toMatchObject({ code: "runtime-unavailable" });
});

test("missing required CLI flags, false flag prefixes and unsuccessful help are incompatible", async () => {
  for (const help of [
    { code: 0, out: "--thread <ID>", err: "Bearer secret" },
    { code: 0, out: "--thread-id <ID> --message-file <FILE>", err: "" },
    { code: 1, out: "--thread <ID> --message <TEXT>", err: "private error" },
  ]) {
    const run: Runner = async argv => argv[1] === "queue" ? help :
      ok({ status: "running", cliVersion: "0.999.42", appServerVersion: "0.999.42", socketPath: "/fixture/shared.sock" });
    const error = await discoverExternal(run, config).catch(error => error);
    expect(error.code).toBe("runtime-incompatible"); expect(error.message).not.toMatch(/secret|private error/);
  }
});

test("saved observation still requires the exact endpoint and observed version", async () => {
  const run: Runner = async () => ok({ status: "running", cliVersion: "0.999.42", appServerVersion: "0.999.42", socketPath: "/fixture/shared.sock" });
  let acted = false;
  const action = async () => { acted = true; };
  await expect(observeExternal(run, config, { binary: process.execPath, socketPath: "/other.sock", binaryVersion: "0.999.42" }, action)).rejects.toMatchObject({ code: "identity-unverified" });
  await expect(observeExternal(run, config, { binary: process.execPath, socketPath: "/fixture/shared.sock", binaryVersion: "0.163.0" }, action)).rejects.toMatchObject({ code: "runtime-version-changed" });
  expect(acted).toBe(false);
});

for (const method of ["thread/read", "thread/loaded/list", "thread/turns/list"]) test(`required ${method} capability fails before queue mutation`, async () => {
  const h = fixture(); h.fail(method);
  await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-incompatible" });
  await expect(h.session.input("task", "missing-api", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
  expect(h.lost[0]).toMatchObject({ code: "runtime-incompatible" }); expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
});

test("required read transport failures are sanitized without labeling them schema incompatibility", async () => {
  const h = fixture(); h.fail("thread/read", -32000);
  const error = await h.session.inspect().catch(error => error);
  expect(error.code).toBe("runtime-unavailable"); expect(error.message).not.toMatch(/secret|private/);
});

for (const corrupt of [
  (h: ReturnType<typeof fixture>) => { h.thread.status = { type: "newUnknownStatus" }; },
  (h: ReturnType<typeof fixture>) => { h.thread.status = { type: "active", activeFlags: "waitingOnApproval" }; },
  (h: ReturnType<typeof fixture>) => { h.thread.cwd = null; },
  (h: ReturnType<typeof fixture>) => { h.setLoaded({ data: [123], nextCursor: null }); },
  (h: ReturnType<typeof fixture>) => { h.setLoaded({ data: [threadId] }); },
  (h: ReturnType<typeof fixture>) => { h.setTurns([{ ...turn("bad"), status: "unknown" }]); },
  (h: ReturnType<typeof fixture>) => { h.setTurns([{ ...turn("bad"), itemsView: "summary" }]); },
  (h: ReturnType<typeof fixture>) => { h.setTurns([{ ...turn("bad"), items: [{ type: "userMessage", content: [{ type: "text", text: 7 }] }] }]); },
  (h: ReturnType<typeof fixture>) => { h.setTurns([{ ...turn("bad"), items: [{ type: "userMessage", content: [{ type: "futureText", value: "unrecognized receipt representation" }] }] }]); },
]) test("malformed routing and receipt fields fail before dispatch", async () => {
  const h = fixture(); corrupt(h);
  await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-incompatible" });
  await expect(h.session.input("task", "bad-schema", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
  expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
});

test("optional missing, failing or malformed goal data degrades capability while messaging works", async () => {
  for (const broken of ["missing", "failed", "malformed"]) {
    const h = fixture();
    if (broken === "missing") h.fail("thread/goal/get");
    else if (broken === "failed") h.fail("thread/goal/get", -32000);
    else h.setGoal({ goal: { status: "unknown", objective: "task", tokenBudget: 1 } });
    expect(await h.session.inspect()).toMatchObject({ state: "idle", goal: null, capabilities: { messaging: true, goal: false } });
    h.onQueue(argv => h.setTurns([turn("accepted", argv[5])]));
    expect(await h.session.input("task", `optional-${broken}`, h.onLoss)).toEqual({ turnId: "accepted" });
    expect(h.calls.filter(argv => argv[1] === "queue")).toHaveLength(1);
  }
});

test("additive response fields and unrelated future item kinds remain compatible", async () => {
  const h = fixture(); h.thread.futureField = { value: true };
  h.setTurns([{ ...turn("old"), futureField: "accepted", items: [{ type: "futureToolResult", payload: {} }] }]);
  expect(await h.session.inspect()).toMatchObject({ state: "idle", model: "user-model", effort: "high" });
});

for (const method of ["thread/loaded/list", "thread/turns/list"] as const) test(`${method} pagination cycles and excessive pages fail closed`, async () => {
  for (const loop of [true, false]) {
    let reads = 0;
    const observer = observerFor(() => ({ data: [], nextCursor: loop ? (++reads, "cycle") : String(++reads) }));
    await expect(method === "thread/loaded/list" ? readLoadedThreads(observer) : readTurns(observer, threadId)).rejects.toMatchObject({ code: "runtime-incompatible" });
    expect(reads).toBe(loop ? 2 : 100);
  }
});

test("pagination rejects missing cursor, excessive page size and duplicate turn identities", async () => {
  for (const page of [{ data: [] }, { data: Array(101).fill(threadId), nextCursor: null }]) {
    await expect(readLoadedThreads(observerFor(() => page))).rejects.toMatchObject({ code: "runtime-incompatible" });
  }
  let reads = 0;
  const duplicate = observerFor(() => ({ data: [turn("same-id")], nextCursor: ++reads === 1 ? "second" : null }));
  await expect(readTurns(duplicate, threadId)).rejects.toMatchObject({ code: "runtime-incompatible" });
});

test("valid multiple pages retain full exact receipt evidence", async () => {
  const marked = operationText("task", "second-page");
  const observer = observerFor((method, params) => {
    if (method === "thread/loaded/list") return params.cursor === null ? { data: [otherId], nextCursor: "loaded-next" } : { data: [threadId], nextCursor: null };
    expect(params.itemsView).toBe("full"); expect(params.sortDirection).toBe("desc");
    return params.cursor === null ? { data: [turn("recent")], nextCursor: "turn-next" } : { data: [turn("older", marked)], nextCursor: null };
  });
  expect(await readLoadedThreads(observer)).toEqual([otherId, threadId]);
  expect(receiptInTurns(await readTurns(observer, threadId), marked)).toBe("older");
});

test("Codex active turns and approval/input flags remain dispatch safety gates", async () => {
  for (const [flags, state] of [[[], "running"], [["waitingOnApproval"], "waiting_approval"], [["waitingOnUserInput"], "waiting_input"]] as const) {
    const h = fixture(); h.thread.status = { type: "active", activeFlags: flags }; h.setTurns([{ ...turn("active"), status: "inProgress" }]);
    expect(await h.session.inspect()).toMatchObject({ state, activeTurnId: "active" });
    await expect(h.session.input("task", "codex-active", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
  }
  const h = fixture(); h.setTurns([{ ...turn("active"), status: "inProgress" }]);
  expect(await h.session.inspect()).toMatchObject({ state: "running", activeTurnId: "active" });
  h.thread.status = { type: "systemError" };
  expect(await h.session.inspect()).toMatchObject({ state: "failed" });
});

test("Herdr working and blocked prevent idle dispatch despite idle Codex observer", async () => {
  for (const [herdr, state] of [["working", "running"], ["blocked", "waiting_input"]]) {
    const h = fixture(); h.agent.agent_status = herdr;
    expect(await h.session.inspect()).toMatchObject({ state, activeTurnId: undefined });
    await expect(h.session.input("task", "busy", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
  }
});

test("unrecognized Herdr statuses and unsafe loaded/turn identities never become idle", async () => {
  for (const status of [undefined, "unknown", "starting"]) {
    const h = fixture(); h.agent.agent_status = status;
    await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-unavailable" });
    await expect(h.session.input("task", "unknown-status", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
    h.agent.agent_status = "idle";
    expect(await h.session.inspect()).toMatchObject({ state: "idle" });
  }
  const h = fixture(); h.setLoaded({ data: [], nextCursor: null });
  await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-unavailable" });
  h.setLoaded({ data: [threadId], nextCursor: null }); h.thread.status = { type: "active", activeFlags: [] };
  await expect(h.session.inspect()).rejects.toThrow("active turn identity unknown");
  h.setTurns([{ ...turn("a"), status: "inProgress" }, { ...turn("b"), status: "inProgress" }]);
  await expect(h.session.inspect()).rejects.toThrow("Ambiguous");
});

test("missing cwd diagnostics never echo an untrusted path", async () => {
  const h = fixture(); h.thread.cwd = "/private/Bearer-secret/nonexistent";
  const error = await h.session.inspect().catch(error => error);
  expect(error.code).toBe("runtime-unavailable"); expect(error.message).not.toMatch(/secret|private/);
});

test("Herdr done dispatches only after exact loaded idle Codex identity and no active turn verify", async () => {
  const h = fixture(); h.agent.agent_status = "done";
  expect(await h.session.inspect()).toMatchObject({ state: "idle" });
  h.setTurns([{ ...turn("active"), status: "inProgress" }]);
  expect(await h.session.inspect()).toMatchObject({ state: "running", activeTurnId: "active" });
  await expect(h.session.input("task", "done-active", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
  expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
  h.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  expect(await h.session.inspect()).toMatchObject({ state: "waiting_approval" });
  h.thread.status = { type: "idle" }; h.setTurns([]);
  h.onQueue(argv => h.setTurns([turn("accepted", argv[5])]));
  expect(await h.session.input("task", "done-idle", h.onLoss)).toEqual({ turnId: "accepted" });
  h.agent.agent_status = "idle";
  expect(await h.session.inspect()).toMatchObject({ state: "idle" });
});

test("temporary Herdr get failures are retryable observation gaps with sanitized errors", async () => {
  for (const failure of ["nonzero", "throw", "malformed", "missing"]) {
    const h = fixture(); let unavailable = true;
    const run: Runner = async () => {
      if (!unavailable) return ok({ result: { agent: h.agent } });
      if (failure === "throw") throw new Error("Bearer secret /private/path");
      if (failure === "missing") return ok({ result: {} });
      return { code: failure === "nonzero" ? 1 : 0, out: "private malformed response", err: "Bearer secret" };
    };
    const session = new ExternalCurrentSession(h.observer, run, config, h.session.identity, process.execPath);
    const error = await session.inspect().catch(error => error);
    expect(error.code).toBe("runtime-unavailable"); expect(error.message).not.toMatch(/secret|private/);
    await expect(session.input("task", "get-gap", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    unavailable = false;
    expect(await session.inspect()).toMatchObject({ state: "idle" });
  }
});

test("missing Herdr session associations are retryable without dispatch and revalidate when restored", async () => {
  for (const association of [undefined, null, {}, { agent: "codex" }, { agent: "codex", kind: "id" }, { agent: "codex", kind: "id", value: "" }, { agent: "codex", kind: "unknown", value: threadId }]) {
    const h = fixture(), saved = h.agent.agent_session; h.agent.agent_session = association;
    await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-unavailable" });
    await expect(h.session.input("task", "association-gap", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
    h.agent.agent_session = saved;
    expect(await h.session.inspect()).toMatchObject({ state: "idle" });
  }
});

test("concrete pane, thread, agent and cwd mismatches remain identity-unverified", async () => {
  for (const corrupt of [
    (h: ReturnType<typeof fixture>) => { h.agent.pane_id = "other:pane"; },
    (h: ReturnType<typeof fixture>) => { h.agent.agent_session.value = otherId; },
    (h: ReturnType<typeof fixture>) => { h.agent.agent = "other-agent"; },
    (h: ReturnType<typeof fixture>) => { h.agent.agent_session.agent = "other-agent"; },
    (h: ReturnType<typeof fixture>) => { h.thread.id = otherId; },
    (h: ReturnType<typeof fixture>) => { h.thread.cwd = realpathSync("/"); },
  ]) {
    const h = fixture(); corrupt(h);
    await expect(h.session.inspect()).rejects.toMatchObject({ code: "identity-unverified" });
    await expect(h.session.input("task", "mismatch", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
  }
});

test("same saved thread unloaded during restart stays queued and revalidates without resume", async () => {
  for (const missingLoadedEntry of [true, false]) {
    const h = fixture(); h.agent.agent_status = "done";
    h.thread.status = { type: "notLoaded" };
    if (missingLoadedEntry) h.setLoaded({ data: [], nextCursor: null });
    await expect(h.session.inspect()).rejects.toMatchObject({ code: "runtime-unavailable" });
    await expect(h.session.input("task", "restart-gap", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(h.lost[0]).toMatchObject({ code: "runtime-unavailable" });
    expect(h.calls.every(argv => argv[0] === "herdr" && argv.slice(1, 3).join(" ") === "agent get")).toBe(true);
    h.thread.status = { type: "idle" }; h.setLoaded({ data: [threadId], nextCursor: null });
    expect(await h.session.inspect()).toMatchObject({ threadId, state: "idle" });
    h.onQueue(argv => h.setTurns([turn("accepted", argv[5])]));
    expect(await h.session.input("task", "restart-gap", h.onLoss)).toEqual({ turnId: "accepted" });
    expect(h.calls.filter(argv => argv[1] === "queue")).toHaveLength(1);
    expect(h.calls.some(argv => argv.includes("resume") || argv.includes("start") || argv.includes("restart"))).toBe(false);
  }
});

test("identity drift immediately before send prevents queue mutation", async () => {
  const h = fixture(); h.driftAt(2);
  await expect(h.session.input("task", "drift-before", h.onLoss)).rejects.toBeInstanceOf(DeliveryDeferred);
  expect(h.lost).toHaveLength(1); expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
});

test("identity drift after queue refuses even an exact receipt and never replays", async () => {
  const h = fixture(); h.onQueue(argv => { h.agent.agent_session.value = otherId; h.setTurns([turn("accepted", argv[5])]); });
  await expect(h.session.input("task", "drift-after", h.onLoss)).rejects.toThrow("delivery unknown");
  expect(h.lost).toHaveLength(1); expect(h.calls.filter(argv => argv[1] === "queue")).toHaveLength(1);
});

test("only exact user receipts acknowledge delivery; duplicates fail without replay", async () => {
  const marked = operationText("task", "exact");
  expect(receiptInTurns([{ ...turn("echo"), items: [{ type: "agentMessage", text: marked }] }] as any, marked)).toBeUndefined();
  expect(receiptInTurns([turn("partial", `${marked} extra`)] as any, marked)).toBeUndefined();
  expect(() => receiptInTurns([turn("a", marked), turn("b", marked)] as any, marked)).toThrow("Duplicate operation receipts");
  const h = fixture(); h.setTurns([turn("existing", marked)]);
  expect(await h.session.input("task", "exact", h.onLoss)).toEqual({ turnId: "existing" });
  expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
  h.setTurns([turn("a", marked), turn("b", marked)]);
  await expect(h.session.input("task", "exact", h.onLoss)).rejects.toThrow("Duplicate operation receipts");
  expect(h.calls.some(argv => argv[1] === "queue")).toBe(false);
});

test("uncertain queue outcomes are sanitized and one submission is never replayed during reconciliation", async () => {
  const h = fixture(); h.onQueue(() => { throw new Error("Bearer secret /private/command"); });
  const error = await h.session.input("task", "uncertain", h.onLoss).catch(error => error);
  expect(error.message).toContain("outcome unknown"); expect(error.message).not.toMatch(/secret|private/);
  expect(h.calls.filter(argv => argv[1] === "queue")).toHaveLength(1);
});
