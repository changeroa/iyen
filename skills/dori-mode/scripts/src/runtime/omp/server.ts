import { timingSafeEqual } from "node:crypto";
import { chmodSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { OMP_MAX_FRAME_BYTES, OmpError, assertIdentity, exactKeys, identityOf, markedText, object, parseRequest, payloadHash,
  validInteraction, validInteractionStatus, assertInteractionAnswer,
  type NativeUserInteractions, type NativeInteractionResponse, type NativeUserInteraction,
  type OmpGoal, type OmpIdentity, type OmpOperation, type OmpRequest, type OmpSnapshot, type OmpTarget } from "./contract.ts";
import { FailureJournal, failureCategory } from "./failures.ts";
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
  userInteractions?: NativeUserInteractions;
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
function assistantMessage(value: unknown): Record<string, unknown> | undefined {
  return object(value) && value.role === "assistant" ? value : undefined;
}
function assistantFailed(message: Record<string, unknown> | undefined): boolean {
  if (message?.stopReason !== "error") return false;
  // Native retry bookkeeping can retain a superseded error in active history.
  const recovery = message.retryRecovery;
  return !(object(recovery) && recovery.kind === "auto-retry" && ["recovered", "superseded"].includes(recovery.status as string));
}
export class OmpControlServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private state: ControlState;
  private sequence = 0;
  private runId?: string;
  private settledRunId?: string;
  private compactionId?: string;
  private failures?: FailureJournal;
  private failureGap = false;
  private approvals = new Set<string>();
  private inputTools = new Set<string>();
  private tools = new Set<string>();
  private continuing = false;
  private compacting = false;
  private retrying = false;
  private awaitingErrorSettle = false;
  private retryCancelled = false;
  private retryFailed = false;
  private modelFailed = false;
  private compactionFailed = false;
  private lastAssistant?: Record<string, unknown>;
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
    if (this.target.role === "managed-lane") this.failures = new FailureJournal(join(sessionDirectory, "failures.json"), this.identity);
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
  private interactions(ctx: OmpContext): NativeUserInteractions {
    const native = ctx.userInteractions;
    if (!native || typeof native.list !== "function" || typeof native.respond !== "function" || typeof native.responseStatus !== "function")
      throw new OmpError("interactions-unavailable", "Native user interaction capability unavailable", false);
    return native;
  }
  private listInteractions(ctx: OmpContext): NativeUserInteraction[] {
    const rows = this.interactions(ctx).list();
    if (!Array.isArray(rows) || !rows.every(row => validInteraction(row, this.target.sessionId)) || new Set(rows.map(row => row.id)).size !== rows.length)
      throw new OmpError("invalid-interactions", "Native interaction list invalid", false);
    // Secret dialogs are local-only. Do not expose their title, default or payload.
    return rows.map(row => row.secret ? { id: row.id, sessionId: row.sessionId, kind: row.kind, title: "로컬에서 비밀 입력이 필요합니다", secret: true,
      createdAt: row.createdAt, ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.sourceEntryId ? { sourceEntryId: row.sourceEntryId } : {}), ...(row.sourceOperationHash ? { sourceOperationHash: row.sourceOperationHash } : {}) } : row);
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
    let interactionReady = false;
    let dialogs: NativeUserInteraction[] = [];
    try { dialogs = this.listInteractions(ctx); interactionReady = true; } catch { /* Never advertise unavailable/malformed native capability. */ }
    const waiting = dialogs.some(r => r.kind === "approval" || r.kind === "plan-review") || this.approvals.size > 0 || !!ctx.getPendingPlanReview();
    const nativeHeld = managed && core?.getState().status === "held";
    const pending = (nativeHeld || this.parkedData ? hasActiveAsyncExecution(ctx.getAsyncJobSnapshot()) : ctx.hasPendingMessages() || hasAsyncWork(ctx.getAsyncJobSnapshot())) || this.continuing || this.compacting || this.retrying || this.awaitingErrorSettle;
    const idle = ctx.isIdle() && this.tools.size === 0 && !pending;
    const failureHealthy = !managed || (!!this.failures?.available && !this.failureGap);
    const failed = this.modelFailed || this.compactionFailed || !failureHealthy;
    return { identity: this.identity, state: waiting ? "waiting_approval" : dialogs.length || this.inputTools.size ? "waiting_input" : managed && core?.getState().status === "holding" ? "pausing" : failed ? "failed" : !this.observedSafeSettle || this.retrying || this.awaitingErrorSettle ? "recovering" : idle ? "idle" : this.state.held ? "pausing" : "running",
      held: this.state.held || (managed && !!core && core.getState().status !== "open"), activeRunId: idle ? undefined : this.runId,
      goal: this.goal(ctx), model: ctx.model?.id ?? "", provider: ctx.model?.provider ?? "", effort: this.api.getThinkingLevel(), eventSequence: this.sequence,
      capabilities: { inspect: true, interactions: interactionReady, input: durable && !failed && !this.compacting && !this.retrying && !this.awaitingErrorSettle && this.observedSafeSettle && (!managed || barrier), durableReceipts: durable, durableFailures: managed && failureHealthy, hold: managed && !!modes && barrier, release: managed && !!modes && barrier, stop: managed && !!modes && barrier, goals: !!modes } };
  }
  get identity(): OmpIdentity { return identityOf(this.target); }
  private recordFailure(executionId: string | undefined, phase: "model" | "compaction", error: unknown): void {
    // A hold/stop can race a genuine terminal provider failure. Cancellation is
    // classified at the native event boundary, never inferred from control state.
    if (!this.failures) return;
    if (!executionId) { this.failureGap = true; this.failures.invalidate(); return; }
    try { this.failures.append(executionId, phase, failureCategory(error)); }
    catch { this.failureGap = true; }
  }
  observe(event: { type: string; [key: string]: unknown }): void {
    if (this.closed) return;
    this.sequence++;
    const id = String(event.toolCallId ?? "");
    if (event.type === "agent_start") {
      this.runId = `${this.target.instanceId}:${this.target.generation}:${this.sequence}`; this.settledRunId = this.runId; this.continuing = false; this.parkedData = false;
      this.modelFailed = false; this.compactionFailed = false; this.compacting = false;
      this.lastAssistant = undefined; this.awaitingErrorSettle = false; this.retryCancelled = false; this.retryFailed = false;
    }
    if (event.type === "turn_end" || event.type === "message_end") {
      const message = assistantMessage(event.message);
      if (message) { this.lastAssistant = message; this.awaitingErrorSettle = assistantFailed(message); }
    }
    if (event.type === "agent_end") {
      this.continuing = !!event.willContinue || !!event.awaitingAsyncWork;
      if (!this.continuing) {
        const latest = Array.isArray(event.messages) ? event.messages.findLast(message => !!assistantMessage(message)) as Record<string, unknown> | undefined : undefined;
        // Terminal errors may be pruned from active messages by native recovery. Keep
        // the current turn's newer error, while allowing a later successful assistant.
        const prior = this.lastAssistant;
        const final = prior && (!latest || (typeof prior.timestamp === "number" && typeof latest.timestamp === "number" && prior.timestamp > latest.timestamp)) ? prior : latest ?? prior;
        this.modelFailed = !this.retryCancelled && (assistantFailed(final) || this.retryFailed);
        if (this.modelFailed) this.recordFailure(this.settledRunId, "model", final?.errorMessage);
        this.retrying = false; this.awaitingErrorSettle = false; this.runId = undefined; this.observedSafeSettle = true;
      }
    }
    if (event.type === "session.compacting" || event.type === "auto_compaction_start") {
      if (!this.compacting) this.compactionId = `compaction:${this.target.instanceId}:${this.target.generation}:${this.sequence}`;
      this.compacting = true;
    }
    if (event.type === "session_compact") { this.compacting = false; this.compactionFailed = false; }
    if (event.type === "auto_compaction_end") {
      this.compactionId ??= `compaction:${this.target.instanceId}:${this.target.generation}:${this.sequence}`;
      this.compacting = event.willRetry === true;
      this.compactionFailed = event.aborted !== true && event.skipped !== true && event.willRetry !== true && typeof event.errorMessage === "string" && !!event.errorMessage;
      if (this.compactionFailed) this.recordFailure(this.compactionId, "compaction", event.errorMessage);
    }
    if (event.type === "auto_retry_start") { this.retrying = true; this.modelFailed = false; this.retryCancelled = false; this.retryFailed = false; }
    if (event.type === "auto_retry_end") {
      this.retrying = false;
      // Native turn-recovery.ts explicitly uses this exact outcome for intentional cancellation.
      this.retryCancelled = event.success === false && event.finalError === "Retry cancelled";
      this.retryFailed = event.success === false && !this.retryCancelled;
      this.modelFailed = this.retryFailed;
      if (this.retryFailed) this.recordFailure(this.settledRunId, "model", event.finalError);
      if (event.success === false) this.continuing = false;
      if (event.success === true || this.retryCancelled) this.awaitingErrorSettle = false;
    }
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
    if (request.method === "interactions") return this.listInteractions(this.live());
    if (request.method === "interaction-response-status") {
      const result = this.interactions(this.live()).responseStatus(id);
      if (!validInteractionStatus(result, id)) throw new OmpError("invalid-interaction-status", "Native response status invalid");
      return result;
    }
    if (request.method === "interaction-respond") {
      const native = this.interactions(this.live()), response = p.response as NativeInteractionResponse;
      const responseHash = payloadHash(JSON.stringify(response));
      const prior = native.responseStatus(id);
      if (!validInteractionStatus(prior, id)) throw new OmpError("invalid-interaction-status", "Native response status invalid");
      if (prior.status !== "missing") {
        if (prior.requestId !== p.requestId || prior.responseHash !== responseHash) throw new OmpError("interaction-operation-conflict", "Response operation reused with different payload", false);
        if (prior.status === "pending") throw new OmpError("interaction-pending", "Native response is pending; reconcile status", true);
        return prior;
      }
      const dialog = this.listInteractions(this.live()).find(row => row.id === p.requestId);
      if (!dialog || (dialog.expiresAt && Date.parse(dialog.expiresAt) <= Date.now())) throw new OmpError("interaction-stale", "Native request expired or completed locally", false);
      assertInteractionAnswer(dialog, response);
      // Native resolver owns local/remote races and idempotence; never sendUserMessage/abort.
      const result = await native.respond(dialog.id, response, id);
      this.live();
      if (!validInteractionStatus(result, id) || !["applied", "stale"].includes(result.status) || result.requestId !== dialog.id || result.responseHash !== responseHash)
        throw new OmpError("invalid-interaction-receipt", "Native response outcome unknown", true);
      return result;
    }
    if (request.method === "failures") {
      if (!this.failures) throw new OmpError("role-forbidden", "Borrowed OMP lead does not expose failures", false);
      return this.failures.page(p.after as number, p.limit as number);
    }
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
    // The native barrier proves compaction/retry execution has settled, unlike isIdle alone.
    this.compacting = false; this.retrying = false; this.awaitingErrorSettle = false;
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
        if (["idle", "failed"].includes(snap.state) && snap.goal?.status !== "active") return snap;
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
      if (!["idle", "failed"].includes(before.state) || hasActiveAsyncExecution(ctx.getAsyncJobSnapshot()) || !ctx.isIdle() || this.tools.size || this.compacting || this.continuing || !ctx.sessionModes || !core || !expectedHold || core.getState().status !== "held" || core.getState().generation !== expectedHold.generation) throw new OmpError("release-blocked", "OMP release requires confirmed idle native state and exact execution hold", false);
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
