import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { OmpError, parseRequest, payloadHash, type OmpGoal } from "../src/runtime/omp/contract.ts";
import { OmpControlServer, hasAsyncWork, type OmpContext, type OmpExecutionHoldState } from "../src/runtime/omp/server.ts";
import { ompFixture } from "./fixtures/omp.ts";

function harness(options: { borrowed?: boolean; nativeHold?: boolean; busy?: boolean; receipt?: boolean; timeout?: number; onShutdown?: () => void } = {}) {
  const f = ompFixture(); if (options.borrowed) { f.target.role = "attached-lead"; f.identity.role = "attached-lead"; }
  let idle = !options.busy, leaf: string | null = null, goal: OmpGoal = null, pending = false, async: unknown = null;
  let core: OmpExecutionHoldState = { sessionId: f.identity.sessionId, generation: 0, status: "open" };
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
    expect((await h.dispatch("hold", { operationId: "hold", origin: "user" }) as any).state).toBe("failed");
    expect((await h.dispatch("release", { operationId: "release", origin: "user" }) as any).state).toBe("failed");
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
test("manual compaction uncertainty clears only on native run or authoritative core held, and ask name is exact", async () => {
  const h = harness();
  try {
    h.server.observe({ type: "session.compacting" }); expect(h.server.snapshot().state).toBe("running"); expect(h.server.snapshot().capabilities.input).toBe(false);
    expect((await h.dispatch("hold", { operationId: "hold", origin: "user" }) as any).state).toBe("idle");
    await h.dispatch("release", { operationId: "release", origin: "user" });
    h.server.observe({ type: "session.compacting" }); h.server.observe({ type: "agent_start" }); expect(h.server.snapshot().state).toBe("idle");
    h.server.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "ask" }); expect(h.server.snapshot().state).toBe("waiting_input");
    h.server.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "ask" });
    h.server.observe({ type: "tool_execution_start", toolCallId: "b", toolName: "ask_user" }); expect(h.server.snapshot().state).toBe("running");
  } finally { h.cleanup(); }
});

test("terminal failures remain ordered after recovery, retry exhaustion commits without agent_end and duplicate end dedupes", async () => {
  const h = harness(), error = { role: "assistant", stopReason: "error", timestamp: 10, errorMessage: "Unauthorized API key sk-secret-example https://secret.invalid" };
  try {
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "agent_end", messages: [error] });
    h.server.observe({ type: "agent_end", messages: [error] });
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "turn_end", message: error });
    h.server.observe({ type: "auto_retry_start" }); h.server.observe({ type: "agent_end", willContinue: true, messages: [error] });
    expect((await h.dispatch("failures", { after: 0, limit: 100 }) as any).records).toHaveLength(1);
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "quota exceeded sk-secret-example" });
    h.server.observe({ type: "agent_end", messages: [error] });
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    expect(h.server.snapshot().state).toBe("idle");
    const page: any = await h.dispatch("failures", { after: 0, limit: 100 });
    expect(page.records.map((r: any) => [r.sequence, r.phase, r.category])).toEqual([[1, "model", "authentication"], [2, "model", "usage-limit"]]);
    expect(page.records[0].executionId).not.toBe(page.records[1].executionId);
    expect(JSON.stringify(page)).not.toContain("sk-secret"); expect(JSON.stringify(page)).not.toContain("https://");
  } finally { h.cleanup(); }
});

test("transient retry success, recovered errors, cancellation, assistant abort and intentional hold create no failures", async () => {
  const h = harness(), error = { role: "assistant", stopReason: "error", timestamp: 10 };
  try {
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "turn_end", message: error });
    h.server.observe({ type: "auto_retry_start" }); h.server.observe({ type: "agent_end", awaitingAsyncWork: true, messages: [error] });
    h.server.observe({ type: "auto_retry_end", success: true });
    h.server.observe({ type: "agent_end", messages: [{ ...error, retryRecovery: { kind: "auto-retry", status: "recovered" } }] });
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" }); h.server.observe({ type: "agent_end", messages: [error] });
    h.server.observe({ type: "agent_start" }); h.server.observe({ type: "agent_end", messages: [{ ...error, stopReason: "aborted" }] });
    h.server.observe({ type: "agent_start" }); await h.dispatch("hold", { operationId: "hold", origin: "user" }); h.server.observe({ type: "agent_end", messages: [{ ...error, stopReason: "aborted" }] });
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
    expect((await h.dispatch("failures", { after: 0, limit: 100 }) as any).records).toHaveLength(0);
  } finally { h.cleanup(); }
});

test("compaction aliases and retries coalesce; terminal compaction and model remain distinct and sanitized", async () => {
  const h = harness();
  try {
    for (const outcome of [{ willRetry: true, errorMessage: "transient" }, { aborted: true, errorMessage: "abort" }, { skipped: true, errorMessage: "skip" }]) {
      h.server.observe({ type: "auto_compaction_start" }); h.server.observe({ type: "session.compacting" });
      h.server.observe({ type: "auto_compaction_end", ...outcome }); h.server.observe({ type: "session_compact" });
    }
    h.server.observe({ type: "auto_compaction_start" }); h.server.observe({ type: "session.compacting" });
    h.server.observe({ type: "auto_compaction_end", willRetry: true, errorMessage: "retry" });
    h.server.observe({ type: "auto_compaction_start" }); h.server.observe({ type: "auto_compaction_end" });
    expect(h.server.snapshot().state).toBe("idle");
    expect((await h.dispatch("failures", { after: 0, limit: 100 }) as any).records).toHaveLength(0);
    h.server.observe({ type: "agent_start" });
    h.server.observe({ type: "auto_compaction_start" }); h.server.observe({ type: "session.compacting" });
    h.server.observe({ type: "auto_compaction_end", errorMessage: "unknown model sk-secret" });
    h.server.observe({ type: "auto_compaction_end", errorMessage: "unknown model sk-secret" });
    h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed sk-secret" }] });
    const page: any = await h.dispatch("failures", { after: 0, limit: 100 });
    expect(page.records.map((r: any) => [r.phase, r.category])).toEqual([["compaction", "configuration"], ["model", "runtime"]]);
    expect(JSON.stringify(page)).not.toContain("sk-secret");
  } finally { h.cleanup(); }
});

test("unobserved terminal model identity is a visible failure-channel gap and borrowed lead exposes no journal", async () => {
  const h = harness(), lead = harness({ borrowed: true });
  try {
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "provider failed" });
    expect(h.server.snapshot().capabilities.durableFailures).toBe(false); expect(h.server.snapshot().capabilities.input).toBe(false);
    await expect(h.dispatch("failures", { after: 0, limit: 100 })).rejects.toThrow("failure channel unavailable");
    h.server.observe({ type: "agent_start" }); expect(h.server.snapshot().capabilities.durableFailures).toBe(false);
    expect(lead.server.snapshot().capabilities.durableFailures).toBe(false);
    await expect(lead.dispatch("failures", { after: 0, limit: 100 })).rejects.toThrow("Borrowed OMP lead");
  } finally { h.cleanup(); lead.cleanup(); }
});


test("failure journal write failure disables managed input and durable failure readiness", async () => {
  const h = harness();
  try {
    expect(h.server.snapshot().capabilities.durableFailures).toBe(true);
    const path = join(h.directory, "journal", "failures.json");
    unlinkSync(path); mkdirSync(path, { mode: 0o700 });
    h.server.observe({ type: "agent_start" });
    h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "sk-secret-example" }] });
    h.server.observe({ type: "agent_start" });
    const snap = h.server.snapshot();
    expect(snap.state).toBe("failed"); expect(snap.capabilities.input).toBe(false); expect(snap.capabilities.durableFailures).toBe(false);
    await expect(h.dispatch("failures", { after: 0, limit: 100 })).rejects.toThrow("failure channel unavailable");
    await expect(h.dispatch("input", { operationId: "next", text: "task", payloadHash: payloadHash("task") })).rejects.toThrow("blocked before submission");
    expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});


test("automatic hold racing genuine terminal authentication failure persists one record", async () => {
  const h = harness();
  try {
    h.server.observe({ type: "agent_start" });
    await h.dispatch("hold", { operationId: "automatic-disconnect-hold", origin: "automatic" });
    h.server.observe({ type: "auto_retry_end", success: false, finalError: "provider authentication failed sk-secret-example" });
    const page: any = await h.dispatch("failures", { after: 0, limit: 100 });
    expect(h.server.snapshot()).toMatchObject({ state: "failed", held: true, capabilities: { durableFailures: true } });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ phase: "model", category: "authentication", executionId: "instance:1:1" });
    expect(JSON.stringify(page)).not.toContain("sk-secret-example");
    h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] });
    expect((await h.dispatch("failures", { after: 0, limit: 100 }) as any).records).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("stop intent does not suppress genuine model or compaction failures", async () => {
  const h = harness();
  try {
    h.server.observe({ type: "agent_start" });
    await h.dispatch("stop", { operationId: "stop" });
    h.server.observe({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider authentication failed" }] });
    h.server.observe({ type: "auto_compaction_end", errorMessage: "provider authentication failed" });
    const page: any = await h.dispatch("failures", { after: 0, limit: 100 });
    expect(page.records.map((record: any) => [record.phase, record.category])).toEqual([["model", "authentication"], ["compaction", "authentication"]]);
  } finally { h.cleanup(); }
});

for (const legacy of [false, true]) test(`confirmed fresh managed startup retains hold without old stop intent (legacy=${legacy})`, async () => {
  const stopped = Promise.withResolvers<void>(), h = harness({ onShutdown: stopped.resolve });
  let resumed: OmpControlServer | undefined;
  try {
    await h.dispatch("stop", { operationId: "old-process-stop" });
    await stopped.promise;
    expect(h.shutdowns()).toBe(1);
    h.server.close();
    if (legacy) {
      const path = join(h.directory, "journal", "control.json"), saved = JSON.parse(readFileSync(path, "utf8"));
      delete saved.controllerInstanceId;
      writeFileSync(path, JSON.stringify(saved));
    }
    h.setCore({ sessionId: h.identity.sessionId, generation: 0, status: "open" });
    const target = { ...h.target, instanceId: "fresh-native-controller", generation: h.target.generation + 1 };
    resumed = new OmpControlServer(target, "fixture-bearer", join(h.directory, "journal"), () => h.ctx,
      { getThinkingLevel: () => "medium", sendUserMessage: () => { throw new Error("Unexpected replay"); } }, { timeoutMs: 100, startHeld: true });
    await resumed.listen();
    expect(resumed.snapshot().held).toBe(true);
    const result = await resumed.dispatch(parseRequest({ protocol: 1, id: "release-fresh", token: "fixture-bearer",
      target: { ...h.identity, instanceId: target.instanceId, generation: target.generation }, method: "release",
      params: { operationId: "fresh-explicit-resume", origin: "user" } })) as { held: boolean };
    expect(result.held).toBe(false);
    expect(h.shutdowns()).toBe(1);
  } finally { resumed?.close(); h.cleanup(); }
});

test("extension reload in the still-held stopping native epoch cannot clear stop intent", async () => {
  const stopped = Promise.withResolvers<void>(), h = harness({ onShutdown: stopped.resolve });
  let reloaded: OmpControlServer | undefined;
  try {
    await h.dispatch("stop", { operationId: "stop-still-alive" });
    await stopped.promise;
    h.server.close();
    const target = { ...h.target, instanceId: "extension-reload", generation: h.target.generation + 1 };
    reloaded = new OmpControlServer(target, "fixture-bearer", join(h.directory, "journal"), () => h.ctx,
      { getThinkingLevel: () => "medium", sendUserMessage: () => { throw new Error("Unexpected replay"); } }, { timeoutMs: 100, startHeld: true });
    await reloaded.listen();
    await expect(reloaded.dispatch(parseRequest({ protocol: 1, id: "unsafe-release", token: "fixture-bearer",
      target: { ...h.identity, instanceId: target.instanceId, generation: target.generation }, method: "release",
      params: { operationId: "unsafe-release", origin: "user" } }))).rejects.toThrow("shutdown intent");
    expect(reloaded.snapshot().held).toBe(true);
  } finally { reloaded?.close(); h.cleanup(); }
});
