import { timingSafeEqual } from "node:crypto";
import { chmodSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { OMP_MAX_FRAME_BYTES, OmpError, assertIdentity, exactKeys, identityOf, markedText, object, parseRequest, payloadHash,
  type OmpGoal, type OmpIdentity, type OmpOperation, type OmpRequest, type OmpSnapshot, type OmpTarget } from "./contract.ts";
import { OperationJournal, ReceiptPending, durableJson, persistedReceipt, privateDirectory, readPrivateJson } from "./receipts.ts";

/** Minimal structural SDK boundary, checked against the pinned native SDK separately. */
export type OmpContext = {
  mode: string; agent: { kind: "main" | "sub" }; cwd: string;
  model: { id: string; provider: string } | undefined;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null; ensureOnDisk(): Promise<void> };
  isIdle(): boolean; hasPendingMessages(): boolean; abort(): void; shutdown(): void;
  getPendingPlanReview(): unknown;
  getAsyncJobSnapshot(): unknown;
  executionHold?: OmpExecutionHold;
  sessionModes?: {
    getState(): { goal: { status: string; objective?: string; tokenBudget?: number }; loop: { status: string } };
    set(request: { mode: "goal"; action: "pause" | "resume" }): Promise<{ ok: boolean; state: unknown }>;
  };
};
export type OmpNativeApi = { sendUserMessage(text: string): void; getThinkingLevel(): string | undefined };
/** Supplied only after validating a native durable execution gate. Snapshot idle is insufficient. */
export type OmpExecutionHoldState = { sessionId: string; generation: number; status: "open" | "holding" | "held" };
export type OmpExecutionHold = {
  getState(): OmpExecutionHoldState;
  hold(): Promise<OmpExecutionHoldState>;
  release(expected: { sessionId: string; generation: number }): Promise<OmpExecutionHoldState>;
};
type ControlState = { held: boolean; origin?: "user" | "automatic"; pausedGoal?: OmpGoal; coreHold?: OmpExecutionHoldState; stopping?: boolean };
export function hasAsyncWork(snapshot: unknown): boolean {
  if (snapshot === null) return false;
  if (!object(snapshot) || !Array.isArray(snapshot.running) || !Array.isArray(snapshot.recent) || !object(snapshot.delivery)) return true;
  const delivery = snapshot.delivery;
  if (!Number.isSafeInteger(delivery.queued) || (delivery.queued as number) < 0 || typeof delivery.delivering !== "boolean" || !Array.isArray(delivery.pendingJobIds) ||
    (delivery.nextRetryAt !== undefined && typeof delivery.nextRetryAt !== "number")) return true;
  return snapshot.running.length > 0 || delivery.queued !== 0 || delivery.delivering || delivery.pendingJobIds.length > 0 || delivery.nextRetryAt !== undefined;
}
function hasActiveAsyncExecution(snapshot: unknown): boolean {
  if (snapshot === null) return false;
  if (!object(snapshot) || !Array.isArray(snapshot.running) || !Array.isArray(snapshot.recent) || !object(snapshot.delivery) ||
    typeof snapshot.delivery.delivering !== "boolean" || !Number.isSafeInteger(snapshot.delivery.queued) || !Array.isArray(snapshot.delivery.pendingJobIds)) return true;
  return snapshot.running.length > 0 || snapshot.delivery.delivering;
}
export class OmpControlServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private state: ControlState;
  private sequence = 0;
  private runId?: string;
  private approvals = new Set<string>();
  private inputTools = new Set<string>();
  private tools = new Set<string>();
  private continuing = false;
  private compacting = false;
  private observedSafeSettle: boolean;
  private parkedData = false;
  private journal: OperationJournal;
  private readonly controlFile: string;
  constructor(readonly target: OmpTarget, private readonly token: string, readonly sessionDirectory: string,
    private readonly context: () => OmpContext, private readonly api: OmpNativeApi,
    private readonly options: { timeoutMs?: number; startHeld?: boolean; verifyAssociation?: () => Promise<void> } = {}) {
    privateDirectory(sessionDirectory);
    const initial = context();
    this.observedSafeSettle = initial.isIdle() && !initial.hasPendingMessages() && !hasAsyncWork(initial.getAsyncJobSnapshot());
    this.journal = new OperationJournal(join(sessionDirectory, "operations.json"), this.identity);
    this.controlFile = join(sessionDirectory, "control.json");
    this.state = { held: !!options.startHeld };
    try {
      const saved: unknown = readPrivateJson(this.controlFile);
      if (!object(saved) || typeof saved.held !== "boolean" || (saved.origin !== undefined && saved.origin !== "user" && saved.origin !== "automatic") ||
        (saved.pausedGoal !== undefined && saved.pausedGoal !== null && (!object(saved.pausedGoal) || !["active", "paused"].includes(saved.pausedGoal.status as string) || typeof saved.pausedGoal.objective !== "string"))) throw new Error("Invalid control state");
      this.state = { ...(saved as ControlState), held: !!options.startHeld || saved.held };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OmpError("invalid-control-state", "OMP saved hold state cannot be verified"); }
    this.save();
  }
  private save(): void { durableJson(this.controlFile, this.state); }
  private core(ctx: OmpContext): OmpExecutionHold | undefined {
    const core = ctx.executionHold;
    if (!core || typeof core.getState !== "function" || typeof core.hold !== "function" || typeof core.release !== "function") return undefined;
    const state = core.getState();
    if (!object(state) || state.sessionId !== this.target.sessionId || !Number.isSafeInteger(state.generation) || state.generation < 0 || !["open", "holding", "held"].includes(state.status)) return undefined;
    return core;
  }
  private live(): OmpContext {
    if (this.closed) throw new OmpError("controller-closed", "OMP controller epoch ended; outcome unknown", true);
    const ctx = this.context();
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== this.target.sessionId ||
      ctx.sessionManager.getSessionFile() !== this.target.sessionFile || realpathSync(ctx.cwd) !== this.target.cwd ||
      realpathSync(this.target.sessionFile) !== this.target.sessionFile) throw new OmpError("identity-mismatch", "OMP live identity changed; outcome unknown", true);
    return ctx;
  }
  private goal(ctx: OmpContext): OmpGoal {
    const goal = ctx.sessionModes?.getState().goal;
    if (!goal || goal.status === "inactive") return null;
    if (!["active", "paused"].includes(goal.status) || !goal.objective) throw new OmpError("invalid-goal", "OMP native goal state unsupported");
    return { status: goal.status as "active" | "paused", objective: goal.objective, tokenBudget: goal.tokenBudget ?? null };
  }
  snapshot(): OmpSnapshot {
    const ctx = this.live();
    let durable = true;
    try { persistedReceipt(this.identity, ctx.sessionManager.getLeafId(), "", "capability-probe"); }
    catch { durable = false; }
    const managed = this.target.role === "managed-lane", modes = ctx.sessionModes, core = this.core(ctx), barrier = !!core;
    const waiting = this.approvals.size > 0 || !!ctx.getPendingPlanReview();
    const nativeHeld = managed && core?.getState().status === "held";
    const pending = (nativeHeld || this.parkedData ? hasActiveAsyncExecution(ctx.getAsyncJobSnapshot()) : ctx.hasPendingMessages() || hasAsyncWork(ctx.getAsyncJobSnapshot())) || this.continuing || this.compacting;
    const idle = ctx.isIdle() && this.tools.size === 0 && !pending;
    return { identity: this.identity, state: waiting ? "waiting_approval" : this.inputTools.size ? "waiting_input" : managed && core?.getState().status === "holding" ? "pausing" : !this.observedSafeSettle ? "recovering" : idle ? "idle" : this.state.held ? "pausing" : "running",
      held: this.state.held || (managed && !!core && core.getState().status !== "open"), activeRunId: idle ? undefined : this.runId,
      goal: this.goal(ctx), model: ctx.model?.id ?? "", provider: ctx.model?.provider ?? "", effort: this.api.getThinkingLevel(), eventSequence: this.sequence,
      capabilities: { inspect: true, input: durable && this.observedSafeSettle && (!managed || barrier), durableReceipts: durable, hold: managed && !!modes && barrier, release: managed && !!modes && barrier, stop: managed && !!modes && barrier, goals: !!modes } };
  }
  get identity(): OmpIdentity { return identityOf(this.target); }
  observe(event: { type: string; [key: string]: unknown }): void {
    if (this.closed) return;
    this.sequence++;
    const id = String(event.toolCallId ?? "");
    if (event.type === "agent_start") { this.runId = `${this.target.instanceId}:${this.target.generation}:${this.sequence}`; this.continuing = false; this.parkedData = false; }
    if (event.type === "agent_end") {
      this.continuing = !!event.willContinue || !!event.awaitingAsyncWork;
      if (!this.continuing) { this.runId = undefined; this.observedSafeSettle = true; }
    }
    if (event.type === "session.compacting") this.compacting = true;
    if (event.type === "session_compact") this.compacting = false;
    if (event.type === "tool_approval_requested") this.approvals.add(id);
    if (event.type === "tool_approval_resolved") this.approvals.delete(id);
    if (event.type === "tool_execution_start") { this.tools.add(id); if (event.toolName === "ask") this.inputTools.add(id); }
    if (event.type === "tool_execution_end") { this.tools.delete(id); this.inputTools.delete(id); }
  }
  toolBlocked(): boolean { return this.closed || this.state.held; }
  private mutation<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(run); this.queue = result.catch(() => {}); return result;
  }
  private payloadPath(id: string): string { return join(this.sessionDirectory, `payload-${payloadHash(id)}.json`); }
  private reconcile(operationId: string, digest: string): OmpOperation {
    const existing = this.journal.get(operationId, digest);
    if (existing.status === "absent") return existing;
    const ctx = this.live();
    const saved: unknown = readPrivateJson(this.payloadPath(operationId));
    if (!object(saved) || !exactKeys(saved, ["operationId", "text", "payloadHash"]) || saved.operationId !== operationId || saved.payloadHash !== digest || typeof saved.text !== "string" || payloadHash(saved.text) !== digest) throw new OmpError("invalid-payload", "OMP saved operation payload cannot be verified", true);
    let receipt;
    try { receipt = persistedReceipt(this.identity, ctx.sessionManager.getLeafId(), saved.text, operationId); }
    catch (error) { if (error instanceof ReceiptPending) return existing.status === "received" ? { status: "unknown", operationId, payloadHash: digest } : existing; throw error; }
    if (!receipt) return existing.status === "received" ? { status: "unknown", operationId, payloadHash: digest } : existing;
    this.live(); this.journal.received(receipt); return { status: "received", receipt };
  }
  async dispatch(request: OmpRequest): Promise<unknown> {
    assertIdentity(request.target, this.identity); this.live(); await this.options.verifyAssociation?.(); this.live();
    const p = request.params, id = p.operationId as string, digest = p.payloadHash as string;
    if (request.method === "inspect") return this.snapshot();
    if (request.method === "operation") return this.reconcile(id, digest);
    if (request.method === "input") {
      await this.mutation(() => {
        const ctx = this.live(), existing = this.journal.get(id, digest);
        if (existing.status !== "absent") return;
        const snap = this.snapshot();
        if (snap.held || !["idle", "running"].includes(snap.state) || !snap.capabilities.input || !ctx.model || ctx.sessionModes?.getState().loop.status === "active") throw new OmpError("dispatch-blocked", "OMP dispatch blocked before submission", false);
        durableJson(this.payloadPath(id), { operationId: id, text: p.text, payloadHash: digest });
        if (!this.journal.reserve(id, digest)) return;
        this.journal.attempted(id, digest);
        try { this.api.sendUserMessage(markedText(p.text as string, id)); }
        catch { this.journal.unknown(id, digest); throw new OmpError("submission-failed", "OMP submission outcome unknown", true); }
      });
      const deadline = Date.now() + (this.options.timeoutMs ?? 15000);
      do {
        const operation = this.reconcile(id, digest);
        if (operation.status === "received") return { receipt: operation.receipt };
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      this.journal.unknown(id, digest); throw new OmpError("receipt-unknown", "OMP persisted input receipt unknown", true);
    }
    if (this.target.role !== "managed-lane") throw new OmpError("role-forbidden", "Borrowed OMP lead does not permit process control", false);
    if (request.method === "hold") return this.hold(p.origin as "user" | "automatic");
    if (request.method === "release") return this.release(p.origin as "user" | "automatic");
    await this.hold("automatic"); this.live(); this.state.stopping = true; this.save();
    // Intent only. Parent host must verify this exact process exits.
    setTimeout(() => { if (!this.closed) this.live().shutdown(); }, 10);
    return { stopping: true };
  }
  private async hold(origin: "user" | "automatic"): Promise<OmpSnapshot> {
    let nativeHold!: Promise<OmpExecutionHoldState>;
    await this.mutation(() => {
      const ctx = this.live();
      if (!ctx.sessionModes) throw new OmpError("modes-unavailable", "Native OMP mode controls unavailable", false);
      const core = this.core(ctx);
      if (!core) throw new OmpError("execution-barrier-unavailable", "Native OMP execution barrier unavailable", false);
      const goal = this.goal(ctx);
      if (goal?.status === "active" && !this.state.pausedGoal) this.state.pausedGoal = goal;
      this.state.origin = this.state.origin === "user" ? "user" : origin;
      this.state.held = true; this.save();
      // Native hold installs its latch synchronously; default ctx.abort() would alter the goal.
      nativeHold = core.hold();
    });
    const held = await nativeHold; this.live();
    if (held.status !== "held" || held.sessionId !== this.target.sessionId || !Number.isSafeInteger(held.generation) || this.core(this.live())?.getState().generation !== held.generation) throw new OmpError("hold-unconfirmed", "Native OMP execution hold unconfirmed", true);
    this.state.coreHold = held; this.save(); this.continuing = false; this.runId = undefined;
    const deadline = Date.now() + (this.options.timeoutMs ?? 15000);
    do {
      const ctx = this.live();
      if (ctx.isIdle() && !this.tools.size && !hasActiveAsyncExecution(ctx.getAsyncJobSnapshot()) && !this.continuing && !this.compacting && this.core(ctx)?.getState().status === "held") {
        if (this.goal(ctx)?.status === "active") {
          const result = await ctx.sessionModes!.set({ mode: "goal", action: "pause" });
          if (!result.ok) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
        }
        this.observedSafeSettle = true;
        const snap = this.snapshot();
        if (snap.state === "idle" && snap.goal?.status !== "active") return snap;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new OmpError("hold-unconfirmed", "OMP hold unconfirmed; dispatch remains blocked", true);
  }
  private release(origin: "user" | "automatic"): Promise<OmpSnapshot> {
    return this.mutation(async () => {
      const ctx = this.live(), before = this.snapshot();
      if (this.state.stopping) throw new OmpError("stopping", "OMP shutdown intent cannot be released", false);
      if (!this.state.held) { if (before.held) throw new OmpError("unowned-hold", "Native OMP hold is not owned by this controller", false); return before; }
      if (this.state.origin === "user" && origin === "automatic") throw new OmpError("owner-held", "Automatic release cannot clear an owner hold", false);
      const core = this.core(ctx), expectedHold = this.state.coreHold;
      if (before.state !== "idle" || hasActiveAsyncExecution(ctx.getAsyncJobSnapshot()) || !ctx.sessionModes || !core || !expectedHold || core.getState().status !== "held" || core.getState().generation !== expectedHold.generation) throw new OmpError("release-blocked", "OMP release requires confirmed idle native state and exact execution hold", false);
      if (this.state.pausedGoal) {
        const expected = this.state.pausedGoal, goal = this.goal(ctx);
        if (!goal || goal.status !== "paused" || goal.objective !== expected.objective || goal.tokenBudget !== expected.tokenBudget) throw new OmpError("goal-changed", "OMP paused goal changed; explicit reconciliation required", false);
        const result = await ctx.sessionModes.set({ mode: "goal", action: "resume" }); this.live();
        if (!result.ok || this.goal(ctx)?.status !== "active") throw new OmpError("resume-unconfirmed", "OMP native goal resume unconfirmed", true);
      } else if (before.goal?.status === "active") throw new OmpError("unexpected-goal", "Unexpected active OMP goal while held", false);
      const released = await core.release({ sessionId: expectedHold.sessionId, generation: expectedHold.generation }); this.live();
      if (released.status !== "open" || released.sessionId !== expectedHold.sessionId || released.generation !== expectedHold.generation || core.getState().status !== "open") throw new OmpError("release-unconfirmed", "Native OMP execution barrier release unconfirmed", true);
      this.state = { held: false }; this.parkedData = true; this.save(); return this.snapshot();
    });
  }
  async listen(): Promise<void> {
    if (this.state.held && this.target.role === "managed-lane" && this.core(this.live())) await this.hold(this.state.origin ?? "automatic");
    this.server = createServer(socket => {
      this.sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(this.options.timeoutMs ?? 15000, () => socket.destroy());
      let buffer = Buffer.alloc(0), consumed = false;
      socket.on("data", chunk => {
        if (consumed) { socket.destroy(); return; }
        buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        if (buffer.length > OMP_MAX_FRAME_BYTES) { socket.destroy(); return; }
        const end = buffer.indexOf(10); if (end < 0) return; consumed = true;
        void (async () => {
          let request: OmpRequest;
          try {
            if (end !== buffer.length - 1) throw new Error();
            const value: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
            // Authenticate before any identity/schema error response can disclose a session.
            if (!object(value) || typeof value.token !== "string") throw new Error();
            const supplied = Buffer.from(value.token), expected = Buffer.from(this.token);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
            request = parseRequest(value);
          } catch { socket.destroy(); return; }
          let response: unknown;
          try { const result = await this.dispatch(request); this.live(); await this.options.verifyAssociation?.(); this.live(); response = { protocol: 1, id: request.id, identity: this.identity, result }; }
          catch (error) {
            if (this.closed) { socket.destroy(); return; }
            const failure = error instanceof OmpError ? error : new OmpError("control-failed", "OMP control failed; outcome unknown", true);
            response = { protocol: 1, id: request.id, identity: this.identity, error: { code: failure.code, message: "OMP control request failed", attempted: failure.attempted !== false } };
          }
          const frame = JSON.stringify(response) + "\n";
          if (Buffer.byteLength(frame) > OMP_MAX_FRAME_BYTES) socket.destroy(); else socket.end(frame);
        })();
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.target.socketPath, resolve); });
    chmodSync(this.target.socketPath, 0o600);
  }
  close(): void {
    this.closed = true; this.server?.close(); for (const socket of this.sockets) socket.destroy();
    try { unlinkSync(this.target.socketPath); } catch { /* Already removed. */ }
  }
}
