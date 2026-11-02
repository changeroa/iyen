import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { OmpError, parseRequest, payloadHash, type OmpGoal } from "../src/runtime/omp/contract.ts";
import { OmpControlServer, hasAsyncWork, type OmpContext, type OmpExecutionHoldState } from "../src/runtime/omp/server.ts";
import { ompFixture } from "./fixtures/omp.ts";

function harness(options: { borrowed?: boolean; nativeHold?: boolean; busy?: boolean; receipt?: boolean; timeout?: number } = {}) {
  const f = ompFixture(); if (options.borrowed) { f.target.role = "attached-lead"; f.identity.role = "attached-lead"; }
  let idle = !options.busy, leaf: string | null = null, goal: OmpGoal = null, pending = false, async: unknown = null;
  let core: OmpExecutionHoldState = { sessionId: f.identity.sessionId, generation: 0, status: "open" };
  let sends = 0, aborts = 0, shut = 0; const entries: unknown[] = []; f.transcript(entries);
  const calls: string[] = [];
  const ctx: OmpContext = {
    mode: "tui", agent: { kind: "main" }, cwd: f.directory, model: { id: "test", provider: "fixture" },
    sessionManager: { getSessionId: () => f.identity.sessionId, getSessionFile: () => f.identity.sessionFile, getLeafId: () => leaf, ensureOnDisk: async () => {} },
    isIdle: () => idle, hasPendingMessages: () => pending, getAsyncJobSnapshot: () => async, getPendingPlanReview: () => undefined,
    abort: () => { aborts++; idle = true; }, shutdown: () => { shut++; },
    sessionModes: { getState: () => ({ goal: goal ? { ...goal, tokenBudget: goal.tokenBudget ?? undefined } : { status: "inactive" }, loop: { status: "inactive" } }), set: async request => {
      calls.push(`goal:${request.action}`); if (goal) goal = { ...goal, status: request.action === "pause" ? "paused" : "active" }; return { ok: true, state: {} };
    } },
    executionHold: options.nativeHold === false ? undefined : {
      getState: () => core,
      hold: async () => { calls.push("core:hold"); if (core.status === "open") core = { ...core, generation: core.generation + 1, status: "holding" }; idle = true; core = { ...core, status: "held" }; return core; },
      release: async expected => { calls.push("core:release"); expect(expected).toEqual({ sessionId: core.sessionId, generation: core.generation }); core = { ...core, status: "open" }; return core; },
    },
  };
  const server = new OmpControlServer(f.target, "fixture-bearer", join(f.directory, "journal"), () => ctx,
    { getThinkingLevel: () => "medium", sendUserMessage: text => { sends++; if (options.receipt !== false) { const id = `entry${sends}`; entries.push({ type: "message", id, parentId: leaf, message: { role: "user", content: [{ type: "text", text }] } }); leaf = id; f.transcript(entries); } } }, { timeoutMs: options.timeout ?? 100 });
  const dispatch = (method: string, params: Record<string, unknown> = {}) => server.dispatch(parseRequest({ protocol: 1, id: "rpc", token: "fixture-bearer", target: f.identity, method, params }));
  return { ...f, ctx, server, dispatch, calls, sends: () => sends, aborts: () => aborts, shutdowns: () => shut,
    setIdle: (value: boolean) => { idle = value; }, setGoal: (value: OmpGoal) => { goal = value; }, setPending: (value: boolean) => { pending = value; }, setAsync: (value: unknown) => { async = value; },
    setCore: (value: OmpExecutionHoldState) => { core = value; },
    cleanup: () => { server.close(); f.cleanup(); },
  };
}
test("actual OMP target constructs server and proves durable input once across duplicate calls", async () => {
  const h = harness();
  try {
    await h.server.listen(); const client = await connectOmp(h.target);
    try {
      expect((await client.inspect()).capabilities.durableReceipts).toBe(true);
      const [a, b] = await Promise.all([client.input("task", "op"), client.input("task", "op")]);
      expect(a).toEqual(b); expect(a.receipt.entryId).toBe("entry1"); expect(h.sends()).toBe(1);
      expect((await client.operation("op", "task")).status).toBe("received");
      await expect(client.input("changed", "op")).rejects.toThrow("operation-conflict");
    } finally { client.close(); }
  } finally { h.cleanup(); }
});
test("native hold remains responsive while input waits for receipt and never default-aborts goal", async () => {
  const h = harness({ receipt: false, timeout: 100 }); h.setGoal({ status: "active", objective: "task", tokenBudget: 100 });
  try {
    const input = h.dispatch("input", { operationId: "op", text: "task", payloadHash: payloadHash("task") }).catch(error => error);
    await Bun.sleep(5);
    const held: any = await h.dispatch("hold", { operationId: "hold", origin: "user" });
    expect(held.held).toBe(true); expect(held.goal.status).toBe("paused"); expect(h.aborts()).toBe(0);
    expect(h.calls.slice(0, 2)).toEqual(["core:hold", "goal:pause"]); expect(h.sends()).toBe(1);
    await expect(h.dispatch("release", { operationId: "release-auto", origin: "automatic" })).rejects.toThrow("owner hold");
    await h.dispatch("release", { operationId: "release", origin: "user" });
    expect(h.calls.slice(-2)).toEqual(["goal:resume", "core:release"]);
    expect((await input as OmpError).code).toBe("receipt-unknown");
  } finally { h.cleanup(); }
});
test("old native SDK cannot enable managed controls or input from idle alone", async () => {
  const h = harness({ nativeHold: false });
  try {
    const snapshot = h.server.snapshot(); expect(snapshot.capabilities.input).toBe(false); expect(snapshot.capabilities.hold).toBe(false);
    await expect(h.dispatch("hold", { operationId: "hold", origin: "user" })).rejects.toThrow("barrier unavailable");
    await expect(h.dispatch("input", { operationId: "op", text: "task", payloadHash: payloadHash("task") })).rejects.toThrow("blocked before submission"); expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});
test("borrowed busy late attachment recovers only after observed safe settle and refuses process controls", async () => {
  const h = harness({ borrowed: true, busy: true, nativeHold: false });
  try {
    expect(h.server.snapshot().state).toBe("recovering");
    h.server.observe({ type: "agent_end", willContinue: true }); h.setIdle(true); expect(h.server.snapshot().state).toBe("recovering");
    h.server.observe({ type: "agent_end" }); expect(h.server.snapshot().state).toBe("idle");
    expect(h.server.snapshot().capabilities.input).toBe(true);
    for (const method of ["hold", "release", "stop"]) await expect(h.dispatch(method, method === "stop" ? { operationId: method } : { operationId: method, origin: "user" })).rejects.toThrow("Borrowed OMP lead");
    expect(h.shutdowns()).toBe(0); expect(h.aborts()).toBe(0);
  } finally { h.cleanup(); }
});
test("native held parks pending delivery while live async execution prevents hold confirmation", async () => {
  const h = harness({ timeout: 30 });
  try {
    const empty = { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } };
    expect(hasAsyncWork(empty)).toBe(false); expect(hasAsyncWork({})).toBe(true);
    h.setAsync(empty); expect(h.server.snapshot().state).toBe("idle");
    h.setPending(true); expect(h.server.snapshot().state).toBe("running");
    h.setAsync({ ...empty, delivery: { ...empty.delivery, queued: 1, pendingJobIds: ["parked"], nextRetryAt: Date.now() } });
    expect((await h.dispatch("hold", { operationId: "hold", origin: "automatic" }) as any).held).toBe(true);
    expect(h.server.snapshot().state).toBe("idle");
    await h.dispatch("release", { operationId: "release", origin: "automatic" }); expect(h.server.snapshot().state).toBe("idle"); expect(h.sends()).toBe(0);
    h.setAsync({ ...empty, running: [{ id: "live" }] });
    await expect(h.dispatch("hold", { operationId: "hold2", origin: "automatic" })).rejects.toThrow("hold unconfirmed");
  } finally { h.cleanup(); }
});
test("owner-paused goal is preserved and a changed owned goal prevents release", async () => {
  const h = harness();
  try {
    h.setGoal({ status: "paused", objective: "owner", tokenBudget: null });
    await h.dispatch("hold", { operationId: "hold1", origin: "user" }); await h.dispatch("release", { operationId: "release1", origin: "user" });
    expect(h.calls).not.toContain("goal:resume");
    h.setGoal({ status: "active", objective: "task", tokenBudget: 100 });
    await h.dispatch("hold", { operationId: "hold2", origin: "user" }); h.setGoal({ status: "paused", objective: "changed", tokenBudget: 100 });
    await expect(h.dispatch("release", { operationId: "release2", origin: "user" })).rejects.toThrow("goal changed"); expect(h.server.snapshot().held).toBe(true);
  } finally { h.cleanup(); }
});
test("closing controller invalidates pending input without resending", async () => {
  const h = harness({ receipt: false });
  try {
    const pending = h.dispatch("input", { operationId: "op", text: "task", payloadHash: payloadHash("task") });
    await Bun.sleep(5); h.server.close(); await expect(pending).rejects.toThrow("epoch ended"); expect(h.sends()).toBe(1);
  } finally { h.cleanup(); }
});
test("native holding remains pausing and rejects admission until exact core generation settles", async () => {
  const h = harness(); let finish!: (value: OmpExecutionHoldState) => void;
  const holding: OmpExecutionHoldState = { sessionId: h.identity.sessionId, generation: 17, status: "holding" };
  h.ctx.executionHold!.hold = () => { h.setCore(holding); return new Promise(resolve => { finish = resolve; }); };
  try {
    const held = h.dispatch("hold", { operationId: "hold", origin: "user" }); await Bun.sleep(5);
    expect(h.server.snapshot().state).toBe("pausing"); expect(h.server.snapshot().held).toBe(true);
    await expect(h.dispatch("input", { operationId: "op", text: "work", payloadHash: payloadHash("work") })).rejects.toThrow("blocked before submission"); expect(h.sends()).toBe(0);
    const final = { ...holding, status: "held" as const }; h.setCore(final); finish(final); await held;
    h.setCore({ ...final, generation: 18 }); await expect(h.dispatch("release", { operationId: "release", origin: "user" })).rejects.toThrow("exact execution hold");
    expect(h.server.snapshot().held).toBe(true);
  } finally { h.cleanup(); }
});
test("strict wire parser and dispatch refuse changed terminal/session and extra mutation fields", async () => {
  const h = harness();
  try {
    const request = parseRequest({ protocol: 1, id: "request", token: "fixture-bearer", target: { ...h.identity, terminalId: "reused" }, method: "inspect", params: {} });
    await expect(h.server.dispatch(request)).rejects.toThrow("identity mismatch");
    expect(() => parseRequest({ protocol: 1, id: "request", token: "fixture-bearer", target: h.identity, method: "input", params: { operationId: "op", text: "work", payloadHash: payloadHash("work"), force: true } })).toThrow("Invalid OMP parameters");
  } finally { h.cleanup(); }
});
