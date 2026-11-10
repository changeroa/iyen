import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { OmpError, parseRequest, payloadHash, type OmpGoal } from "../src/runtime/omp/contract.ts";
import { OmpControlServer, hasAsyncWork, type OmpContext, type OmpExecutionHoldState } from "../src/runtime/omp/server.ts";
import { ompFixture } from "./fixtures/omp.ts";

function harness(options: { borrowed?: boolean; nativeHold?: boolean; busy?: boolean; receipt?: boolean; timeout?: number; onShutdown?: () => void } = {}) {
  const f = ompFixture(); if (options.borrowed) { f.target.role = "attached-lead"; f.identity.role = "attached-lead"; }
  let idle = !options.busy, leaf: string | null = null, goal: OmpGoal = null, pending = false, async: unknown = null;
  let core: OmpExecutionHoldState = { sessionId: f.identity.sessionId, generation: 0, status: "open" };
  const submitted = Promise.withResolvers<void>();
  let sends = 0, aborts = 0, shut = 0; const entries: unknown[] = []; f.transcript(entries);
  const calls: string[] = [];
  const ctx: OmpContext = {
    mode: "tui", agent: { kind: "main" }, cwd: f.directory, model: { id: "test", provider: "fixture" },
    sessionManager: { getSessionId: () => f.identity.sessionId, getSessionFile: () => f.identity.sessionFile, getLeafId: () => leaf, ensureOnDisk: async () => {} },
    isIdle: () => idle, hasPendingMessages: () => pending, getAsyncJobSnapshot: () => async, getPendingPlanReview: () => undefined,
    abort: () => { aborts++; idle = true; }, shutdown: () => { shut++; options.onShutdown?.(); },
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
    { getThinkingLevel: () => "medium", sendUserMessage: text => { sends++; submitted.resolve(); if (options.receipt !== false) { const id = `entry${sends}`; entries.push({ type: "message", id, parentId: leaf, message: { role: "user", content: [{ type: "text", text }] } }); leaf = id; f.transcript(entries); } } }, { timeoutMs: options.timeout ?? 100 });
  const dispatch = (method: string, params: Record<string, unknown> = {}) => server.dispatch(parseRequest({ protocol: 1, id: "rpc", token: "fixture-bearer", target: f.identity, method, params }));
  return { ...f, ctx, server, dispatch, calls, submitted: submitted.promise, sends: () => sends, aborts: () => aborts, shutdowns: () => shut,
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
test("closing controller invalidates pending input without resending", async () => {
  const h = harness({ receipt: false });
  try {
    const pending = h.dispatch("input", { operationId: "op", text: "task", payloadHash: payloadHash("task") });
    await h.submitted; h.server.close(); await expect(pending).rejects.toThrow("epoch ended"); expect(h.sends()).toBe(1);
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
test("terminal native assistant error is failed and input-fenced without invalidating its accepted receipt", async () => {
  const h = harness(); const failure = { role: "assistant", stopReason: "error", timestamp: 20, errorMessage: "provider failed" };
  try {
    const accepted: any = await h.dispatch("input", { operationId: "accepted", text: "task", payloadHash: payloadHash("task") });
    h.server.observe({ type: "agent_start" });
    h.server.observe({ type: "turn_end", message: failure, toolResults: [] }); expect(h.server.snapshot().state).toBe("recovering");
    // Native recovery can prune the terminal error from active messages.
    h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", timestamp: 10 }] });
    expect(h.server.snapshot().state).toBe("failed"); expect(h.server.snapshot().capabilities.input).toBe(false);
    expect(await h.dispatch("operation", { operationId: "accepted", payloadHash: payloadHash("task") })).toEqual({ status: "received", receipt: accepted.receipt });
    await expect(h.dispatch("input", { operationId: "next", text: "next", payloadHash: payloadHash("next") })).rejects.toThrow("blocked before submission");
    h.server.observe({ type: "agent_start" }); expect(h.server.snapshot().state).not.toBe("failed");
  } finally { h.cleanup(); }
});
test("retry continuation is recovering until successful final assistant and exhausted retry is failed", () => {
  const h = harness(); const failure = { role: "assistant", stopReason: "error", timestamp: 20 };
  try {
    h.server.observe({ type: "agent_start" });
    h.server.observe({ type: "turn_end", message: failure }); h.server.observe({ type: "auto_retry_start", attempt: 1 });
    h.server.observe({ type: "agent_end", messages: [failure], willContinue: true });
    expect(h.server.snapshot().state).toBe("recovering"); expect(h.server.snapshot().capabilities.input).toBe(false);
    const success = { role: "assistant", stopReason: "stop", timestamp: 30 };
    h.server.observe({ type: "turn_end", message: success }); h.server.observe({ type: "auto_retry_end", success: true, attempt: 1 });
    h.server.observe({ type: "agent_end", messages: [failure, success] }); expect(h.server.snapshot().state).toBe("idle");
    h.server.observe({ type: "agent_start" });
    h.server.observe({ type: "auto_retry_start", attempt: 2 });
    h.server.observe({ type: "agent_end", messages: [failure], willContinue: true });
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "local continuation failed" });
    expect(h.server.snapshot().state).toBe("failed");
  } finally { h.cleanup(); }
});
test("intentional native abort and exact retry cancellation do not become provider failure", () => {
  const h = harness();
  try {
    const aborted = { role: "assistant", stopReason: "aborted", errorMessage: "Request aborted" };
    h.server.observe({ type: "turn_end", message: aborted }); h.server.observe({ type: "agent_end", messages: [aborted] }); expect(h.server.snapshot().state).toBe("idle");
    const failure = { role: "assistant", stopReason: "error" };
    h.server.observe({ type: "turn_end", message: failure }); h.server.observe({ type: "auto_retry_start" });
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
    h.server.observe({ type: "agent_end", messages: [failure] }); expect(h.server.snapshot().state).toBe("idle");
  } finally { h.cleanup(); }
});
test("public auto-compaction end clears every completion while terminal error remains visible", () => {
  const h = harness();
  try {
    for (const outcome of [{ aborted: true }, { aborted: false, skipped: true, errorMessage: "nothing to compact" }, { aborted: false, result: {} }]) {
      h.server.observe({ type: "auto_compaction_start" }); h.server.observe({ type: "session.compacting" }); expect(h.server.snapshot().state).toBe("running");
      h.server.observe({ type: "auto_compaction_end", willRetry: false, ...outcome }); expect(h.server.snapshot().state).toBe("idle");
    }
    h.server.observe({ type: "session.compacting" });
    h.server.observe({ type: "auto_compaction_end", aborted: false, willRetry: false, errorMessage: "summary provider failed" }); expect(h.server.snapshot().state).toBe("failed");
    h.server.observe({ type: "session_compact" }); expect(h.server.snapshot().state).toBe("idle");
  } finally { h.cleanup(); }
});
test("manual compaction uncertainty clears on native run, and ask name is exact", async () => {
  const h = harness();
  try {
    h.server.observe({ type: "session.compacting" }); expect(h.server.snapshot().state).toBe("running"); expect(h.server.snapshot().capabilities.input).toBe(false);
    h.server.observe({ type: "session.compacting" }); h.server.observe({ type: "agent_start" }); expect(h.server.snapshot().state).toBe("idle");
    h.server.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "ask" }); expect(h.server.snapshot().state).toBe("waiting_input");
    h.server.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "ask" });
    h.server.observe({ type: "tool_execution_start", toolCallId: "b", toolName: "ask_user" }); expect(h.server.snapshot().state).toBe("running");
  } finally { h.cleanup(); }
});
