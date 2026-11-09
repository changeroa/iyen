import { chmodSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync, realpathSync, fsyncSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type DoriConfig } from "./config.ts";
import { atomicJson, SerialQueue } from "./journal.ts";
import { ipc, serviceSocket, hostSocket, readJson } from "./ipc.ts";
import { Registry, assertLaneRuntime, isRemovedOmpLane, statusOf, withStatus, type Lane, LANE_KEY } from "./registry.ts";
import { claimDone, closeLane, objectDone, watchTick, type FlowDeps } from "./done-flow.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { launchLane, quoteForPane, validateLaunch, LaunchError, type LaunchInput } from "./launch.ts";
import { freshnessTick } from "./freshness.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { createLaneTerminal, isHcTerminal } from "./runtime/hc-panes.ts";
import { startLaneEvents, type LaneEventSource } from "./lane-events.ts";
import { syncRegistry } from "./sync.ts";
import { sampleHost, guardTick } from "./host-guard.ts";
import { canLaunch } from "./routing.ts";
import { run, realClock, type Runner } from "./run.ts";
import { backendSocket, bootstrapPath, type Bootstrap } from "./runtime/session-host.ts";
import type { RuntimeInputReceipt, ExternalHoldCode, RuntimeControl, RuntimeRef, RuntimeSnapshot } from "./runtime/types.ts";
import { WorkTimers } from "./work.ts";
import { RequestWorklog } from "./worklog.ts";
import { Checkpoints } from "./checkpoints.ts";
import { Lessons, lessonRepository } from "./lessons.ts";
import { recordReport } from "./reports.ts";
import { supervisionTick } from "./supervision.ts";
import { turnFailure } from "./turn-failure.ts";
import { DeliveryDeferred, Mailbox, postHook, type Mail } from "./mailbox.ts";
import { ExternalCurrentSession, ExternalSessionError, discoverExternal, observeExternal, sharedDaemon, THREAD_UUID, type Attachment as CodexAttachment } from "./runtime/external-current-session.ts";
import { connectObserver, receiptInTurns } from "./runtime/observer.ts";
import { withBindingFence } from "./binding-fence.ts";
import { readWatchTarget } from "./watchdog.ts";
import { operationText } from "./runtime/herdr.ts";
import type { Turn } from "./runtime/generated/v2/Turn.ts";

import { callOmp, findOmpTarget, verifyOmpHerdr, sameOmpTarget } from "./runtime/omp-integration.ts";
import { connectOmp } from "./runtime/omp/client.ts";
import { sameIdentity, validReceipt, payloadHash, object, exactKeys, validLaunchMetadata, type OmpLaunchMetadata, type OmpTarget } from "./runtime/omp/contract.ts";
import { NativeInteractionRelay } from "./runtime/omp/interactions.ts";
import { LeadRestartCoordinator, restartAuthorization, type RestartRecord } from "./lead-restart-coordinator.ts";
import { pinRestartProcess, restartProcessExited, discoverRestartTarget, validateRestartProfile } from "./lead-restart-launcher.ts";
import { restartNativePrepare, restartNativeInspect, restartNativeCommit, restartNativeStart, restartNativeAttest, restartNativeStage, restartNativeStaged, restartNativeRelease } from "./lead-restart-transport.ts";
type Attachment = CodexAttachment & { omp?: OmpTarget };

export type Caller = { role: "admin" | "lead" | "lane" | "host"; key?: string; instance?: string };
export type ExternalTransport = { connect: typeof connectObserver; observe: typeof observeExternal };
type OwnedFailure = Mail & { leadIntakeInstance?: string };
const UNOWNED_LEAD = "unattached-lead";
type HandoffArgs = { sessionFile?: string; terminalId?: string; fromThreadId: string; threadId: string; pane: string; cwd: string; mailIds: string[]; operationId: string };
type ReconnectArgs = { operationId: string; threadId: string; pane: string; cwd: string; sessionFile?: string; terminalId?: string; expectedInstance: string; expectedGeneration: number; expectedRevision: number };
type HandoffIntent = { reconnectWrites?: { before: Lane; after: Lane }[]; reconnect?: ReconnectArgs; version: 1; status: "prepared" | "committed"; args: HandoffArgs; before: Lane; beforeAttachment: Attachment; after: Lane; afterAttachment: Attachment; result: any; createdAt: string; identityHeld?: boolean; cleanupPending?: boolean; activation?: boolean };
export type HandoffIO = { removeMarker(path: string): void };
const durableMarkerRemoval = (path: string): void => {
  // Open before unlink so an open failure leaves the recovery marker intact.
  const directory = openSync(dirname(path), "r");
  try { unlinkSync(path); fsyncSync(directory); } finally { closeSync(directory); }
};
export type ServicePhase = "starting" | "replaying" | "reconciling" | "ready" | "stopping" | "failed";
const reconnectable = (code?: ExternalHoldCode): boolean => Boolean(code && ["identity-unverified", "runtime-unavailable", "runtime-version-changed", "runtime-version-unsupported", "runtime-incompatible", "rebind-interrupted"].includes(code));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export class DoriService {
  readonly registry: Registry;
  readonly inbox: Mailbox;
  readonly outbox: Mailbox;
  readonly operations: Mailbox;
  readonly failures: Mailbox;
  readonly deps: FlowDeps;
  readonly nativeInteractions: NativeInteractionRelay;
  readonly leadRestarts: LeadRestartCoordinator;
  private workQueue = new SerialQueue();
  private launchQueue = new SerialQueue();
  private dispatchQueue = new SerialQueue();
  private failureQueue = new SerialQueue();
  private intakeScope = new AsyncLocalStorage<string>();
  private stopping = false;
  private phase: ServicePhase = "starting";
  private startedAt = new Date().toISOString();
  private replay = { records: 0, lanes: 0 };
  private ingressHealth = new Map<string, { process: "starting" | "running" | "stopped" | "failed"; lastAcceptedAt?: string }>();
  private lastHealth?: string;
  private ticks = new Set<string>();
  private lastTick = new Map<string, number>();
  constructor(readonly config: DoriConfig, readonly runner: Runner = run, readonly externalTransport: ExternalTransport = { connect: connectObserver, observe: observeExternal }, readonly handoffIO: HandoffIO = { removeMarker: durableMarkerRemoval }) {
    this.writeHealth();
    this.phase = "replaying"; this.writeHealth();
    this.registry = new Registry(config.stateDir, (key, action) => key === "lead" ? withBindingFence(config.stateDir, action) : action());
    try {
      this.registry.enableJournal(config.stateDir, progress => { this.replay = progress; this.writeHealth(); });
    } catch (error) { this.phase = "failed"; this.writeHealth(); throw error; }
    this.phase = "reconciling"; this.writeHealth();
    try {
      this.inbox = new Mailbox(config.stateDir, "inbox"); this.outbox = new Mailbox(config.stateDir, "outbox"); this.operations = new Mailbox(config.stateDir, "operations");
      this.failures = new Mailbox(config.stateDir, "failures");
    } catch (error) { this.phase = "failed"; this.writeHealth(); throw error; }
    const call = async <T>(key: string, action: string, args: any = {}): Promise<T> => {
      const lane = await this.registry.read(key);
      if (lane) assertLaneRuntime(lane);
      if (!lane?.runtime?.threadId) throw new Error("Runtime is not registered");
      if (lane.runtime.backend === "external-current-session") return this.externalCall(lane, action, args) as Promise<T>;
      if (action === "stop" && lane.runtime.state === "stopped") return undefined as T;
      const boot = readJson<Bootstrap>(bootstrapPath(config.stateDir, key));
      const result = await ipc<T>(hostSocket(config.stateDir, key), boot.hostToken, action, args, config.runtime.rpcTimeoutMs * 3);
      if (action === "stop") await this.registry.update(key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, state: "stopped", activeTurnId: undefined } }));
      return result;
    };
    const runtime: RuntimeControl = {
      inspect: async key => (await this.registry.read(key))?.runtime?.kind === "omp" ? call(key, "inspect") : this.dispatchQueue.run(key, () => call(key, "inspect")),
      input: (key, text, operationId) => this.withIntake(() => this.dispatchQueue.run(key, async () => {
        const lane = await this.registry.read(key);
        if (lane) assertLaneRuntime(lane);
        if (key === "lead" && this.leadRestarts.hasActive()) throw new DeliveryDeferred("Lead restart fences native input");
        if (!lane || lane.dispatchBlocked || statusOf(lane) === "closed") throw new Error("Lane dispatch is blocked");
        const mail = this.putInbox({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString() });
        if (lane.runtime?.backend === "external-current-session") {
          if (mail.attachmentInstance && mail.attachmentInstance !== lane.runtime.hostInstanceId) throw new DeliveryDeferred("Mail belongs to a previous lead attachment");
          if (this.attachment(lane).excludedInboxIds.includes(mail.id)) throw new DeliveryDeferred("Historical mail is held for explicit reconciliation");
          if (mail.state === "queued" && !["idle", "running"].includes((await call<RuntimeSnapshot>(key, "inspect")).state)) throw new DeliveryDeferred("Attached session requires approval or input; dispatch held");
          if (mail.state === "queued") this.inbox.mark(mail.id, { attachmentInstance: lane.runtime.hostInstanceId });
        }
        if (lane.runtime?.kind === "omp") {
          if (mail.attachmentInstance && mail.attachmentInstance !== lane.runtime.hostInstanceId) throw new DeliveryDeferred("OMP mail belongs to a previous attachment");
          if (mail.state === "queued") {
            const target = lane.runtime.omp?.target;
            if (!target) throw new DeliveryDeferred("OMP native target missing before submission");
            if (mail.ompProvenance && (!sameOmpTarget(mail.ompProvenance.target, target) || mail.ompProvenance.attachmentInstanceId !== lane.runtime.hostInstanceId || mail.ompProvenance.attachmentGeneration !== lane.runtime.generation)) throw new DeliveryDeferred("OMP operation provenance changed; no replay");
            // Persist exact native provenance before the durable sending state and
            // external attempt. Host recovery never relabels this original epoch.
            this.inbox.mark(mail.id, { attachmentInstance: lane.runtime.hostInstanceId, ompProvenance: { target, attachmentInstanceId: lane.runtime.hostInstanceId, attachmentGeneration: lane.runtime.generation } });
          }
        }
        const delivered = await this.inbox.deliver(mail.id, async row => {
          let result: RuntimeInputReceipt;
          try { result = await call<RuntimeInputReceipt>(key, "input", { text: row.text, operationId: row.id }); }
          catch (error) {
            if (lane.runtime?.kind === "omp" && !(error instanceof DeliveryDeferred)) {
              await this.registry.update(key, current => current.runtime?.hostInstanceId !== lane.runtime!.hostInstanceId ? current : { ...current, dispatchBlocked: true, holdReason: current.holdReason ?? "recovery", runtime: { ...current.runtime, held: true, state: "recovering" } });
            }
            throw error;
          }
          if (typeof result?.turnId !== "string" || !result.turnId.trim()) throw new Error("Missing turn receipt");
          return result;
        });
        if (!delivered.turnId) throw new Error("Missing turn receipt");
        return { turnId: delivered.turnId, receiptKind: delivered.receiptKind, receipt: delivered.receipt };
      })),
      hold: (key, origin) => call(key, "hold", { origin }), release: (key, origin) => call(key, "release", { origin }), stop: key => call(key, "stop"),
    };
    this.deps = { config, registry: this.registry, clock: realClock, run: runner, runtime, post: (id, hook, values) => postHook(this.outbox, runner, id, hook, values),
      queueInput: (key, text, operationId) => this.withIntake(async () => {
        const lane = await this.lane(key);
        assertLaneRuntime(lane);
        this.putInbox({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString(), attachmentInstance: this.intakeInstance(lane) });
      }) };
    this.nativeInteractions = new NativeInteractionRelay({
      stateDir: config.stateDir, inbox: this.inbox, ingress: config.ingress,
      lanes: () => this.registry.list(),
      call: async (lane, action, args) => {
        const runtime = lane.runtime, target = runtime?.omp?.target;
        if (runtime?.kind !== "omp" || !target || runtime.threadId !== target.sessionId || runtime.omp!.attachmentInstanceId !== runtime.hostInstanceId ||
          runtime.omp!.attachmentGeneration !== runtime.generation) throw new Error("Native interaction epoch unavailable");
        const assertCurrent = async () => {
          const current = await this.lane(lane.key), active = current.runtime;
          if (lane.key === "lead" && this.leadRestarts?.hasActive() || this.pendingHandoff() || active?.kind !== "omp" || !active.omp || active.hostInstanceId !== runtime.hostInstanceId ||
            active.generation !== runtime.generation || active.threadId !== target.sessionId || active.omp.attachmentInstanceId !== runtime.hostInstanceId ||
            active.omp.attachmentGeneration !== runtime.generation || !sameOmpTarget(active.omp.target, target) || active.external?.detachedAt ||
            active.state === "stopped" || ["closed", "done-claimed", "verified-done"].includes(statusOf(current)) || current.cleanupFence)
            throw new Error("Native interaction epoch changed");
          if (action === "interaction-respond" && (current.dispatchBlocked || active.held || statusOf(current) === "paused")) throw new Error("Native response remains held");
        };
        await assertCurrent();
        const result = await callOmp(target, action, args, config, runner);
        await assertCurrent(); return result;
      },
      post: async (id, thread, text, key) => {
        const existing = this.outbox.get(id);
        if (existing && existing.target !== thread) throw new Error("Native notice thread changed");
        const immutableText = existing?.text ?? text;
        this.outbox.put({ id, target: thread, text: immutableText, state: "queued", at: new Date().toISOString() });
        if (config.hooks.threadReply) await this.deps.post!(id, config.hooks.threadReply, { key, thread, text: immutableText });
      },
    });
    this.leadRestarts = new LeadRestartCoordinator(config.stateDir, {
      reject: async record => {
        for (const mail of this.inbox.list()) {
          if (mail.target === "lead" && mail.attachmentInstance === record.launch.instance) {
            if (mail.state !== "queued" || mail.ompProvenance || mail.receipt || mail.abandonment) throw new Error("Refused restart input provenance changed");
            this.inbox.mark(mail.id, { attachmentInstance: record.authorization.scope.instance });
          }
        }
      },
      assertScope: record => this.assertRestartScope(record),
      prepare: record => restartNativePrepare(record),
      inspect: (record, fresh) => restartNativeInspect(record, fresh),
      commit: record => restartNativeCommit(record),
      exited: record => restartProcessExited(record, runner),
      start: record => restartNativeStart(record, runner),
      discover: record => discoverRestartTarget(record, runner),
      attest: record => restartNativeAttest(record, runner),
      rotate: record => this.rotateRestartAttachment(record),
      stage: record => restartNativeStage(record),
      staged: record => this.reconcileRestartContinuation(record),
      release: record => restartNativeRelease(record),
      finish: record => this.finishRestart(record),
    });
    for (const mail of this.inbox.list()) {
      if (mail.target !== "lead" || !mail.attachmentInstance) continue;
      const instance = this.leadRestarts.intakeInstance(mail.attachmentInstance);
      if (instance !== mail.attachmentInstance) {
        if (mail.state !== "queued" || mail.ompProvenance || mail.receipt || mail.abandonment) throw new Error("Refused restart intake has attempted provenance");
        this.inbox.mark(mail.id, { attachmentInstance: instance });
      }
    }
    this.phase = "ready"; this.writeHealth();
  }
  private healthSnapshot: Record<string, unknown> = {};
  private writeHealth(): void {
    const value = { schemaVersion: 1, phase: this.phase, pid: process.pid, startedAt: this.startedAt, updatedAt: new Date().toISOString(), replay: this.replay, ...this.healthSnapshot };
    // Progress callbacks and idle observations need not rewrite identical state.
    const fingerprint = JSON.stringify({ ...value, updatedAt: undefined });
    if (fingerprint === this.lastHealth) return;
    atomicJson(join(this.config.stateDir, "service-health.json"), value); this.lastHealth = fingerprint;
  }
  setPhase(phase: ServicePhase): void { this.phase = phase; this.writeHealth(); }
  setIngressProcess(id: string, process: "starting" | "running" | "stopped" | "failed"): void {
    this.ingressHealth.set(id, { ...this.ingressHealth.get(id), process });
    this.healthSnapshot = { ...this.healthSnapshot, ingress: this.ingressStatus() }; this.writeHealth();
  }
  private ingressStatus(): unknown[] {
    return this.config.ingress.map(source => ({ id: source.id, process: this.ingressHealth.get(source.id)?.process ?? "starting",
      lastAcceptedAt: this.ingressHealth.get(source.id)?.lastAcceptedAt ?? null,
      // A child process alone is not evidence of the adapter's network state.
      connection: "unverified", queued: this.inbox?.list().filter(row => row.source === source.id && row.state === "queued").length ?? 0 }));
  }
  async health(): Promise<any> {
    const lead = await this.registry.read("lead"), rows = this.inbox.list();
    const queued = rows.filter(row => row.state === "queued"), oldest = queued.map(row => Date.parse(row.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const ext = lead?.runtime?.external;
    const delivery = { state: !lead ? "missing" : ext?.detachedAt || lead.runtime?.state === "stopped" ? "detached" : lead.dispatchBlocked || lead.runtime?.held ? "held" : lead.runtime?.state === "idle" ? "ready" : "busy",
      threadId: lead?.runtime?.threadId, observedState: lead?.runtime?.state, blocked: Boolean(lead?.dispatchBlocked),
      firstCause: ext?.firstHoldReason ?? ext?.holdReason ?? null, latestCause: ext?.latestHoldReason ?? ext?.holdReason ?? null,
      retry: ext?.reconnect ?? null, handoffPending: existsSync(this.activeHandoffPath()) };
    const queue = { queued: queued.length, unknown: rows.filter(row => row.state === "unknown").length, sending: rows.filter(row => row.state === "sending").length,
      oldestQueuedAt: oldest === undefined ? null : new Date(oldest).toISOString(), oldestQueuedAgeMs: oldest === undefined ? null : Math.max(0, this.deps.clock.now() - oldest) };
    const target = readWatchTarget(this.config.stateDir);
    this.healthSnapshot = { delivery, queue, restart: this.leadRestarts.active() ? this.leadRestarts.status(this.leadRestarts.active()!.operationId) : null,
      ingress: this.ingressStatus(), target: target ? { binding: target.binding, deliberateHold: target.deliberateHold, handoffPending: target.handoffPending, verified: false, source: "saved-binding" } : null }; this.writeHealth();
    return { ...readJson<any>(join(this.config.stateDir, "service-health.json")), serviceReachable: true, sampledAt: new Date().toISOString() };
  }
  private activeHandoffPath(): string { return join(this.config.stateDir, "attachments", "handoff.json"); }
  private handoffPath(id: string): string { return join(this.config.stateDir, "attachments", "handoffs", `${createHash("sha256").update(id).digest("hex")}.json`); }
  private pendingHandoff(): HandoffIntent | undefined {
    if (!existsSync(this.activeHandoffPath())) return undefined;
    const { operationId } = readJson<{ operationId: string }>(this.activeHandoffPath());
    return readJson<HandoffIntent>(this.handoffPath(operationId));
  }
  private captureIntakeInstance(): string {
    const restart = this.leadRestarts?.active();
    if (restart) return this.leadRestarts.intakeInstance(restart.launch.instance);
    const pending = this.pendingHandoff();
    if (pending && pending.status !== "committed") return pending.beforeAttachment.instance;
    if (existsSync(this.attachmentPath())) return readJson<Attachment>(this.attachmentPath()).instance;
    // Work accepted before any attachment must never become fresh new-session
    // intake merely because its asynchronous producer finishes after attach.
    return UNOWNED_LEAD;
  }
  private withIntake<T>(action: () => T): T {
    return this.intakeScope.getStore() !== undefined ? action() : this.intakeScope.run(this.captureIntakeInstance(), action);
  }
  private intakeInstance(lane: Lane | null): string | undefined {
    return lane?.runtime?.backend === "external-current-session" ? this.intakeScope.getStore() ?? this.captureIntakeInstance() : undefined;
  }
  private putInbox(mail: Mail): Mail {
    return this.inbox.put(mail.target === "lead" ? { ...mail,
      attachmentInstance: this.leadRestarts.intakeInstance(mail.attachmentInstance ?? this.intakeScope.getStore() ?? this.captureIntakeInstance()) } : mail);
  }
  private putFailure(mail: Mail): Mail {
    const owned: OwnedFailure = { ...mail, leadIntakeInstance: this.intakeScope.getStore() ?? this.captureIntakeInstance() };
    return this.failures.put(owned);
  }
  private assertNoPendingLeadMutation(): void {
    if (this.leadRestarts.hasActive()) throw new Error("Lead restart incomplete; lead mutations remain fenced");
    if (this.pendingHandoff()) throw new Error("Lead handoff incomplete; mutations are held until its recorded operation finishes");
  }
  private blocksPendingMutation(action: string, args: any, caller: Caller): boolean {
    if (["health", "status", "lead-handoff", "lead-activate", "tick", "mail-list", "approval-list", "can-launch"].includes(action)) return false;
    if (["lead", "lead-attach", "lead-detach", "lead-handoff-preview", "lead-reconnect"].includes(action)) return true;
    if (action === "sync") return Boolean(args.write);
    if (action === "mail-resolve") return args.box !== "outbox" && (!this.inbox.get(args.id) || this.inbox.get(args.id)?.target === "lead");
    return (args.key ?? caller.key) === "lead";
  }
  private handoffArgs(args: any, apply: boolean): HandoffArgs {
    if (typeof args.fromThreadId !== "string" || !THREAD_UUID.test(args.fromThreadId) || typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId) || args.fromThreadId === args.threadId ||
      typeof args.pane !== "string" || !args.pane.trim() || typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new Error("Handoff requires exact fromThreadId, different UUID threadId, pane and absolute cwd");
    if (apply && (!Array.isArray(args.mailIds) || typeof args.operationId !== "string" || !args.operationId.trim() || args.operationId.length > 200)) throw new Error("Handoff requires explicit mailIds array and stable operationId");
    if (args.mailIds !== undefined && (!Array.isArray(args.mailIds) || args.mailIds.some((id: unknown) => typeof id !== "string" || !id) || new Set(args.mailIds).size !== args.mailIds.length)) throw new Error("mailIds must contain unique nonempty strings");
    return { ...(this.config.runtime.kind === "omp" ? { sessionFile: realpathSync(args.sessionFile), terminalId: args.terminalId } : {}), fromThreadId: args.fromThreadId, threadId: args.threadId, pane: args.pane, cwd: realpathSync(args.cwd), mailIds: [...(args.mailIds ?? [])].sort(), operationId: args.operationId ?? "" };
  }
  private handoffMail(saved: Attachment): { eligibleMailIds: string[]; blocked: { id: string; reason: string }[]; historicalMailIds: string[] } {
    const eligibleMailIds: string[] = [], blocked: { id: string; reason: string }[] = [], historicalMailIds: string[] = [];
    for (const row of this.inbox.list().filter(row => row.target === "lead")) {
      const reason = row.state !== "queued" ? `delivery-${row.state}` : row.turnId ? "has-turn-receipt" : row.source?.startsWith("reconciled:") ? "previously-reconciled" :
        row.attachmentInstance && row.attachmentInstance !== UNOWNED_LEAD && row.attachmentInstance !== saved.instance ? "other-attachment" : undefined;
      if (reason) blocked.push({ id: row.id, reason });
      else { eligibleMailIds.push(row.id); if (row.attachmentInstance === UNOWNED_LEAD || saved.excludedInboxIds.includes(row.id)) historicalMailIds.push(row.id); }
    }
    return { eligibleMailIds: eligibleMailIds.sort(), blocked, historicalMailIds: historicalMailIds.sort() };
  }
  private async validateHandoffTarget(args: HandoffArgs, socketPath: string, rejectHeld = false): Promise<{ daemon: Awaited<ReturnType<typeof discoverExternal>>; snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>> }> {
    if (this.config.runtime.kind === "omp") {
      const target = await findOmpTarget(this.config, { sessionId: args.threadId, sessionFile: args.sessionFile!, terminalId: args.terminalId!, pane: args.pane, cwd: args.cwd }, this.runner);
      const controller = await connectOmp(target, { timeoutMs: this.config.runtime.rpcTimeoutMs });
      try {
        const observed = await controller.inspect();
        if (rejectHeld && observed.held) throw new Error("OMP reconnect target is natively held; explicit owner resume required");
        if (!["idle", "running"].includes(observed.state) || observed.goal?.status === "paused") throw new Error("OMP target is not ready");
        return { daemon: { socketPath: target.socketPath, binaryVersion: target.runtimeVersion, binary: this.config.runtime.binary, omp: target } as any,
          snap: { threadId: target.sessionId, state: observed.state, activeTurnId: observed.activeRunId, goal: observed.goal, model: observed.model, effort: observed.effort } as any };
      } finally { controller.close(); }
    }
    const daemon = await discoverExternal(this.runner, this.config.runtime);
    if (daemon.socketPath !== socketPath) throw new ExternalSessionError("identity-unverified", "Handoff daemon affinity changed; explicit detach and attach required.");
    const observer = await this.externalTransport.connect(daemon.socketPath, this.config.runtime.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Handoff target observer unavailable; replacement remains held."); });
    try {
      const snap = await new ExternalCurrentSession(observer, this.runner, this.config.runtime, args, daemon.binary).inspect();
      if (snap.state === "failed") throw new ExternalSessionError("runtime-failed", "Handoff target reports a runtime failure; replacement remains held.");
      return { daemon, snap };
    } finally { observer.close(); }
  }
  private reconnectArgs(raw: any): ReconnectArgs {
    if (!exactKeys(raw, ["operationId", "threadId", "pane", "cwd", "expectedInstance", "expectedGeneration", "expectedRevision"], ["sessionFile", "terminalId"]) ||
      typeof raw.operationId !== "string" || !raw.operationId.trim() || raw.operationId.length > 200 ||
      typeof raw.threadId !== "string" || !THREAD_UUID.test(raw.threadId) || typeof raw.pane !== "string" || !raw.pane.trim() ||
      typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || typeof raw.expectedInstance !== "string" || !raw.expectedInstance.trim() ||
      !Number.isSafeInteger(raw.expectedGeneration) || raw.expectedGeneration < 1 || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 ||
      raw.sessionFile !== undefined && (typeof raw.sessionFile !== "string" || !isAbsolute(raw.sessionFile)) ||
      raw.terminalId !== undefined && (typeof raw.terminalId !== "string" || !raw.terminalId.trim())) throw new Error("lead-reconnect requires exact target, operationId and expected attachment epoch/revision");
    return { operationId: raw.operationId, threadId: raw.threadId, pane: raw.pane, cwd: realpathSync(raw.cwd),
      ...(raw.sessionFile !== undefined ? { sessionFile: realpathSync(raw.sessionFile) } : {}), ...(raw.terminalId !== undefined ? { terminalId: raw.terminalId } : {}),
      expectedInstance: raw.expectedInstance, expectedGeneration: raw.expectedGeneration, expectedRevision: raw.expectedRevision };
  }
  private assertReconnectAllowed(lane: Lane, instance: string): void {
    if (["owner-pause", "done-review"].includes(lane.holdReason ?? "") || ["paused", "done-claimed", "verified-done", "closed"].includes(statusOf(lane)) || lane.cleanupFence)
      throw new Error("Lead reconnect cannot clear an owner or completion hold");
    if (this.inbox.list().some(row => row.target === "lead" && (!row.attachmentInstance || row.attachmentInstance === instance) && ["sending", "unknown"].includes(row.state)))
      throw new Error("Lead reconnect requires reconciliation of sending or unknown mail for the existing attachment");
  }
  private assertReconnectSource(lane: Lane, args: ReconnectArgs): Attachment {
    this.assertReconnectAllowed(lane, args.expectedInstance);
    if (lane.runtime?.kind !== this.config.runtime.kind || lane.runtime.hostInstanceId !== args.expectedInstance ||
      lane.runtime.generation !== args.expectedGeneration || lane.revision !== args.expectedRevision) throw new Error("Lead reconnect expected attachment epoch/revision mismatch");
    const saved = this.attachment(lane);
    if (saved.threadId !== args.threadId || saved.cwd !== args.cwd ||
      saved.omp && (saved.omp.sessionFile !== args.sessionFile || saved.pane === args.pane && saved.omp.terminalId !== args.terminalId) ||
      !saved.omp && (args.sessionFile !== undefined || args.terminalId !== undefined)) throw new Error("Lead reconnect target mismatch");
    return saved;
  }
  private async assertReconnectOwnership(source: Attachment, args: HandoffArgs): Promise<void> {
    // Require one exact native owner in both complete collections, even in the
    // same pane. A move additionally requires the old pane to be absent.
    const result = await this.runner(["herdr", "api", "snapshot"], { timeoutMs: this.config.runtime.rpcTimeoutMs });
    const snapshot = result.code === 0 ? JSON.parse(result.out)?.result?.snapshot : undefined;
    if (!Array.isArray(snapshot?.panes) || !Array.isArray(snapshot?.agents)) throw new Error("Reconnect complete Herdr snapshot unavailable");
    const kind = source.omp ? "omp" : "codex", value = source.omp?.sessionFile ?? source.threadId;
    for (const rows of [snapshot.panes, snapshot.agents]) {
      if (rows.some((row: any) => typeof row?.pane_id !== "string" || !row.pane_id) || new Set(rows.map((row: any) => row.pane_id)).size !== rows.length || source.pane !== args.pane && rows.some((row: any) => row.pane_id === source.pane)) throw new Error("Reconnect old pane absence unverified");
      if (rows.some((row: any) => row.pane_id === args.pane && row.agent === kind && (row.agent_session?.agent !== kind ||
        row.agent_session?.kind !== (source.omp ? "path" : "id") || typeof row.agent_session?.value !== "string" ||
        (source.omp ? row.agent_session.source !== "herdr:omp" : !THREAD_UUID.test(row.agent_session.value))))) throw new Error("Reconnect native ownership snapshot incomplete");
      const owners = rows.filter((row: any) => row.agent_session?.value === value);
      if (owners.length !== 1 || owners[0].pane_id !== args.pane || owners[0].agent !== kind || owners[0].agent_session?.agent !== kind || owners[0].agent_session?.kind !== (source.omp ? "path" : "id")) throw new Error("Reconnect exact unique target ownership unverified");
    }
    if (snapshot.agents.some((row: any) => !snapshot.panes.some((pane: any) => pane.pane_id === row.pane_id))) throw new Error("Reconnect incomplete Herdr snapshot");
  }
  private async reconnectLead(raw: any): Promise<any> {
    const reconnect = this.reconnectArgs(raw), path = this.handoffPath(reconnect.operationId);
    if (this.leadRestarts.hasActive()) throw new Error("Lead restart incomplete; reconnect held");
    const pending = this.pendingHandoff();
    if (pending && (!pending.reconnect || !sameJson(pending.reconnect, reconnect))) throw new Error("Another handoff or reconnect is pending");
    let intent: HandoffIntent;
    if (existsSync(path)) {
      intent = readJson<HandoffIntent>(path);
      if (!sameJson(intent.reconnect, reconnect)) throw new Error("Reconnect operationId reused with different arguments");
      if (intent.status === "committed" && !pending) {
        this.assertReconnectAllowed(await this.assertHandoffCurrent(intent), intent.afterAttachment.instance);
        if (!intent.cleanupPending) return this.completedHandoff(intent);
        await withBindingFence(this.config.stateDir, async () => { await this.assertHandoffCurrent(intent); atomicJson(this.activeHandoffPath(), { operationId: reconnect.operationId }); });
      }
    } else {
      const before = await this.lane("lead"), beforeAttachment = this.assertReconnectSource(before, reconnect);
      const args: HandoffArgs = { ...reconnect, fromThreadId: reconnect.threadId, mailIds: [] };
      await this.assertReconnectOwnership(beforeAttachment, args);
      const { daemon, snap } = await this.validateHandoffTarget(args, beforeAttachment.socketPath, true);
      if (snap.held || snap.goal?.status === "paused") throw new Error("Reconnect target held; explicit owner resume required");
      const target = (daemon as any).omp as OmpTarget | undefined;
      const reused = beforeAttachment.pane === args.pane && (!target || !!beforeAttachment.omp && sameOmpTarget(beforeAttachment.omp, target));
      if (target && beforeAttachment.omp && sameIdentity(beforeAttachment.omp, target) && !reused) throw new Error("OMP controller endpoints changed without a new instance");
      const prepared = reused ? { saved: beforeAttachment, lead: { ...before, dispatchBlocked: false, holdReason: undefined,
        runtime: { ...before.runtime!, held: false, state: snap.state, activeTurnId: snap.activeTurnId,
          external: { ...before.runtime!.external!, holdReason: undefined, firstHoldReason: undefined, latestHoldReason: undefined, reconnectBlocked: undefined, reconnect: undefined } } } } :
        this.prepareAttachment(args, args.cwd, before, daemon.binary, daemon, snap,
          [...new Set([...beforeAttachment.excludedInboxIds, ...this.inbox.list().filter(row => row.target === "lead").map(row => row.id)])]);
      const after = { ...before, pane: args.pane, model: prepared.lead.model, dispatchBlocked: false, holdReason: undefined,
        runtime: prepared.lead.runtime, runtimeHistory: prepared.lead.runtimeHistory };
      intent = { version: 1, status: "prepared", args, reconnect, before, beforeAttachment, after, afterAttachment: prepared.saved, createdAt: new Date().toISOString(),
        result: { attached: true, bridge: prepared.saved.bridge, ...(reused ? { reused: true } : {}), lead: after } };
      atomicJson(path, intent);
    }
    await withBindingFence(this.config.stateDir, async () => {
      if (this.leadRestarts.hasActive()) throw new Error("Lead restart incomplete; reconnect held");
      const active = this.pendingHandoff();
      if (active && !sameJson(active.reconnect, reconnect)) throw new Error("Another handoff or reconnect is pending");
      if (!active) { this.assertReconnectSource(await this.lane("lead"), reconnect); atomicJson(this.activeHandoffPath(), { operationId: reconnect.operationId }); }
    });
    return this.finishHandoff(intent);
  }
  private async previewHandoff(raw: any): Promise<any> {
    const args = this.handoffArgs(raw, false), lane = await this.lane("lead");
    if (lane.runtime?.threadId !== args.fromThreadId || lane.runtime.backend !== "external-current-session") throw new Error("Handoff expected source session mismatch");
    const saved = this.attachment(lane), summary = this.handoffMail(saved);
    await this.validateHandoffTarget(args, saved.socketPath);
    return { fromThreadId: args.fromThreadId, threadId: args.threadId, pane: args.pane, cwd: args.cwd, ...summary,
      selectedMailIds: args.mailIds, selectionValid: args.mailIds.every(id => summary.eligibleMailIds.includes(id)), dispatches: false };
  }
  private async applyHandoff(raw: any, activation = false): Promise<any> {
    const args = this.handoffArgs(raw, true), path = this.handoffPath(args.operationId);
    let intent: HandoffIntent;
    if (existsSync(path)) {
      intent = readJson<HandoffIntent>(path);
      if (intent.reconnect || !sameJson(intent.args, args)) throw new Error("Handoff operationId reused with different arguments");
      if (intent.status === "committed" && !this.pendingHandoff()) {
        await this.assertHandoffCurrent(intent);
        if (!intent.cleanupPending) return this.completedHandoff(intent);
        await withBindingFence(this.config.stateDir, async () => { await this.assertHandoffCurrent(intent); atomicJson(this.activeHandoffPath(), { operationId: args.operationId }); });
        return this.finishHandoff(intent);
      }
    } else {
      if (this.pendingHandoff()) throw new Error("Another handoff is pending; finish its recorded operation first");
      const before = await this.lane("lead");
      if (before.runtime && before.runtime.kind !== this.config.runtime.kind) throw new Error("Cross-runtime handoff prohibited; use isolated profiles");
      if (before.runtime?.threadId !== args.fromThreadId || before.runtime.backend !== "external-current-session") throw new Error("Handoff expected source session mismatch");
      const beforeAttachment = this.attachment(before), summary = this.handoffMail(beforeAttachment);
      if (args.mailIds.some(id => !summary.eligibleMailIds.includes(id))) throw new Error("Handoff selection includes attempted, reconciled, unknown or other-attachment mail");
      const { daemon, snap } = await this.validateHandoffTarget(args, beforeAttachment.socketPath);
      if (activation) await this.assertPriorTuiGone(beforeAttachment, args);
      const excluded = [...new Set([...beforeAttachment.excludedInboxIds, ...this.inbox.list().filter(row => row.target === "lead").map(row => row.id)])].filter(id => !args.mailIds.includes(id));
      const { saved: afterAttachment, lead: after } = this.prepareAttachment(args, args.cwd, before, daemon.binary, daemon, snap, excluded);
      const protectedHold = before.holdReason === "owner-pause" || before.holdReason === "done-review" || statusOf(before) === "paused" || statusOf(before) === "done-claimed" || statusOf(before) === "verified-done";
      if (protectedHold) { Object.assign(after, { status: before.status, dispatchBlocked: true, holdReason: before.holdReason, claim: before.claim }); after.runtime!.held = true; }
      const publicLead = { ...after, mode: "external-current-session", bridge: afterAttachment.bridge, identityVerified: true,
        verifiedIdentity: { threadId: args.threadId, pane: args.pane, cwd: args.cwd, model: snap.model, effort: snap.effort }, readiness: protectedHold ? "held" : snap.state === "idle" ? "ready" : "busy" };
      intent = { version: 1, status: "prepared", args, before, beforeAttachment, after, afterAttachment, activation, createdAt: new Date().toISOString(),
        result: { attached: true, handedOff: true, operationId: args.operationId, fromThreadId: args.fromThreadId, threadId: args.threadId, mailIds: args.mailIds, bridge: afterAttachment.bridge, lead: publicLead } };
      atomicJson(path, intent);
    }
    await withBindingFence(this.config.stateDir, async () => {
      const pending = this.pendingHandoff();
      if (pending && pending.args.operationId !== args.operationId) throw new Error("Another handoff is pending");
      if (!pending) {
        // An orphan prepared record means no transaction write was started. Its
        // selected mail may have progressed meanwhile; never replay it.
        const current = await this.lane("lead"), summary = this.handoffMail(this.attachment(current));
        if (current.runtime?.hostInstanceId !== intent.beforeAttachment.instance || current.revision !== intent.before.revision || args.mailIds.some(id => !summary.eligibleMailIds.includes(id))) throw new Error("Handoff source or selected mail changed before intent activation");
        atomicJson(this.activeHandoffPath(), { operationId: args.operationId });
      }
    });
    return this.finishHandoff(intent);
  }
  private async assertHandoffCurrent(intent: HandoffIntent): Promise<Lane> {
    const current = await this.lane("lead");
    if (current.runtime?.hostInstanceId !== intent.afterAttachment.instance || current.runtime.generation !== intent.afterAttachment.generation ||
      current.runtime.threadId !== intent.args.threadId || current.pane !== intent.args.pane || current.cwd !== intent.args.cwd || current.runtime.external?.detachedAt || current.runtime.state === "stopped")
      throw new Error("Completed handoff has been detached or superseded; refusing to restore its old target");
    this.attachment(current); return current;
  }
  private async completedHandoff(intent: HandoffIntent): Promise<any> {
    const current = await this.assertHandoffCurrent(intent);
    const result = { ...intent.result, lead: await this.publicLane(current, true) };
    const completed = { ...intent, cleanupPending: false, result };
    if (!sameJson(intent, completed)) atomicJson(this.handoffPath(intent.args.operationId), completed);
    return result;
  }
  private async finishHandoff(intent: HandoffIntent, automatic = false): Promise<any> {
    const { args, beforeAttachment, afterAttachment } = intent, path = this.handoffPath(args.operationId);
    try {
      const current = await this.lane("lead");
      if (automatic && intent.identityHeld) throw new DeliveryDeferred("Recorded handoff target identity changed; explicit operator retry required");
      if (automatic && Date.parse(current.runtime?.external?.reconnect?.nextAttemptAt ?? "") > this.deps.clock.now()) throw new DeliveryDeferred("Recorded handoff recovery is waiting for its next retry");
      if (![beforeAttachment.instance, afterAttachment.instance].includes(current.runtime?.hostInstanceId ?? "")) throw new Error("Handoff registry identity changed; operator reconciliation required");
      // Every restart validates the exact recorded target before committing or
      // releasing dispatch. A different focused pane/cwd is never substituted.
      if (intent.reconnect) await this.assertReconnectOwnership(beforeAttachment, args);
      const validated = await this.validateHandoffTarget(args, beforeAttachment.socketPath, !!intent.reconnect);
      if (intent.reconnect) {
        if (validated.snap.held || validated.snap.goal?.status === "paused") throw new Error("Reconnect target held; explicit owner resume required");
        if (afterAttachment.omp && !sameOmpTarget(afterAttachment.omp, (validated.daemon as any).omp)) throw new ExternalSessionError("identity-unverified", "Recorded reconnect controller changed; refusing replacement");
        await this.assertReconnectOwnership(beforeAttachment, args);
      }
      // Recheck on every prepared retry, including automatic recovery, immediately
      // before changing routing. A prior preflight cannot authorize a later TUI.
      if (intent.activation && intent.status !== "committed") await this.assertPriorTuiGone(beforeAttachment, args);
      await withBindingFence(this.config.stateDir, async () => {
        const fencedCurrent = await this.lane("lead");
        if (![beforeAttachment.instance, afterAttachment.instance].includes(fencedCurrent.runtime?.hostInstanceId ?? "")) throw new Error("Handoff source changed during validation");
        if (intent.reconnect) {
          if (this.leadRestarts.hasActive()) throw new Error("Lead restart incomplete; reconnect held");
          this.assertReconnectAllowed(fencedCurrent, beforeAttachment.instance);
          // Only an exact source transition durably planned by this operation
          // can explain a changed revision. Error/recovery holds are not proof.
          const ownSourceWrite = intent.reconnectWrites?.some(write => sameJson(write.after, fencedCurrent));
          if (intent.status !== "committed" && fencedCurrent.runtime?.hostInstanceId === beforeAttachment.instance &&
            fencedCurrent.revision !== intent.reconnect.expectedRevision && !ownSourceWrite) throw new Error("Reconnect source revision changed during validation");
          if (fencedCurrent.runtime?.generation !== (fencedCurrent.runtime?.hostInstanceId === beforeAttachment.instance ? beforeAttachment.generation : afterAttachment.generation) ||
            fencedCurrent.runtime?.threadId !== args.threadId || fencedCurrent.cwd !== args.cwd || ![beforeAttachment.pane, args.pane].includes(fencedCurrent.pane ?? "") || fencedCurrent.runtime?.external?.detachedAt || fencedCurrent.runtime?.state === "stopped") throw new Error("Reconnect source changed during validation");
        }
        if (intent.identityHeld) { intent = { ...intent, identityHeld: undefined }; atomicJson(path, intent); }
        if (intent.status !== "committed") {
          const writeStage = (change: (lane: Lane) => Lane) => this.registry.update("lead", lane => {
            const next = change(lane);
            if (intent.reconnect && lane.runtime?.hostInstanceId === beforeAttachment.instance) {
              // Write ahead under the binding fence. A process death after the
              // registry WAL append is recoverable even without running catch.
              const after = { ...next, schemaVersion: 2 as const, revision: (lane.revision ?? 0) + 1 };
              intent = { ...intent, reconnectWrites: [...(intent.reconnectWrites ?? []), { before: lane, after }] };
              atomicJson(path, intent);
            }
            return next;
          });
          await writeStage(lane => ({ ...lane, dispatchBlocked: true, holdReason: lane.holdReason ?? "recovery", runtime: { ...lane.runtime!, held: true, state: "recovering" } }));
          for (const id of args.mailIds) {
            const row = this.inbox.get(id);
            if (!row || row.target !== "lead" || row.state !== "queued" || row.turnId || row.source?.startsWith("reconciled:") || row.attachmentInstance && ![UNOWNED_LEAD, beforeAttachment.instance, afterAttachment.instance].includes(row.attachmentInstance)) throw new Error("Handoff selected mail no longer safe; operator reconciliation required");
            if (row.attachmentInstance !== afterAttachment.instance) this.inbox.mark(id, { attachmentInstance: afterAttachment.instance });
          }
          if (!sameJson(readJson(this.attachmentPath()), afterAttachment)) atomicJson(this.attachmentPath(), afterAttachment);
          await writeStage(lane => ({ ...lane, pane: intent.after.pane, cwd: intent.after.cwd, model: intent.after.model, runtimeHistory: intent.after.runtimeHistory,
            dispatchBlocked: true, holdReason: lane.holdReason ?? "recovery", runtime: { ...intent.after.runtime!, held: true, state: "recovering" } }));
          intent = { ...intent, status: "committed" }; atomicJson(path, intent);
        }
        await this.registry.update("lead", lane => {
          const protectedHold = lane.holdReason === "owner-pause" || lane.holdReason === "done-review" || ["paused", "done-claimed", "verified-done", "closed"].includes(statusOf(lane));
          // A committed marker left after a crash may outlive later observations.
          // Finalize only the handoff's recovery barrier; preserve newer holds and
          // runtime observations rather than restoring the old intent snapshot.
          const cause = lane.runtime?.external?.holdReason?.code;
          if (lane.runtime?.hostInstanceId === afterAttachment.instance && (!lane.dispatchBlocked || cause && cause !== "handoff-interrupted")) return lane;
          return { ...lane, dispatchBlocked: protectedHold, holdReason: protectedHold ? lane.holdReason : undefined,
            runtime: { ...intent.after.runtime!, held: protectedHold, state: protectedHold ? "recovering" : intent.after.runtime!.state } };
        });
        // Persist cleanup intent before removing the gate. If unlink succeeds but
        // directory fsync fails, the same operation can reconstruct the marker.
        intent = { ...intent, cleanupPending: true }; atomicJson(path, intent);
        this.handoffIO.removeMarker(this.activeHandoffPath());
      });
      return await this.completedHandoff(intent);
    } catch (error) {
      if (!(error instanceof DeliveryDeferred)) {
        const current = await this.registry.read("lead");
        await withBindingFence(this.config.stateDir, async () => {
          if (intent.cleanupPending && current?.runtime?.hostInstanceId === afterAttachment.instance && !existsSync(this.activeHandoffPath())) atomicJson(this.activeHandoffPath(), { operationId: args.operationId });
        });
        if (error instanceof ExternalSessionError && error.code === "identity-unverified") { intent = { ...intent, identityHeld: true }; atomicJson(path, intent); }
        const lane = await this.registry.read("lead");
        // Reconnect's active marker already fences dispatch. Do not mutate a
        // refused source, or turn validation failure into recovery authorization.
        if (lane?.runtime && !intent.reconnect) {
          await this.holdExternal(lane.runtime.hostInstanceId, new ExternalSessionError("handoff-interrupted", "Recorded lead handoff is incomplete; verify its exact target and retry the same operationId."));
          await this.recordRetry(lane.runtime.hostInstanceId);
        }
      }
      throw error;
    }
  }
  private async acceptLeadRestart(operationId: string, sourceMessageId: string) {
    const before = await this.lane("lead"), saved = this.attachment(before);
    const authorization = restartAuthorization(this.config, before, this.inbox.list(), sourceMessageId);
    if (this.nativeInteractions.responseHistory().some(({ operation }) => operation.source === authorization.source &&
      operation.sourceMessageId === sourceMessageId && operation.thread === authorization.thread)) throw new Error("Interaction answer cannot authorize a restart");
    const client = await connectOmp(authorization.scope.target, { timeoutMs: this.config.runtime.rpcTimeoutMs });
    let launchMetadata: OmpLaunchMetadata;
    const config = structuredClone(this.config);
    try {
      const snap = await client.inspect();
      if (snap.capabilities.leadRestart !== true) throw new Error("Lead restart unavailable in the currently loaded native runtime; explicit first operator bootstrap required. No source consumed.");
      if (snap.held || snap.goal || !["idle", "running"].includes(snap.state) || (await client.interactions()).length) throw new Error("Native pause, handoff or outstanding question fences restart");
      if (!validLaunchMetadata(snap.launchMetadata) || snap.launchMetadata.agentDir !== snap.launchMetadata.settingsHome ||
        snap.launchMetadata.provider !== snap.provider || snap.launchMetadata.model !== snap.model || snap.launchMetadata.effort !== snap.effort ||
        snap.model !== before.runtime?.model || snap.effort !== before.runtime.effort || snap.launchMetadata.approvalMode === "write")
        throw new Error("Effective native launch profile is missing, mismatched or unsupported; no source consumed");
      launchMetadata = structuredClone(snap.launchMetadata);
      config.runtime.settingsHome = launchMetadata.agentDir;
      config.runtime.omp!.provider = launchMetadata.provider;
      config.runtime.omp!.approvalMode = snap.launchMetadata.approvalMode;
      config.runtime.roles.lead = { model: launchMetadata.model, effort: launchMetadata.effort ?? null };
    } finally { client.close(); }
    validateRestartProfile(config, authorization.scope.target, resolve(config.stateDir, "attachments", "restart-bootstrap", `${payloadHash(operationId)}.json`), launchMetadata);
    const process = await pinRestartProcess(authorization.scope.target, this.config.runtime.omp!.registryDir, this.runner);
    const instance = crypto.randomUUID(), at = new Date().toISOString();
    const bridge = resolve(this.config.stateDir, "clients", "attached-lead", instance, "iyen");
    const record: RestartRecord = { version: 1, operationId, authorization, launchMetadata, authorizationHash: payloadHash(JSON.stringify({ authorization, launchMetadata })),
      phase: "authorized", before, config, createdAt: at, updatedAt: at, process,
      launch: { instance, generation: saved.generation + 1, token: crypto.randomUUID(), bridge,
        bootstrapFile: resolve(this.config.stateDir, "attachments", "restart-bootstrap", `${payloadHash(operationId)}.json`) },
      continuation: { operationId: `lead-restart-continuation:${operationId}`,
        text: `The owner-authorized native lead restart ${operationId} is complete; do not restart again.\nOriginal authenticated owner source: ${authorization.source}/${sourceMessageId}\nOriginal thread: ${authorization.thread}\nInvoke this exact freshly rotated scoped CLI bridge for every Iyen action: ${bridge}\nAll prior/inherited Iyen capabilities and bridge paths are revoked; do not use them.\nPreserve existing persona/profile configuration. Reconcile unknown side effects; never replay historical mailbox input. Continue the original owner conversation using its preserved provenance.\nOriginal owner request:\n${authorization.mail.text}` } };
    return withBindingFence(this.config.stateDir, async () => {
      this.assertNoPendingLeadMutation();
      const current = await this.lane("lead");
      if (current.revision !== before.revision || !sameJson(this.inbox.get(authorization.mail.id), authorization.mail)) throw new Error("Restart source changed during preparation");
      return this.leadRestarts.accept(record);
    });
  }
  private async assertRestartScope(record: RestartRecord): Promise<void> {
    const current = await this.lane("lead"), runtime = current.runtime, old = record.authorization.scope;
    const rotated = runtime?.hostInstanceId === record.launch.instance && runtime.generation === record.launch.generation;
    if (this.pendingHandoff() || !runtime?.omp || runtime.external?.detachedAt || runtime.omp.detachedAt || current.cleanupFence || statusOf(current) !== "working" ||
      current.holdReason && current.holdReason !== "recovery" || runtime.threadId !== old.target.sessionId || current.pane !== old.target.paneId || current.cwd !== old.target.cwd ||
      !rotated && (runtime.hostInstanceId !== old.instance || runtime.generation !== old.generation || !sameOmpTarget(runtime.omp.target, old.target)) ||
      rotated && (!record.freshTarget || !sameOmpTarget(runtime.omp.target, record.freshTarget)) ||
      !this.config.ingress.some(i => i.id === record.authorization.source && i.owners.includes(record.authorization.owner)) ||
      !sameJson(this.inbox.get(record.authorization.mail.id), record.authorization.mail)) throw new Error("Restart authorization/attachment epoch changed");
    if (this.inbox.list().some(mail => mail.target === "lead" && mail.attachmentInstance === old.instance && ["sending", "unknown"].includes(mail.state))) throw new Error("Unknown input fences restart");
    const saved = readJson<Attachment>(this.attachmentPath());
    if (!(saved.instance === old.instance && saved.generation === old.generation && saved.omp && sameOmpTarget(saved.omp, old.target)) &&
      !(saved.instance === record.launch.instance && saved.generation === record.launch.generation && saved.omp && record.freshTarget && sameOmpTarget(saved.omp, record.freshTarget))) throw new Error("Restart attachment capability changed");
  }
  private async rotateRestartAttachment(record: RestartRecord): Promise<void> {
    await withBindingFence(this.config.stateDir, async () => {
      await this.assertRestartScope(record);
      if (!record.freshTarget) throw new Error("Fresh restart target missing");
      const old = record.authorization.scope, target = record.freshTarget;
      const beforeAttachment = readJson<Attachment>(this.attachmentPath());
      const excludedInboxIds = [...new Set([...beforeAttachment.excludedInboxIds,
        ...this.inbox.list().filter(mail => mail.target === "lead" && mail.attachmentInstance !== record.launch.instance).map(mail => mail.id)])];
      const saved: Attachment = { ...beforeAttachment, omp: target, instance: record.launch.instance, generation: record.launch.generation,
        token: record.launch.token, bridge: record.launch.bridge, socketPath: target.socketPath, binary: record.config.runtime.binary,
        binaryVersion: target.runtimeVersion, excludedInboxIds };
      const clientDir = dirname(record.launch.bridge);
      mkdirSync(clientDir, { recursive: true, mode: 0o700 });
      writeFileSync(record.launch.bridge, `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=lead exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`, { mode: 0o700 });
      // Either pinned side repairs after a crash; historical mailbox rows are never rewritten.
      await this.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason: "recovery", leadRestart: { operationId: record.operationId, authorizationHash: record.authorizationHash, phase: "rotating" } }));
      atomicJson(this.attachmentPath(), saved);
      await this.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason: "recovery",
        runtimeHistory: lane.runtime?.hostInstanceId === old.instance ? [...(lane.runtimeHistory ?? []), lane.runtime] : lane.runtimeHistory,
        leadRestart: { operationId: record.operationId, authorizationHash: record.authorizationHash, phase: "held" },
        runtime: { ...record.before.runtime!, hostInstanceId: saved.instance, generation: saved.generation, state: "idle", held: true, activeTurnId: undefined,
          omp: { kind: "omp", target, attachmentInstanceId: saved.instance, attachmentGeneration: saved.generation, attachedAt: record.createdAt, excludedInboxIds },
          external: { socketPath: target.socketPath, binary: record.config.runtime.binary, bridge: saved.bridge } } }));
    });
  }
  private async reconcileRestartContinuation(record: RestartRecord): Promise<boolean> {
    const staged = await restartNativeStaged(record);
    if (!staged || !record.continuation || !record.freshTarget) return false;
    const previous = this.inbox.get(record.continuation.operationId);
    if (previous && (!sameJson(previous.receipt, staged.receipt) || previous.text !== record.continuation.text || previous.attachmentInstance !== record.launch.instance)) throw new Error("Restart continuation mailbox provenance changed");
    if (!previous) this.inbox.put({ id: record.continuation.operationId, target: "lead", text: record.continuation.text, state: "sent", at: new Date().toISOString(),
      source: "lead-restart-continuation", thread: record.authorization.thread, ownerUser: record.authorization.owner,
      metadata: { operationId: record.operationId, authorizationHash: record.authorizationHash, originalSource: record.authorization.source,
        originalSourceMessageId: record.authorization.sourceMessageId, originalMailId: record.authorization.mail.id },
      attachmentInstance: record.launch.instance, receiptKind: "omp-session-entry", receipt: staged.receipt, turnId: staged.receipt.receiptId,
      ompProvenance: { target: record.freshTarget, attachmentInstanceId: record.launch.instance, attachmentGeneration: record.launch.generation } });
    return true;
  }
  private async finishRestart(record: RestartRecord): Promise<void> {
    await withBindingFence(this.config.stateDir, async () => {
      await this.assertRestartScope(record);
      await this.registry.update("lead", lane => {
        if (lane.runtime?.hostInstanceId !== record.launch.instance || lane.runtime.generation !== record.launch.generation || lane.leadRestart?.operationId !== record.operationId) throw new Error("Restart release attachment changed");
        return { ...lane, dispatchBlocked: false, holdReason: undefined, leadRestart: { operationId: record.operationId, authorizationHash: record.authorizationHash, phase: "released" },
          runtime: { ...lane.runtime, held: false } };
      });
    });
  }
  private attachmentPath(): string { return join(this.config.stateDir, "attachments", "lead.json"); }
  private attachment(lane: Lane): Attachment {
    const saved = readJson<Attachment>(this.attachmentPath());
    if (lane.key !== "lead" || lane.runtime?.backend !== "external-current-session" || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped" ||
        saved.instance !== lane.runtime.hostInstanceId || saved.generation !== lane.runtime.generation || saved.threadId !== lane.runtime.threadId || saved.pane !== lane.pane || saved.cwd !== lane.cwd ||
        saved.socketPath !== lane.runtime.external?.socketPath || saved.bridge !== lane.runtime.external.bridge ||
        (saved.binary !== lane.runtime.external.binary || (saved.binaryVersion && saved.binaryVersion !== lane.runtime.binaryVersion)) &&
          !(lane.runtime.external.rebind?.binary === saved.binary && lane.runtime.external.rebind.binaryVersion === saved.binaryVersion)) throw new Error("Stale or detached lead attachment");
    if (lane.runtime.kind === "omp" && (!saved.omp || !lane.runtime.omp || !sameIdentity(saved.omp, lane.runtime.omp.target) || lane.runtime.omp.attachmentInstanceId !== saved.instance || lane.runtime.omp.attachmentGeneration !== saved.generation)) throw new Error("OMP saved attachment mismatch");
    return saved;
  }
  private async holdExternal(instance: string, error: unknown = new ExternalSessionError("identity-unverified", "Attached session identity unavailable; explicit attachment required.")): Promise<void> {
    const reason = error instanceof ExternalSessionError ? error : new ExternalSessionError("identity-unverified", "Attached session could not be verified; explicit reconnection required.");
    await this.registry.update("lead", lane => {
      if (lane.runtime?.hostInstanceId !== instance || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped") return lane;
      const ext = lane.runtime.external!;
      const latest = ext.holdReason && ext.latestHoldReason?.code === reason.code && ext.latestHoldReason.message === reason.message && sameJson(ext.latestHoldReason.evidence, reason.evidence) ? ext.latestHoldReason : { code: reason.code, message: reason.message, ...(reason.evidence ? { evidence: reason.evidence } : {}), at: new Date().toISOString() };
      const next: Lane = { ...lane, dispatchBlocked: true, holdReason: lane.holdReason ?? "recovery", runtime: { ...lane.runtime, held: true, state: "recovering", activeTurnId: undefined,
        external: { ...ext, holdReason: ext.holdReason ?? latest, firstHoldReason: ext.firstHoldReason ?? ext.holdReason ?? latest, latestHoldReason: latest,
          reconnectBlocked: Boolean((ext.reconnectBlocked && !reconnectable(ext.holdReason?.code)) || !reconnectable(reason.code)) } } };
      return sameJson(lane, next) ? lane : next;
    });
  }
  private async rebindExternal(lane: Lane, saved: Attachment, automatic: boolean): Promise<Awaited<ReturnType<ExternalCurrentSession["inspect"]>>> {
    const daemon = await discoverExternal(this.runner, this.config.runtime);
    if (daemon.socketPath !== saved.socketPath) throw new ExternalSessionError("identity-unverified", "Attached daemon affinity changed; explicit attachment required.");
    const observer = await this.externalTransport.connect(daemon.socketPath, this.config.runtime.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Shared Codex observer unavailable; delivery is waiting for reconnection."); });
    let snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>;
    try { snap = await new ExternalCurrentSession(observer, this.runner, this.config.runtime, saved, daemon.binary, realClock, turns => this.recordExternalFailures(saved, turns)).inspect(); }
    finally { observer.close(); }
    if (snap.state === "failed") throw new ExternalSessionError("runtime-failed", "Attached Codex session reports a runtime failure; explicit attachment required.");
    await withBindingFence(this.config.stateDir, async () => {
      const currentLane = await this.lane("lead");
      if (currentLane.runtime?.hostInstanceId !== saved.instance || currentLane.runtime.generation !== saved.generation || currentLane.runtime.external?.detachedAt) throw new DeliveryDeferred("Attachment changed during revalidation");
      lane = currentLane; this.attachment(lane);
      const protectedHold = lane.holdReason === "owner-pause" || lane.holdReason === "done-review" || statusOf(lane) === "paused" || statusOf(lane) === "done-claimed" || statusOf(lane) === "verified-done" || statusOf(lane) === "closed";
      if (automatic && (protectedHold || lane.runtime?.external?.reconnectBlocked && !reconnectable(lane.runtime.external.holdReason?.code))) throw new DeliveryDeferred("Attached lead requires explicit reconciliation");
      const changed = saved.binary !== daemon.binary || saved.binaryVersion !== daemon.binaryVersion || Boolean(lane.runtime?.external?.rebind);
      try {
        if (changed) {
          // Record both sides before changing the attachment. Either side is accepted
          // on recovery, but affinity and identity are always revalidated first.
          await this.registry.update("lead", current => ({ ...current, dispatchBlocked: true, holdReason: current.holdReason ?? "recovery", runtime: { ...current.runtime!, held: true, state: "recovering",
            external: { ...current.runtime!.external!, rebind: { binary: daemon.binary, binaryVersion: daemon.binaryVersion } } } }));
          atomicJson(this.attachmentPath(), { ...saved, binary: daemon.binary, binaryVersion: daemon.binaryVersion, model: snap.model, effort: snap.effort });
        }
        await this.registry.update("lead", current => {
          if (current.runtime?.hostInstanceId !== saved.instance || current.runtime?.generation !== saved.generation || current.runtime.external?.detachedAt || automatic && (current.holdReason && current.holdReason !== "recovery" || ["paused", "done-claimed", "verified-done", "closed"].includes(statusOf(current)))) throw new DeliveryDeferred("Attachment changed or deliberately held during revalidation");
          const next: Lane = { ...current, model: snap.model, dispatchBlocked: protectedHold, holdReason: protectedHold ? current.holdReason : undefined, runtime: { ...current.runtime!,
            binaryVersion: daemon.binaryVersion, model: snap.model, effort: snap.effort, held: protectedHold, state: protectedHold ? "recovering" : snap.state, activeTurnId: snap.activeTurnId,
            external: { ...current.runtime!.external!, binary: daemon.binary, holdReason: undefined, reconnectBlocked: undefined, reconnect: undefined, rebind: undefined } } };
          return sameJson(current, next) ? current : next;
        });
      } catch {
        throw new ExternalSessionError("rebind-interrupted", "Recorded runtime rebind is incomplete; delivery is waiting for verified reconnection.");
      }
    });
    return snap;
  }
  private async reconnectExternal(lane: Lane, saved: Attachment): Promise<Awaited<ReturnType<ExternalCurrentSession["inspect"]>> | null> {
    const ext = lane.runtime!.external!;
    if (lane.holdReason && lane.holdReason !== "recovery" || ext.reconnectBlocked && !reconnectable(ext.holdReason?.code) || !ext.rebind && !reconnectable(ext.holdReason?.code)) return null;
    if (Date.parse(ext.reconnect?.nextAttemptAt ?? "") > this.deps.clock.now()) throw new DeliveryDeferred("Attached runtime reconnect is waiting for its next retry");
    try { return await this.rebindExternal(lane, saved, true); }
    catch (error) {
      if (!(error instanceof DeliveryDeferred)) {
        await this.holdExternal(saved.instance, error);
        await this.recordRetry(saved.instance);
      }
      throw error;
    }
  }
  private async recordRetry(instance: string): Promise<void> {
    await this.registry.update("lead", current => {
      if (current.runtime?.hostInstanceId !== instance) return current;
      const attempts = Math.min(16, (current.runtime.external?.reconnect?.attempts ?? 0) + 1);
      return { ...current, runtime: { ...current.runtime, external: { ...current.runtime.external!, reconnect: { attempts, nextAttemptAt: new Date(this.deps.clock.now() + Math.min(60000, 1000 * 2 ** (attempts - 1))).toISOString() } } } };
    });
  }
  private async recordExternalFailures(saved: Attachment, turns: Turn[]): Promise<void> {
    const current = await this.registry.read("lead");
    if (current?.runtime?.backend !== "external-current-session" || current.runtime.hostInstanceId !== saved.instance || current.runtime.external?.detachedAt) return;
    const failed = new Map(turns.filter(turn => turn.status === "failed").map(turn => [turn.id, turn]));
    if (!failed.size) return;
    for (const mail of this.inbox.list()) {
      if (mail.target !== "lead" || mail.attachmentInstance !== saved.instance || saved.excludedInboxIds.includes(mail.id) || !["sending", "sent", "unknown"].includes(mail.state)) continue;
      const turnId = receiptInTurns(turns, operationText(mail.text, mail.id));
      if (!turnId || (mail.state === "sent" && mail.turnId !== turnId)) continue;
      const turn = failed.get(turnId);
      if (!turn) continue;
      const id = `failed-turn:lead:${saved.instance}:${turnId}`;
      // Preserve first observation and resolution across repeated polling and
      // restarts; never replace a durable failure's metadata or state.
      if (!this.failures.get(id)) this.putFailure({ id, target: "lead", turnId, source: saved.instance, attachmentInstance: saved.instance,
        text: JSON.stringify(turnFailure(turn.error)), state: "queued", at: new Date().toISOString() });
    }
  }
  private async externalCall(lane: Lane, action: string, args: any): Promise<unknown> {
    if (!["inspect", "input"].includes(action)) throw new Error(`External current-session ${action} is unsupported; use lead-detach`);
    if (this.leadRestarts.hasActive()) {
      if (action !== "inspect") throw new DeliveryDeferred("Lead restart fences dispatch");
      throw new DeliveryDeferred("Restart coordinator owns native observation; use lead-restart-status");
    }
    const pending = this.pendingHandoff();
    if (pending) {
      if (action !== "inspect") throw new DeliveryDeferred("Recorded lead handoff is incomplete; dispatch held");
      await this.finishHandoff(pending, true); lane = await this.lane("lead");
    }
    let saved: Attachment;
    try { saved = this.attachment(lane); }
    catch (error) { await this.holdExternal(lane.runtime!.hostInstanceId, new ExternalSessionError("attachment-inconsistent", "Attached session records are inconsistent; explicit attachment required.")); throw error; }
    if (lane.runtime?.kind === "omp") return this.ompExternalCall(lane, saved, action, args);
    if (action === "inspect" && (lane.runtime?.external?.rebind || lane.runtime?.external?.holdReason)) {
      const recovered = await this.reconnectExternal(lane, saved);
      if (recovered) return recovered;
    }
    if (action === "input" && lane.dispatchBlocked) throw new DeliveryDeferred("Attached lead dispatch is held");
    let connected = false;
    try {
      return await this.externalTransport.observe(this.runner, this.config.runtime, { ...saved, binaryVersion: saved.binaryVersion ?? lane.runtime?.binaryVersion }, async observer => {
        connected = true;
        const session = new ExternalCurrentSession(observer, this.runner, this.config.runtime, saved, saved.binary, realClock, turns => this.recordExternalFailures(saved, turns));
        if (action === "input") return session.input(args.text, args.operationId, error => this.holdExternal(saved.instance, error));
        const snap = await session.inspect();
        if (snap.state === "failed") await this.holdExternal(saved.instance, new ExternalSessionError("runtime-failed", "Attached Codex session reports a runtime failure; explicit attachment required."));
        await this.registry.update(lane.key, current => {
          if (current.runtime?.hostInstanceId !== saved.instance || current.runtime.external?.detachedAt) return current;
          const next = { ...current, model: snap.model, runtime: { ...current.runtime, model: snap.model, effort: snap.effort, state: current.dispatchBlocked ? "recovering" as const : snap.state, activeTurnId: snap.activeTurnId } };
          return sameJson(current, next) ? current : next;
        });
        return snap;
      });
    } catch (error) {
      if (!(error instanceof DeliveryDeferred)) {
        await this.holdExternal(saved.instance, error);
        if (action === "inspect") {
          const current = await this.lane("lead");
          const recovered = await this.reconnectExternal(current, saved);
          if (recovered) return recovered;
        }
      }
      if (action === "input" && !connected) throw new DeliveryDeferred("Attached observer unavailable before submission; input remains queued");
      throw error;
    }
  }
  private async ompExternalCall(lane: Lane, saved: Attachment, action: string, args: any): Promise<unknown> {
    const target = saved.omp, epoch = lane.runtime!.omp;
    if (!target || !epoch || !sameIdentity(target, epoch.target) || epoch.attachmentInstanceId !== saved.instance || epoch.attachmentGeneration !== saved.generation) throw new Error("OMP attachment epoch inconsistent");
    const assertCurrent = async () => {
      const current = await this.lane("lead");
      if (this.pendingHandoff() || current.runtime?.hostInstanceId !== saved.instance || current.runtime.generation !== saved.generation || current.runtime.external?.detachedAt || !current.runtime.omp || !sameIdentity(current.runtime.omp.target, target)) throw new Error("OMP attachment changed during dispatch; outcome unknown");
      return current;
    };
    try {
      const current = await assertCurrent();
      if (action === "input" && (current.dispatchBlocked || epoch.excludedInboxIds.includes(args.operationId))) throw new DeliveryDeferred("OMP lead held for reconciliation");
      // Do not hold the cross-process binding fence while the native receipt waits.
      // The dispatch queue fences attachment/handoff; hold uses independent service gates.
      const result = await callOmp(target, action, args, this.config, this.runner);
      await assertCurrent();
      if (action === "inspect") {
        const snap = result as RuntimeSnapshot;
        const uncertain = this.inbox.list().find(row => row.target === "lead" && row.attachmentInstance === saved.instance &&
          row.state === "unknown" && !saved.excludedInboxIds.includes(row.id));
        if (uncertain) await this.reconcileOmpInput("lead", uncertain.text, uncertain.id, saved.instance).catch(() => {});
        await this.registry.update("lead", l => {
          if (l.runtime?.hostInstanceId !== saved.instance || l.runtime.generation !== saved.generation) return l;
          const recover = l.holdReason === "recovery" && !["paused", "done-claimed", "verified-done", "closed"].includes(statusOf(l)) && ["idle", "running"].includes(snap.state) && !this.inbox.list().some(row => row.target === "lead" && row.attachmentInstance === saved.instance && ["sending", "unknown"].includes(row.state));
          return { ...l, ...(recover ? { dispatchBlocked: false, holdReason: undefined } : {}), runtime: { ...l.runtime!, held: recover ? false : l.runtime!.held, state: l.dispatchBlocked && !recover ? "recovering" : snap.state, activeTurnId: snap.activeTurnId,
            external: { ...l.runtime!.external!, ...(recover ? { holdReason: undefined, reconnectBlocked: undefined } : {}) } } };
        });
      }
      return result;
    } catch (error) {
      if (!(error instanceof DeliveryDeferred)) await this.holdExternal(saved.instance, new ExternalSessionError("identity-unverified", "OMP exact target unavailable or changed; explicit revalidation required"));
      throw error;
    }
  }
  private async reconcileOmpInput(key: string, text: string | undefined, operationId: string, instance: string): Promise<unknown> {
    const lane = await this.lane(key), runtime = lane.runtime;
    const assertCurrent = (current: Lane) => {
      if (!runtime?.omp || current.runtime?.kind !== "omp" || current.runtime.backend !== runtime.backend ||
        (key !== "lead" || runtime.backend !== "external-current-session") ||
        current.runtime.hostInstanceId !== instance || current.runtime.hostInstanceId !== runtime.hostInstanceId || current.runtime.generation !== runtime.generation ||
        current.runtime.state === "stopped" || current.runtime.external?.detachedAt || current.runtime.omp?.detachedAt || !current.runtime.omp ||
        !sameOmpTarget(current.runtime.omp.target, runtime.omp.target) || current.cleanupFence || this.pendingHandoff()) throw new Error("OMP receipt attachment changed or unavailable");
    };
    assertCurrent(lane);
    const row = this.inbox.get(operationId);
    if (!row) return { status: "missing", operationId };
    if (row.target !== key || text !== undefined && row.text !== text || row.attachmentInstance !== instance ||
      lane.runtime?.backend === "external-current-session" && this.attachment(lane).excludedInboxIds.includes(row.id)) throw new Error("Input receipt payload or attachment mismatch");
    if (row.state === "abandoned" || row.abandonment) throw new Error("Input abandonment requires its original lifecycle reconciliation");
    const provenance = row.ompProvenance;
    if (provenance && (provenance.attachmentInstanceId !== instance || provenance.attachmentGeneration !== runtime!.generation || !sameOmpTarget(provenance.target, runtime!.omp!.target))) throw new Error("Input receipt provenance mismatch");
    if (row.state === "queued") return { status: "queued", operationId: row.id };
    if (!provenance) throw new Error("Input receipt native provenance missing");
    const captured = JSON.stringify(row);
    const result = await callOmp(provenance.target, "operation", { operationId: row.id, text: row.text }, this.config, this.runner);
    return withBindingFence(this.config.stateDir, async () => {
      assertCurrent(await this.lane(key));
      if (JSON.stringify(this.inbox.get(row.id)) !== captured) throw new Error("Input receipt changed during reconciliation");
      if (result.status !== "received" || !validReceipt(result.receipt, provenance.target, row.id, payloadHash(row.text))) return { status: "unknown", operationId: row.id };
      const receipt = { turnId: result.receipt.receiptId, receiptKind: "omp-session-entry" as const, receipt: result.receipt };
      this.inbox.mark(row.id, { state: "sent", ...receipt });
      return { status: "received", operationId: row.id, ...receipt };
    });
  }
  private async publicLane(lane: Lane, dispatchLocked = false): Promise<any> {
    if (lane.runtime?.backend === "external-current-session" && !dispatchLocked) return this.dispatchQueue.run(lane.key, async () => this.publicLane(await this.lane(lane.key), true));
    if (lane.runtime?.backend !== "external-current-session") return lane;
    const attached = !lane.runtime.external?.detachedAt && lane.runtime.state !== "stopped";
    const snap = attached ? await this.externalCall(lane, "inspect", {}).catch(() => null) as RuntimeSnapshot | null : null;
    const current = await this.lane(lane.key);
    const stillAttached = !current.runtime?.external?.detachedAt && current.runtime?.state !== "stopped";
    const identityVerified = Boolean(snap) && stillAttached && current.runtime?.hostInstanceId === lane.runtime.hostInstanceId;
    const inputReady = identityVerified && !current.dispatchBlocked &&
      (current.runtime?.kind === "omp" ? snap?.inputReady === true && !this.pendingHandoff() &&
        !this.inbox.list().some(row => row.target === lane.key && row.attachmentInstance === current.runtime?.hostInstanceId && ["sending", "unknown"].includes(row.state)) : snap?.state === "idle");
    return { ...current, mode: "external-current-session", bridge: current.runtime?.external?.bridge, identityVerified,
      verifiedIdentity: identityVerified ? { threadId: current.runtime?.threadId, pane: current.pane, cwd: current.cwd, model: current.runtime?.model, effort: current.runtime?.effort } : null,
      inputReady, readiness: !stillAttached ? "detached" : !identityVerified || current.dispatchBlocked ? "held" : inputReady ? "ready" : "busy" };
  }
  private async assertPriorTuiGone(source: Attachment, target: Pick<HandoffArgs, "threadId" | "pane" | "sessionFile">): Promise<void> {
    const unknown = () => new Error("Prior lead TUI ownership is unverified; inspect Herdr and retry activation, or use explicit lead-handoff");
    const live = () => new Error("Prior lead session still has a live Herdr TUI; use explicit lead-handoff to replace it");
    const read = async (argv: string[]) => {
      try {
        const result = await this.runner(["herdr", ...argv], { timeoutMs: this.config.runtime.rpcTimeoutMs });
        if (result.code !== 0) throw unknown();
        return JSON.parse(result.out).result;
      } catch { throw unknown(); }
    };
    const session = (row: any): string | undefined => source.omp
      ? row?.agent === "omp" && row.agent_session?.agent === "omp" && row.agent_session.kind === "path" && row.agent_session.source === "herdr:omp" && typeof row.agent_session.value === "string" ? row.agent_session.value : undefined
      : row?.agent === "codex" && row.agent_session?.agent === "codex" &&
      row.agent_session.kind === "id" && typeof row.agent_session.value === "string" && THREAD_UUID.test(row.agent_session.value) ? row.agent_session.value : undefined;
    const emptyShell = async (): Promise<void> => {
      const inspect = async () => {
        const info = (await read(["pane", "process-info", "--pane", source.pane]))?.process_info;
        const foreground = info?.foreground_processes;
        if (info?.pane_id !== source.pane || !Number.isSafeInteger(info.shell_pid) || info.shell_pid <= 0 ||
          info.foreground_process_group_id !== info.shell_pid || !Array.isArray(foreground) || foreground.length !== 1 ||
          foreground[0].pid !== info.shell_pid || !["sh", "bash", "zsh", "fish", "dash", "ksh"].includes(String(foreground[0].name).split("/").at(-1)!.replace(/^-/, ""))) throw unknown();
        return info.shell_pid as number;
      };
      const shell = await inspect();
      // A foreground shell alone also describes a suspended/background Codex.
      // Require a complete local process table with no children of this shell.
      let result;
      try { result = await this.runner(["ps", "-axo", "pid=,ppid="], { timeoutMs: this.config.runtime.rpcTimeoutMs }); }
      catch { throw unknown(); }
      if (result.code !== 0 || !result.out.trim()) throw unknown();
      const rows = result.out.trim().split("\n").map(line => line.trim().split(/\s+/));
      if (rows.some(row => row.length !== 2 || row.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) ||
          new Set(rows.map(row => row[0])).size !== rows.length || !rows.some(row => Number(row[0]) === shell) ||
          rows.some(row => Number(row[1]) === shell) || await inspect() !== shell) throw unknown();
    };
    const observe = async (): Promise<string[]> => {
      const snapshot = (await read(["api", "snapshot"]))?.snapshot;
      if (!Array.isArray(snapshot?.panes) || !Array.isArray(snapshot?.agents)) throw unknown();
      for (const rows of [snapshot.panes, snapshot.agents]) {
        if (rows.some((row: any) => typeof row?.pane_id !== "string" || !row.pane_id) || new Set(rows.map((row: any) => row.pane_id)).size !== rows.length) throw unknown();
      }
      if (snapshot.agents.some((row: any) => !snapshot.panes.some((pane: any) => pane.pane_id === row.pane_id))) throw unknown();
      const rows = [...snapshot.panes, ...snapshot.agents];
      // Status (including idle/done) is never evidence that a TUI has exited.
      if (rows.some(row => row.agent_session?.value === (source.omp?.sessionFile ?? source.threadId))) throw live();
      const targetRows = rows.filter(row => row.pane_id === target.pane);
      if (targetRows.length !== 2 || targetRows.some(row => session(row) !== (target.sessionFile ?? target.threadId)) || rows.some(row => session(row) === (target.sessionFile ?? target.threadId) && row.pane_id !== target.pane)) throw unknown();
      const priorRows = rows.filter(row => row.pane_id === source.pane);
      if (priorRows.length === 1 && !priorRows[0].agent && !priorRows[0].agent_session) return [session(targetRows[0])!, "shell"];
      if (priorRows.length && (priorRows.length !== 2 || priorRows.some(row => !session(row)) || session(priorRows[0]) !== session(priorRows[1]))) throw unknown();
      // Absence in both complete collections proves a closed pane. Otherwise
      // require an exact, different Codex UUID, confirmed by agent get below.
      return [session(targetRows[0])!, ...(priorRows.length ? [session(priorRows[0])!] : [])];
    };
    const before = await observe();
    for (const pane of new Set([target.pane, ...(before.length > 1 ? [source.pane] : [])])) {
      if (pane === source.pane && before[1] === "shell") { await emptyShell(); continue; }
      const agent = (await read(["agent", "get", pane]))?.agent;
      if (agent?.agent_session?.value === (source.omp?.sessionFile ?? source.threadId)) throw live();
      if (agent?.pane_id !== pane || !session(agent) || session(agent) !== before[pane === target.pane ? 0 : 1]) throw unknown();
    }
    if (!sameJson(before, await observe())) throw unknown();
  }
  private async activateLead(raw: any): Promise<any> {
    if (typeof raw.threadId !== "string" || !THREAD_UUID.test(raw.threadId) || typeof raw.pane !== "string" || !raw.pane.trim() || typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)) throw new Error("lead-activate requires UUID thread-id, pane and absolute cwd");
    const args = { threadId: raw.threadId, pane: raw.pane, cwd: realpathSync(raw.cwd), ...(this.config.runtime.kind === "omp" ? { sessionFile: raw.sessionFile, terminalId: raw.terminalId } : {}) }, pending = this.pendingHandoff();
    if (pending) {
      if (!pending.activation || pending.args.threadId !== args.threadId || pending.args.pane !== args.pane || pending.args.cwd !== args.cwd || this.config.runtime.kind === "omp" && (pending.args.sessionFile !== args.sessionFile || pending.args.terminalId !== args.terminalId)) throw new Error("Another handoff is pending; retry its recorded target and operationId first");
      return this.applyHandoff(pending.args, true);
    }
    const previous = await this.registry.read("lead");
    if (previous?.runtime && previous.runtime.kind !== this.config.runtime.kind) throw new Error("Cross-runtime activation prohibited; use isolated profiles");
    if (previous?.runtime?.backend !== "external-current-session" || previous.runtime.external?.detachedAt || previous.runtime.state === "stopped" ||
      previous.runtime.threadId === args.threadId && previous.pane === args.pane && previous.cwd === args.cwd) return this.attachLead(args);
    const source = this.attachment(previous);
    if (source.threadId === args.threadId) throw new Error("Lead session pane/cwd changed; use explicit lead-handoff or detach and attach");
    // A marker-present retry always uses the recorded operation above. Before
    // that marker exists, a changed source revision needs a freshly validated
    // intent (e.g. to preserve an owner pause after an interrupted preparation).
    // Keep the orphan as history rather than weakening its revision guard.
    const operationId = `lead-activate:${createHash("sha256").update(JSON.stringify([source.instance, previous.revision, args.threadId, args.pane, args.cwd])).digest("hex")}`;
    return this.applyHandoff({ ...args, fromThreadId: source.threadId, mailIds: [], operationId }, true);
  }
  private async attachLead(args: any): Promise<any> {
    if (typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId) || typeof args.pane !== "string" || !args.pane.trim() || typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new Error("lead-attach requires UUID thread-id, pane and absolute cwd");
    const cwd = realpathSync(args.cwd), previous = await this.registry.read("lead");
    if (previous?.runtime && previous.runtime.kind !== this.config.runtime.kind) throw new Error("Cross-runtime attachment conversion prohibited; use an isolated profile");
    const same = previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && previous.runtime.threadId === args.threadId && previous.pane === args.pane && previous.cwd === cwd;
    if (previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && !same) throw new Error("A different lead is attached; explicitly detach it first");
    // Matching identity may keep its existing capability across a binary upgrade.
    // This also accepts either side of a previously interrupted, recorded rebind.
    const saved = same ? this.attachment(previous) : undefined;
    try {
      if (this.config.runtime.kind === "omp") {
        const { daemon, snap } = await this.validateHandoffTarget({ ...args, cwd } as HandoffArgs, "");
        const target = (daemon as any).omp as OmpTarget;
        if (saved) {
          if (!saved.omp || !sameIdentity(saved.omp, target)) throw new Error("OMP native controller changed; detach then explicitly reattach");
          await this.registry.update("lead", current => {
            const protectedHold = ["owner-pause", "done-review"].includes(current.holdReason ?? "") || ["paused", "done-claimed", "verified-done", "closed"].includes(statusOf(current)) || this.inbox.list().some(row => row.target === "lead" && row.attachmentInstance === current.runtime?.hostInstanceId && ["sending", "unknown"].includes(row.state));
            return { ...current, dispatchBlocked: protectedHold, holdReason: protectedHold ? current.holdReason : undefined, runtime: { ...current.runtime!, held: protectedHold, state: snap.state, external: { ...current.runtime!.external!, holdReason: undefined, firstHoldReason: undefined, latestHoldReason: undefined, reconnectBlocked: undefined } } };
          });
          return { attached: true, bridge: saved.bridge, lead: await this.publicLane(await this.lane("lead"), true), reused: true };
        }
        return this.createAttachment(args, cwd, previous, this.config.runtime.binary, daemon, snap);
      }
      if (saved) {
        await this.rebindExternal(previous!, saved, false);
        return { attached: true, bridge: saved.bridge, lead: await this.publicLane(await this.lane("lead"), true), reused: true };
      }
      const daemon = await discoverExternal(this.runner, this.config.runtime), binary = daemon.binary;
      const observer = await this.externalTransport.connect(daemon.socketPath, this.config.runtime.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Shared Codex observer unavailable; delivery is waiting for reconnection."); });
      let snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>;
      try {
        snap = await new ExternalCurrentSession(observer, this.runner, this.config.runtime, { threadId: args.threadId, pane: args.pane, cwd }, binary).inspect();
      } finally { observer.close(); }
      if (snap.state === "failed") throw new ExternalSessionError("runtime-failed", "Current Codex session reports a runtime failure; resolve it before attaching.");
      return await this.createAttachment(args, cwd, previous, binary, daemon, snap);
    } catch (error) {
      if (saved) await this.holdExternal(saved.instance, error);
      throw error;
    }
  }
  private async createAttachment(args: any, cwd: string, previous: Lane | null, binary: string,
    daemon: Awaited<ReturnType<typeof sharedDaemon>>, snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>): Promise<any> {
    if (previous && previous.runtime?.backend !== "external-current-session") {
      await this.assertHostStopped(previous);
      if (existsSync(backendSocket(this.config.stateDir, "lead"))) {
        let oldObserver;
        try { oldObserver = await connectObserver(backendSocket(this.config.stateDir, "lead"), this.config.runtime.rpcTimeoutMs); } catch { /* stale socket; PID and TUI checks above still apply */ }
        if (oldObserver) { oldObserver.close(); throw new Error("Prior lead backend still live; attachment refused"); }
      }
    }
    // Preserve all failed managed intent and credentials as history. Authentication
    // below never considers these old credentials for an external attachment.
    if (previous) {
      const history = join(this.config.stateDir, "attachments", "history", crypto.randomUUID());
      atomicJson(join(history, "lane.json"), previous);
      for (const suffix of [".json", ".runtime.json", ".pid.json", ".backend.json"]) {
        const file = join(this.config.stateDir, "hosts", `lead${suffix}`);
        if (existsSync(file)) writeFileSync(join(history, `lead${suffix}`), readFileSync(file), { mode: 0o600 });
      }
      if (existsSync(this.attachmentPath())) writeFileSync(join(history, "attachment.json"), readFileSync(this.attachmentPath()), { mode: 0o600 });
    }
    const saved = await withBindingFence(this.config.stateDir, async () => {
      const current = await this.registry.read("lead");
      if (current?.revision !== previous?.revision || current?.runtime?.hostInstanceId !== previous?.runtime?.hostInstanceId) throw new Error("Attachment source changed during preflight");
      const { saved, lead } = this.prepareAttachment(args, cwd, previous, binary, daemon, snap, this.inbox.list().filter(row => row.target === "lead").map(row => row.id));
      await this.registry.write(lead);
      // Publish the credential only after the registry commit succeeds. A revision
      // conflict must not revoke a previously valid attachment's capability.
      atomicJson(this.attachmentPath(), saved);
      return saved;
    });
    return { attached: true, bridge: saved.bridge, lead: await this.publicLane(await this.lane("lead"), true) };
  }
  private prepareAttachment(args: any, cwd: string, previous: Lane | null, binary: string,
    daemon: Awaited<ReturnType<typeof sharedDaemon>>, snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>, excludedInboxIds: string[]): { saved: Attachment; lead: Lane } {
    const instance = crypto.randomUUID(), generation = (previous?.runtime?.generation ?? 0) + 1;
    const clientDir = resolve(this.config.stateDir, "clients", "attached-lead", instance), bridge = join(clientDir, "iyen");
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    const saved: Attachment = { threadId: args.threadId, pane: args.pane, cwd, model: snap.model, effort: snap.effort, instance, generation, token: crypto.randomUUID(), ...daemon, binary, bridge,
      excludedInboxIds: excludedInboxIds, ...((daemon as any).omp ? { omp: (daemon as any).omp } : {}) };
    atomicJson(join(clientDir, "context.json"), { token: saved.token, key: "lead", stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    writeFileSync(bridge, `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=lead exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`, { mode: 0o700 });
    const lead: Lane = { key: "lead", title: "Iyen current-session lead", role: "lead", thread: "none", brief: "", done: "", pane: args.pane, cwd, model: snap.model,
      openedAt: new Date().toISOString(), status: "working", dispatchBlocked: false, revision: previous?.revision,
      runtimeHistory: [...(previous?.runtimeHistory ?? []), ...(previous?.runtime ? [previous.runtime] : [])],
      runtime: { kind: this.config.runtime.kind, ...(saved.omp ? { omp: { kind: "omp" as const, target: saved.omp, attachmentInstanceId: instance, attachmentGeneration: generation, attachedAt: new Date().toISOString(), excludedInboxIds } } : {}), backend: "external-current-session", threadId: args.threadId, state: snap.state, activeTurnId: snap.activeTurnId,
        hostInstanceId: instance, generation, binaryVersion: daemon.binaryVersion, model: snap.model, effort: snap.effort, external: { socketPath: daemon.socketPath, binary, bridge } } };
    return { saved, lead };
  }
  private async lane(key: string): Promise<Lane> { if (!key || !LANE_KEY.test(key)) throw new Error("Invalid lane key"); const lane = await this.registry.read(key); if (!lane) throw new Error("Unknown lane"); return lane; }
  private async assertHostStopped(lane: Lane): Promise<void> {
    const path = bootstrapPath(this.config.stateDir, lane.key);
    if (existsSync(path)) {
      const prior = readJson<Bootstrap>(path);
      try { await ipc(hostSocket(this.config.stateDir, lane.key), prior.hostToken, "inspect", {}, 1000); throw new Error("Host already alive"); }
      catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
    }
    const pidFile = join(this.config.stateDir, "hosts", `${lane.key}.pid.json`);
    if (existsSync(pidFile)) { const { pid } = readJson<{ pid: number }>(pidFile); try { process.kill(pid, 0); throw new Error("Prior host process still exists; refuse second writer"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
    const backend = join(this.config.stateDir, "hosts", `${lane.key}.backend.json`);
    if (existsSync(backend)) {
      const { pid } = readJson<{ pid: number }>(backend);
      try { process.kill(pid, 0); throw new Error("Prior backend process still exists; refuse second writer"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    }
    if (isHcTerminal(lane.pane)) {
      const held = await this.runner(["herdr", "agent", "get", lane.pane]);
      if (held.code === 0 && JSON.parse(held.out).result.agent?.agent) throw new Error("A live TUI already owns this pane or thread");
    }
    const live = await this.runner(["herdr", "agent", "list"]);
    if (live.code !== 0) throw new Error("Cannot prove exclusive TUI ownership");
    const agents = JSON.parse(live.out).result.agents as { pane_id: string; agent_session?: { value: string } }[];
    if (agents.some(a => a.pane_id === lane.pane || (lane.runtime?.threadId && a.agent_session?.value === lane.runtime.threadId))) throw new Error("A live TUI already owns this pane or thread");
  }
  async boot(lane: Lane): Promise<void> {
    assertLaneRuntime(lane);
    if (this.config.runtime.kind !== "codex") throw new Error(`Lane ${lane.key}: OMP lanes were removed. Configure a Codex runtime to launch lanes.`);
    if (lane.key === "lead" || lane.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
    if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session boot is unsupported; use lead-attach");
    if (lane.runtime?.threadId && lane.runtime.kind !== this.config.runtime.kind) throw new Error("Runtime kind conversion is prohibited");
    if (!lane.pane) throw new Error("A Herdr pane is required");
    const pane = lane.pane;
    await this.assertHostStopped(lane);
    if (lane.runtime?.threadId && lane.runtime.backend !== "herdr-tui") throw new Error("Legacy private-RPC thread requires explicit recover --new-session --handoff-file; preserve its history");
    const path = bootstrapPath(this.config.stateDir, lane.key);
    if (!lane.runtime?.threadId && existsSync(path)) {
      const prior = readJson<Bootstrap>(path);
      const checkpointPath = join(this.config.stateDir, "hosts", `${lane.key}.runtime.json`);
      const checkpoint = existsSync(checkpointPath) ? readJson<{ instance: string; threadId?: string }>(checkpointPath) : undefined;
      if (!checkpoint?.threadId || checkpoint.instance !== prior.instance) throw new Error("Thread creation outcome unknown; inspect Codex history and recover with --thread-id ID");
      lane = await this.registry.update(lane.key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, threadId: checkpoint.threadId } }));
    }
    const instance = crypto.randomUUID();
    const boot: Bootstrap = { key: lane.key, role: lane.role ?? "lane", pane, instance, generation: (lane.runtime?.generation ?? 0) + 1, hostToken: crypto.randomUUID(), laneToken: crypto.randomUUID(), cwd: lane.cwd ?? this.config.defaultCwd, threadId: lane.runtime?.threadId, model: lane.model ?? lane.runtime?.model, effort: lane.effort ?? lane.runtime?.effort, blocked: Boolean(lane.dispatchBlocked), config: this.config };
    atomicJson(path, boot);
    const clientDir = join(this.config.stateDir, "clients", lane.key);
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    atomicJson(join(clientDir, "context.json"), { token: boot.laneToken, key: lane.key, stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    const wrapper = `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=${quoteForPane(lane.key)} exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`;
    writeFileSync(join(clientDir, "dori"), wrapper, { mode: 0o700 });
    await this.registry.update(lane.key, current => ({ ...current, runtime: { kind: this.config.runtime.kind, backend: "herdr-tui", threadId: boot.threadId, state: "starting", hostInstanceId: instance, generation: boot.generation, binaryVersion: this.config.runtime.requiredVersion, lastHeartbeatAt: new Date().toISOString() } }));
    const cli = resolve(import.meta.dir, "cli.ts");
    const launched = await this.runner([process.execPath, cli, "session-host-start", "--state-dir", this.config.stateDir, "--key", lane.key]);
    if (launched.code !== 0) throw new Error("Failed to start private backend host; intent retained");
  }
  async authorize(token: string): Promise<Caller> {
    const control = readJson<{ token: string }>(join(this.config.stateDir, "control.json"));
    if (token === control.token) return { role: "admin" };
    const pending = this.pendingHandoff();
    if (pending && pending.status !== "committed" && token === pending.beforeAttachment.token) return { role: "lead", key: "lead", instance: pending.beforeAttachment.instance };
    if (pending && pending.status !== "committed" && token === pending.afterAttachment.token) throw new Error("Forbidden");
    for (const lane of await this.registry.open()) {
      if (lane.runtime?.backend === "external-current-session") {
        if (!lane.runtime.external?.detachedAt && lane.runtime.state !== "stopped") {
          let saved: Attachment;
          try { saved = this.attachment(lane); } catch { continue; }
          if (token === saved.token) return { role: "lead", key: lane.key, instance: saved.instance };
        }
        continue;
      }
      if (lane.key === "lead" || lane.role === "lead") continue;
      const path = bootstrapPath(this.config.stateDir, lane.key);
      if (!existsSync(path)) continue;
      const boot = readJson<Bootstrap>(path);
      if (token === boot.hostToken) return { role: "host", key: lane.key };
      if (token === boot.laneToken) return { role: boot.role, key: lane.key };
    }
    throw new Error("Forbidden");
  }
  handle(action: string, args: any, caller: Caller): Promise<any> {
    return this.withIntake(() => this.handleScoped(action, args, caller));
  }
  private async handleScoped(action: string, args: any, caller: Caller): Promise<any> {
    if (!args || typeof args !== "object") throw new Error("Expected args object");
    if (this.leadRestarts.hasActive() && !["lead-restart", "lead-restart-status", "status", "health", "tick", "mail-list", "can-launch"].includes(action) &&
      (this.blocksPendingMutation(action, args, caller) || ["lead-handoff", "lead-activate", "approval-respond"].includes(action))) throw new Error("Lead restart incomplete; lead mutation held");
    if (this.stopping) throw new Error("Service stopping");
    if (action !== "lead-reconnect" && this.pendingHandoff() && this.blocksPendingMutation(action, args, caller)) throw new Error("Lead handoff incomplete; mutations are held until its recorded operation finishes");
    if (caller.instance) {
      const lead = await this.lane("lead");
      const pending = this.pendingHandoff();
      const instance = pending && pending.status !== "committed" ? pending.beforeAttachment.instance : this.attachment(lead).instance;
      if (caller.role !== "lead" || caller.key !== "lead" || instance !== caller.instance) throw new Error("Stale lead capability");
      if (pending && !["health", "status"].includes(action)) throw new Error("Lead handoff incomplete; dispatch held");
    }
    if (action === "health") {
      if (caller.role !== "admin" && !(caller.role === "lead" && caller.key === "lead" && caller.instance)) throw new Error("Health requires operator or current scoped lead capability");
      return this.health();
    }
    if (action === "lead-restart" || action === "lead-restart-status") {
      if (caller.role !== "admin" && !(caller.role === "lead" && caller.key === "lead" && caller.instance)) throw new Error("Restart requires operator or current attached lead capability");
      if (typeof args.operationId !== "string" || !args.operationId.trim() || args.operationId.length > 200 ||
        !exactKeys(args, action === "lead-restart" ? ["operationId", "sourceMessageId"] : ["operationId"])) throw new Error("Exact bounded restart operation/source arguments required");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", async () => {
        if (action === "lead-restart-status") return this.leadRestarts.reconcile(args.operationId);
        if (typeof args.sourceMessageId !== "string" || !args.sourceMessageId.trim() || args.sourceMessageId.length > 512) throw new Error("Original bounded owner sourceMessageId required");
        const prior = this.leadRestarts.get(args.operationId);
        if (prior) {
          if (prior.authorization.sourceMessageId !== args.sourceMessageId) throw new Error("Restart operationId reused with changed source");
          const source = this.inbox.get(prior.authorization.mail.id);
          if (!sameJson(source, prior.authorization.mail) || !this.config.ingress.some(i => i.id === prior.authorization.source && i.owners.includes(prior.authorization.owner))) throw new Error("Restart original owner source changed");
          return this.leadRestarts.reconcile(args.operationId);
        }
        this.assertNoPendingLeadMutation();
        return this.acceptLeadRestart(args.operationId, args.sourceMessageId);
      }));
    }
    if (action === "lead-reconnect") {
      if (caller.role !== "admin") throw new Error("lead-reconnect requires operator capability");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => this.reconnectLead(args)));
    }
    if (action === "lead-activate") {
      if (caller.role !== "admin") throw new Error("lead-activate requires operator capability");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => this.activateLead(args)));
    }
    if (action === "lead-handoff-preview" || action === "lead-handoff") {
      if (caller.role !== "admin") throw new Error("Lead handoff requires operator capability");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => action === "lead-handoff-preview" ? this.previewHandoff(args) : this.applyHandoff(args)));
    }
    if (["lead-attach", "lead", "lead-detach"].includes(action) && this.pendingHandoff()) throw new Error("Recorded handoff is incomplete; retry its operationId first");
    if (action === "lead-attach" || action === "lead") {
      if (caller.role !== "admin") throw new Error("lead-attach requires operator capability");
      if (action === "lead" && (!args.threadId || !args.pane || !args.cwd)) throw new Error("Start Iyen in this session with lead-attach --thread-id UUID --pane ID --cwd DIR");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => { this.assertNoPendingLeadMutation(); return this.attachLead(args); }));
    }
    if (action === "lead-detach") {
      if (caller.role !== "admin" && !(caller.role === "lead" && caller.key === "lead" && caller.instance)) throw new Error("lead-detach requires operator or current attached lead capability");
      if (typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId)) throw new Error("lead-detach requires expected UUID thread-id");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", async () => {
        this.assertNoPendingLeadMutation();
        const lane = await this.lane("lead");
        if (lane.runtime?.backend !== "external-current-session" || lane.runtime.threadId !== args.threadId || (caller.instance && caller.instance !== lane.runtime.hostInstanceId)) throw new Error("lead-detach expected session mismatch");
        await this.registry.update("lead", current => ({ ...current, dispatchBlocked: true, runtime: { ...current.runtime!, held: true, state: "stopped", activeTurnId: undefined,
          external: { ...current.runtime!.external!, detachedAt: current.runtime!.external?.detachedAt ?? new Date().toISOString() } } }));
        return { detached: true, threadId: args.threadId };
      }));
    }
    if (action.startsWith("host-")) {
      if (caller.role !== "host" || caller.key !== args.key) throw new Error("Forbidden host identity");
      const lane = await this.lane(args.key);
      assertLaneRuntime(lane);
      if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session cannot register a managed host");
      if (!lane.runtime || lane.runtime.hostInstanceId !== args.instance || args.runtime?.hostInstanceId !== args.instance || args.runtime?.generation !== lane.runtime.generation) throw new Error("Stale host generation");
      if (lane.retirement) return { accepted: false, retired: true };
      if (action === "host-starting") {
        // A startup liveness pulse is not thread registration or permission to
        // dispatch. It may only refresh the exact generation's startup lease.
        if (lane.role === "lead" || lane.runtime.kind !== "codex" || lane.runtime.backend !== "herdr-tui" ||
          lane.runtime.state !== "starting" || args.runtime.kind !== "codex" || args.runtime.backend !== "herdr-tui" ||
          args.runtime.state !== "starting" || args.runtime.threadId !== lane.runtime.threadId || args.pane !== lane.pane)
          throw new Error("Invalid startup identity");
        await this.registry.update(lane.key, current => ({ ...current, runtime: { ...current.runtime!, lastHeartbeatAt: new Date().toISOString() } }));
        return { accepted: true };
      }
      if (lane.runtime.threadId && lane.runtime.threadId !== args.runtime.threadId) throw new Error("Thread identity mismatch");
      if (!args.runtime.threadId || args.runtime.kind !== lane.runtime.kind || args.runtime.kind !== this.config.runtime.kind) throw new Error("Invalid runtime identity");
      if (action === "host-register") atomicJson(join(this.config.stateDir, "hosts", `${lane.key}.pid.json`), { pid: args.pid, instance: args.instance });
      await this.registry.update(lane.key, l => ({ ...l,
        ...(args.runtime.held && !l.dispatchBlocked ? { dispatchBlocked: true, holdReason: "recovery" as const } : {}),
        runtime: { ...args.runtime as RuntimeRef, lastHeartbeatAt: new Date().toISOString() } }));
      if (lane.runtime.kind === "codex" && action === "host-event" && args.event?.id !== undefined) {
        const id = args.event.method === "tui/inputRequired" ? `${lane.key}:${args.event.id}` : `${args.instance}:${args.event.id}`;
        this.outbox.put({ id: `approval:${id}`, target: lane.thread, text: JSON.stringify({ lane: lane.key, id, method: args.event.method, params: args.event.params }), state: "queued", at: new Date().toISOString() });
        this.putInbox({ id: `approval-notice:${id}`, target: "lead", text: `Approval or input required for ${lane.key}. Inspect dori approval list. ID: ${id}`, state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "runtime/disconnected" && lane.role !== "lead") {
        this.putInbox({ id: `runtime-failed:${lane.key}:${args.instance}`, target: "lead", text: `Runtime failed for ${lane.key}. Inspect status and reconcile unknown operations before recover.`, state: "queued", at: new Date().toISOString() });
      }
      if (lane.runtime.kind === "codex" && action === "host-event" && args.event?.method === "turn/completed" && args.event.params?.turn?.status === "failed") {
        const turnId = args.event.params.turn.id;
        if (typeof turnId !== "string" || !turnId || (args.event.params.threadId && args.event.params.threadId !== lane.runtime.threadId)) throw new Error("Invalid failed turn identity");
        this.putFailure({ id: `failed-turn:${lane.key}:${args.instance}:${turnId}`, target: lane.key, turnId, source: args.instance,
          text: JSON.stringify(turnFailure(args.event.params.turn.error)), state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "serverRequest/resolved") {
        const id = `approval:${args.instance}:${args.event.params.requestId}`;
        if (this.outbox.get(id)) this.outbox.mark(id, { state: "sent" });
      }
      if (action === "host-event" && args.event?.method === "tui/inputResolved") {
        const id = `approval:${lane.key}:${args.event.params.requestId}`;
        if (this.outbox.get(id)) this.outbox.mark(id, { state: "sent" });
      }
      return { accepted: true };
    }
    if (caller.role === "host") throw new Error("Host cannot issue user commands");
    const key = args.key ?? caller.key;
    if (key && action !== "status" && action !== "checkpoint-list" && action !== "close") {
      const registered = await this.registry.read(key);
      if (registered) assertLaneRuntime(registered);
    }
    if (caller.role === "lane" && (!(["report", "claim-done", "status", "checkpoint-record", "checkpoint-list", "lesson-add", "lesson-list"].includes(action)) || key !== caller.key)) throw new Error("Lane capability does not authorize this command");
    if (key && key !== "lead" && action !== "status" && action !== "close" && (await this.registry.read(key))?.retirement)
      throw new Error("Retired lane cannot accept new work; use a new lane key");
    if (["pause", "resume", "close", "recover", "reopen", "claim-done", "object-done"].includes(action) && (await this.registry.read(key))?.runtime?.backend === "external-current-session") throw new Error(`External current-session ${action} is unsupported; use lead-detach`);
    if (action.startsWith("worklog-")) {
      if (caller.role !== "lead" && caller.role !== "admin") throw new Error("Worklog requires lead or operator");
      this.assertNoPendingLeadMutation();
      const log = new RequestWorklog(this.config.stateDir, this.deps.clock);
      if (action === "worklog-list") return log.list();
      if (action === "worklog-show") return log.read(args.requestId);
      if (action === "worklog-render") return { markdown: log.render() };
      if (action === "worklog-record") return log.record(args.eventId, args);
      if (action === "worklog-update") return log.update(args.eventId, args.requestId, args.patch);
      throw new Error("Unknown worklog operation");
    }
    if (action === "checkpoint-record" || action === "checkpoint-list") {
      const lane = await this.lane(key), checkpoints = new Checkpoints(this.config.stateDir, this.deps.clock);
      return action === "checkpoint-list" ? checkpoints.list(key) : checkpoints.record(lane, args);
    }
    if (action === "lesson-add" || action === "lesson-list") {
      const lane = args.key || caller.role === "lane" ? await this.lane(key) : undefined;
      // A worker cannot select another repository or write to arbitrary files.
      const repository = lane?.repository ?? lane?.cwd ?? (caller.role !== "lane" ? args.repository : undefined);
      if (!repository || args.repository && lessonRepository(args.repository) !== lessonRepository(repository)) throw new Error("Lesson repository scope mismatch");
      const lessons = new Lessons(this.config.stateDir, repository, this.deps.clock);
      return action === "lesson-list" ? lessons.list() : lessons.add(args.eventId, args.text, args.evidence);
    }
    if (["work-start", "work-stop", "work-similar"].includes(action)) {
      if (caller.role !== "lead" && caller.role !== "admin") throw new Error("Work timers require lead or operator");
      const timers = new WorkTimers(this.config.stateDir, this.deps.clock);
      const tags = args.tags ?? [];
      if (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== "string")) throw new Error("tags must be strings");
      if (args.title !== undefined && typeof args.title !== "string") throw new Error("title must be a string");
      if (args.thread !== undefined && typeof args.thread !== "string") throw new Error("thread must be a string");
      const workThresholdSec = this.config.workThresholdSec;
      if (action === "work-similar") return { workThresholdSec, matches: await timers.similar(args.title, tags) };
      if (action === "work-start") {
        if (typeof args.title !== "string" || typeof args.operationId !== "string") throw new Error("title and UUID operationId required");
        return this.workQueue.run(args.operationId, async () => ({ workThresholdSec, work: await timers.start(args.title, tags, args.thread, args.operationId) }));
      }
      if (typeof args.id !== "string") throw new Error("work id required");
      return this.workQueue.run(args.id, async () => ({ workThresholdSec, work: await timers.stop(args.id) }));
    }
    if (action === "status") return key ? this.publicLane(await this.lane(key)) : Promise.all((await this.registry.list()).map(lane => this.publicLane(lane)));
    if (action === "input-status") {
      if (caller.role !== "lead" || caller.key !== "lead" || !caller.instance || typeof key !== "string" || !key) throw new Error("Input receipt lookup requires the current scoped lead capability");
      if (args.text !== undefined && (typeof args.text !== "string" || !args.text) || typeof args.operationId !== "string" || !args.operationId) throw new Error("operationId and optional exact text required");
      const lane = await this.lane(key);
      const instance = key === "lead" ? caller.instance : lane.runtime?.hostInstanceId;
      if (!instance) throw new Error("Input receipt native attachment missing");
      return this.dispatchQueue.run(key, () => this.reconcileOmpInput(key, args.text, args.operationId, instance));
    }
    if (action === "can-launch") return canLaunch(await sampleHost(this.runner), this.config.guard);
    if (action === "launch") {
      if (key === "lead" || args.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
      const id = args.operationId;
      if (!id || typeof id !== "string") throw new Error("operationId required");
      return this.launchQueue.run(key, async () => {
        if ((await this.registry.read(key))?.runtime?.backend === "external-current-session") throw new Error("Attached lead cannot be launched; use lead-attach");
        const mail = this.operations.put({ id, target: key, text: JSON.stringify(args), state: "queued", at: new Date().toISOString() });
        if (mail.state === "sent") return { lane: await this.lane(key), startup: `STARTUP_OK ${key} (recorded)` };
        if (mail.state !== "queued") throw new Error("Launch outcome unknown; inspect status, do not replay");
        // Legacy queued HOLD intents can lack today's explicit model/effort.
        // Validate before any attempted mutation; preserve their exact stable payload.
        try { await validateLaunch(this.deps, args as LaunchInput); }
        catch (error) {
          this.operations.mark(id, { metadata: { type: "launch-preflight-rejection", attempted: false } });
          throw new LaunchError(`${error instanceof Error ? error.message : "Launch preflight refused"}; unattempted intent retained. Use a new operation ID for a corrected payload`);
        }
        this.operations.mark(id, { state: "sending" });
        try {
          const result = await launchLane(this.deps, args as LaunchInput, l => this.boot(l));
          this.operations.mark(id, { state: result.startup.startsWith("STARTUP_OK") ? "sent" : "unknown" }); return result;
        } catch (error) {
          if (error instanceof LaunchError && error.exitCode === 4) { this.operations.mark(id, { state: "queued" }); return { held: true, reasons: error.message, code: 4 }; }
          this.operations.mark(id, { state: "unknown" }); throw error;
        }
      });
    }
    if (action === "adopt") {
      if (this.config.runtime.kind === "omp") throw new LaunchError("OMP lanes were removed; configure a Codex runtime to adopt lanes");
      if (!args.threadId || args.transferConfirmed !== true) throw new Error("adopt requires thread-id and confirmed exclusive ownership transfer");
      await validateLaunch(this.deps, args, false);
      const lane: Lane = { key, title: args.title, thread: args.thread ?? "none", brief: args.brief, done: args.done, pane: args.pane, cwd: args.cwd ?? this.config.defaultCwd, role: "lane", model: args.model, effort: args.effort, openedAt: new Date().toISOString(), status: "paused", pausedFrom: "working", dispatchBlocked: true, holdReason: "owner-pause", runtime: { kind: "codex", threadId: args.threadId, hostInstanceId: "", generation: 0, state: "stopped", binaryVersion: this.config.runtime.requiredVersion } };
      await this.registry.write(lane); await this.boot((await this.lane(key))); return this.lane(key);
    }
    if (action === "pause") return pauseLane(this.deps, await this.lane(key), args.note ?? "Owner requested pause");
    if (action === "resume") return resumeLane(this.deps, await this.lane(key), args.note ?? "Owner requested resume");
    if (action === "claim-done") {
      if (!args.evidence?.trim()) throw new Error("Evidence required");
      return claimDone(this.deps, await this.lane(key), args.evidence);
    }
    if (action === "object-done") {
      if (!Array.isArray(args.reasons) || !args.reasons.length) throw new Error("Reasons required");
      return objectDone(this.deps, await this.lane(key), args.reasons);
    }
    if (action === "close") return closeLane(this.deps, await this.lane(key), args.note ?? "Closed by lead");
    if (action === "input") {
      if (!args.text || !args.operationId) throw new Error("text and operationId required");
      const lane = await this.lane(key);
      const mail = this.putInbox({ id: args.operationId, target: key, text: args.text, thread: args.thread ?? lane.thread, state: "queued", at: new Date().toISOString(),
        attachmentInstance: lane.runtime?.backend === "external-current-session" ? caller.instance ?? this.intakeInstance(lane) : undefined });
      if (mail.state === "unknown" || mail.state === "sending") throw new Error("Delivery unknown; reconcile before retry");
      if (mail.state === "abandoned" || mail.abandonment) throw new Error("Input abandonment fences delivery; never replay");
      if (mail.state === "sent") {
        if (!mail.turnId) throw new Error("Missing turn receipt");
        return { turnId: mail.turnId, ...(mail.receiptKind ? { receiptKind: mail.receiptKind, receipt: mail.receipt } : {}) };
      }
      if (lane.dispatchBlocked) return { queued: true, operationId: mail.id };
      try { return await this.deps.runtime.input(key, args.text, args.operationId); }
      catch (error) { if (error instanceof DeliveryDeferred) return { queued: true, operationId: mail.id }; throw error; }
    }
    if (action === "report") {
      await recordReport(this.registry, mail => this.putInbox(mail), { ...args, key });
      return { recorded: true };
    }
    if (action === "reply") {
      if (!args.thread || !args.text || !args.operationId || !this.config.hooks.threadReply) throw new Error("thread, text, operationId and threadReply hook required");
      await this.deps.post!(args.operationId, this.config.hooks.threadReply, { key: key ?? "lead", thread: args.thread, text: args.text }); return { sent: true };
    }
    if (action === "sync") return syncRegistry(this.deps, Boolean(args.write));
    if (action === "approval-list") return this.approvals();
    if (action === "approval-respond") {
      if (caller.role === "lead") {
        if (caller.key !== "lead" || !caller.instance || typeof args.id !== "string" || !args.id.startsWith("iyen-") ||
          typeof args.sourceMessageId !== "string" || !args.sourceMessageId) throw new Error("Current attached lead native response requires original owner source-message-id");
        const scope = this.attachment(await this.lane("lead"));
        return withBindingFence(this.config.stateDir, async () => {
          const assertCurrent = async () => {
            this.assertNoPendingLeadMutation();
            const lead = await this.lane("lead"), current = this.attachment(lead);
            if (current.instance !== scope.instance || current.generation !== scope.generation || lead.dispatchBlocked ||
              lead.runtime?.held || lead.runtime?.external?.detachedAt || lead.runtime?.state === "stopped") throw new Error("Lead response scope changed or held");
          };
          await assertCurrent();
          const result = await this.nativeInteractions.respondFromLead(args.id, args.response, args.sourceMessageId);
          await assertCurrent();
          return result;
        });
      }
      if (caller.role !== "admin") throw new Error("Approval requires the authenticated owner control channel");
      if (typeof args.id === "string" && args.id.startsWith("native-blocked:")) throw new Error("Native owner/thread binding unresolved; this diagnostic is not an answer token");
      if (typeof args.id === "string" && args.id.startsWith("iyen-")) {
        if (typeof args.operationId !== "string" || !args.operationId) throw new Error("Native approval response requires stable --operation-id");
        return this.nativeInteractions.respondOperator(args.id, args.response, args.operationId);
      }
      const approvals = await this.approvals(); const selected = approvals.find(a => a.id === args.id);
      if (!selected) throw new Error("Expired approval");
      const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, selected.key));
      return ipc(hostSocket(this.config.stateDir, selected.key), boot.hostToken, "approval", { id: selected.requestId, response: args.response });
    }
    if (action === "mail-list") return { inbox: this.inbox.list(), outbox: this.outbox.list(), operations: this.operations.list(), failures: this.failures.list(), nativeResponses: this.nativeInteractions.responseHistory() };
    if (action === "mail-resolve") {
      if (caller.role !== "admin" || !["sent", "queued"].includes(args.state) || !args.evidence) throw new Error("Explicit reconciliation evidence required");
      const box = args.box === "inbox" ? this.inbox : args.box === "outbox" ? this.outbox : undefined;
      if (!box || box.get(args.id)?.state !== "unknown") throw new Error("Only unknown mail can be reconciled");
      const row = box.get(args.id)!;
      const lane = await this.registry.read(row.target);
      if (lane) assertLaneRuntime(lane);
      if (box === this.inbox && (row.ompProvenance || lane?.runtime?.kind === "omp" || this.config.runtime.kind === "omp")) {
        if (lane?.runtime?.kind !== "omp") throw new Error("OMP current native attachment missing; delivery remains unknown");
        const epoch = lane.runtime.hostInstanceId, generation = lane.runtime.generation;
        if (args.state !== "sent") throw new Error("OMP uncertain delivery cannot be replayed");
        const provenance = row.ompProvenance;
        if (!provenance || !provenance.target || row.attachmentInstance !== provenance.attachmentInstanceId || !Number.isSafeInteger(provenance.attachmentGeneration) || provenance.attachmentGeneration < 1) throw new Error("OMP native operation provenance missing; delivery remains unknown");
        const target = provenance.target;
        const assertCurrent = (current: Lane): void => {
          const runtime = current.runtime;
          if (runtime?.kind !== "omp" || runtime.hostInstanceId !== epoch || runtime.generation !== generation || runtime.state === "stopped" || runtime.external?.detachedAt || runtime.omp?.detachedAt || statusOf(current) === "closed" || !runtime.omp || !sameOmpTarget(runtime.omp.target, target) || current.cleanupFence || current.key === "lead" && this.pendingHandoff()) throw new Error("OMP attachment detached, pending or changed during reconciliation");
          if (runtime.backend === "external-current-session" && (provenance.attachmentInstanceId !== epoch || provenance.attachmentGeneration !== generation)) throw new Error("OMP borrowed receipt belongs to a previous attachment");
          if (target.laneKey !== current.key || target.role !== "attached-lead") throw new Error("OMP provenance lane mismatch");
        };
        assertCurrent(lane);
        const capturedRow = JSON.stringify(row);
        // Query the originally recorded native controller, even after a host-only
        // epoch rotation. No submission or alternate target is permitted here.
        const op = await callOmp(target, "operation", { operationId: row.id, text: row.text }, this.config, this.runner);
        if (op.status !== "received" || !validReceipt(op.receipt, target, row.id, payloadHash(row.text))) throw new Error("OMP exact durable receipt unavailable; delivery remains unknown");
        return withBindingFence(this.config.stateDir, async () => {
          const current = await this.lane(row.target);
          assertCurrent(current);
          const latest = box.get(row.id);
          if (!latest || latest.state !== "unknown" || JSON.stringify(latest) !== capturedRow) throw new Error("OMP mail changed during reconciliation");
          return box.mark(row.id, { state: "sent", turnId: op.receipt.receiptId, receiptKind: "omp-session-entry", receipt: op.receipt });
        });
      }
      return box.mark(args.id, { state: args.state, source: `reconciled: ${args.evidence}` });
    }
    if (action === "reopen" || action === "recover") {
      if (key === "lead" || (await this.registry.read(key))?.role === "lead") throw new Error("Managed lead recovery is unsupported; use lead-attach for the current session");
      return this.launchQueue.run(key, () => this.dispatchQueue.run(key, async () => {
        let lane = await this.lane(key);
        if (action === "reopen" && statusOf(lane) !== "closed") throw new Error("Lane is not closed");
        if (action === "recover" && statusOf(lane) === "closed") throw new Error("Use reopen for closed lanes");
        await this.assertHostStopped(lane);
        if (args.newSession) {
          if (caller.role !== "admin" || typeof args.handoff !== "string" || !args.handoff.trim() || !lane.runtime?.threadId) throw new Error("New-session migration requires operator, known old thread and explicit handoff");
          const archive = join(this.config.stateDir, "hosts", "history", `${key}-${lane.runtime.generation}-${lane.runtime.threadId}`);
          mkdirSync(archive, { recursive: true, mode: 0o700 });
          for (const suffix of [".json", ".runtime.json", ".pid.json", ".backend.json"]) {
            const file = join(this.config.stateDir, "hosts", `${key}${suffix}`);
            if (existsSync(file)) { writeFileSync(join(archive, `${key}${suffix}`), readFileSync(file), { mode: 0o600 }); unlinkSync(file); }
          }
          writeFileSync(join(archive, "handoff.md"), args.handoff, { mode: 0o600 });
          lane = await this.registry.update(key, l => ({ ...l, runtimeHistory: [...(l.runtimeHistory ?? []), l.runtime!], runtime: { ...l.runtime!, backend: "herdr-tui", threadId: undefined, activeTurnId: undefined, state: "stopped" }, dispatchBlocked: true, holdReason: "recovery" }));
          args.text = `Runtime migration from preserved thread ${lane.runtimeHistory!.at(-1)!.threadId}. History and handoff: ${archive}.\n${args.handoff}\nReconcile uncertain side effects; do not replay old tasks.`;
        }
        if (args.threadId) {
          if (lane.runtime?.threadId && lane.runtime.threadId !== args.threadId) throw new Error("Refusing to replace a known thread identity");
          lane = await this.registry.update(key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, threadId: args.threadId } }));
        }
        if (action === "recover") lane = await this.registry.update(key, l => ({ ...l, dispatchBlocked: true, holdReason: l.holdReason ?? "recovery" }));
        if (lane.cwd && !existsSync(lane.cwd)) {
          const saved = lane.resumeRefs?.[lane.cwd];
          if (!saved || !lane.repository || !lane.worktrees?.includes(lane.cwd)) throw new Error("Missing cwd has no owned resume point; restore it before reopening");
          const branchExists = saved.branch ? await this.runner(["git", "-C", lane.repository, "show-ref", "--verify", `refs/heads/${saved.branch}`]) : null;
          const argv = branchExists?.code === 0 ? ["git", "-C", lane.repository, "worktree", "add", lane.cwd, saved.branch!] : ["git", "-C", lane.repository, "worktree", "add", "-b", `dori/${key}-cycle-${(lane.cycle ?? 1) + 1}`, lane.cwd, saved.sha];
          if ((await this.runner(argv)).code !== 0) throw new Error("Cannot restore owned worktree; inspect repository");
        }
        if (action === "reopen") lane = await this.registry.update(key, l => withStatus(l, "working", "Reopened", new Date().toISOString(), { cycle: (l.cycle ?? 1) + 1, closedAt: undefined, claim: undefined, objection: undefined, cleanupFence: undefined, dispatchBlocked: false, holdReason: undefined }));
        const terminal = await createLaneTerminal(this.runner, key, lane.cwd ?? this.config.defaultCwd);
        lane = await this.registry.update(key, l => ({ ...l, pane: terminal, tab: undefined, hcTerminal: terminal }));
        await this.boot(lane);
        const text = args.text ?? (!lane.runtime?.threadId ? await Bun.file(lane.brief).text() : undefined);
        if (text) this.putInbox({ id: args.operationId ?? `handoff:${key}:${lane.cycle ?? 1}`, target: key, text, state: "queued", at: new Date().toISOString() });
        return { recovering: true, key };
      }));
    }
    if (action === "tick") { await this.tick(); return { accepted: true }; }
    throw new Error(`Unknown service action: ${action}`);
  }
  async approvals(): Promise<{ id: string; key: string; requestId: string; request: unknown; relayBlocked?: string }[]> {
    const result: { id: string; key: string; requestId: string; request: unknown; relayBlocked?: string }[] = [];
    for (const lane of await this.registry.open()) {
      if (lane.runtime?.kind === "omp") continue;
      if (!lane.runtime?.threadId || lane.runtime.backend === "external-current-session") continue;
      try {
        const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, lane.key));
        const requests = await ipc<{ id: string; request: unknown }[]>(hostSocket(this.config.stateDir, lane.key), boot.hostToken, "approvals", {}, 1000);
        result.push(...requests.map(r => ({ id: `${boot.instance}:${r.id}`, key: lane.key, requestId: r.id, request: r.request })));
      } catch { /* disconnected requests cannot be answered */ }
    }
    await this.nativeInteractions.poll();
    result.push(...this.nativeInteractions.list().map(row => ({ id: row.token, key: row.key, requestId: row.request.id, request: row.request })));
    result.push(...this.nativeInteractions.unrouted().map(row => ({ id: `native-blocked:${row.key}:${row.request.id}`,
      key: row.key, requestId: row.request.id, request: row.request, relayBlocked: row.reason })));
    return result;
  }
  notifyFailures(): Promise<void> { return this.withIntake(() => this.notifyFailuresScoped()); }
  private async notifyFailuresScoped(): Promise<void> {
    for (const failure of this.failures.list().filter(row => row.state === "queued")) {
      await this.failureQueue.run(failure.id, async () => {
        if (this.failures.get(failure.id)?.state !== "queued") return;
        const lane = await this.lane(failure.target);
        if (failure.attachmentInstance && (lane.runtime?.backend !== "external-current-session" || lane.runtime.hostInstanceId !== failure.attachmentInstance)) return;
        const metadata = JSON.parse(failure.text) as ReturnType<typeof turnFailure> & { runtime?: string; phase?: string };
        const label = metadata.runtime === "omp" ? `OMP ${metadata.phase === "compaction" ? "compaction" : "model"}` : "Codex task";
        const text = `${label} failed (${metadata.category}). ${metadata.guidance} The task was not automatically retried.`;
        if (lane.role !== "lead") {
          this.putInbox({ id: `notice:${failure.id}`, target: "lead", attachmentInstance: (failure as OwnedFailure).leadIntakeInstance ?? UNOWNED_LEAD, thread: lane.thread, text: `Lane ${lane.key}: ${text}`, state: "queued", at: failure.at });
        } else {
          // Completion notifications can precede the input RPC receipt. Keep the failure
          // pending until a sent receipt associates that turn with its owner thread.
          const threads = [...new Set(this.inbox.list().filter(row => row.target === lane.key && row.state === "sent" && row.turnId === failure.turnId &&
            (!failure.attachmentInstance || row.attachmentInstance === failure.attachmentInstance)).map(row => row.thread).filter((thread): thread is string => Boolean(thread && thread !== "none")))];
          if (!threads.length) return;
          for (const thread of threads) {
            const id = `notice:${failure.id}:${thread}`;
            this.outbox.put({ id, target: thread, text, state: "queued", at: failure.at });
            if (this.config.hooks.threadReply) {
              // postHook preserves unknown outcomes and never blindly replays them.
              try { await this.deps.post!(id, this.config.hooks.threadReply, { key: lane.key, thread, text }); } catch { /* visible in outbox */ }
            }
          }
        }
        this.failures.mark(failure.id, { state: "sent" });
      });
    }
  }
  receive(source: string, event: any): Promise<void> { return this.withIntake(() => this.receiveScoped(source, event)); }
  private async receiveScoped(source: string, event: any): Promise<void> {
    const ingress = this.config.ingress.find(i => i.id === source);
    if (!ingress || !ingress.owners.includes(event.user) || !event.id || !event.thread || typeof event.text !== "string") throw new Error("Untrusted or incomplete inbound event");
    const id = `inbound:${source}:${event.thread}:${event.id}`;
    const previous = this.inbox.get(id);
    if (previous?.target === "owner-control" && !event.control) {
      // Preserve historical accepted targets; never replay a rejected old answer.
      return;
    }
    const known = (await this.registry.list()).find(l => l.thread === event.thread && l.role !== "lead");
    if (event.control) {
      const allowed = ["pause", "resume", "object-done", "approval-respond"];
      if (!allowed.includes(event.control.action)) throw new Error("Unsupported inbound control");
      if (event.control.action === "approval-respond") {
        if (typeof event.control.args?.id === "string" && event.control.args.id.startsWith("iyen-")) throw new Error("Native responses require lead mediation of the authenticated original owner message");
        const request = (await this.approvals()).find(a => a.id === event.control.args?.id);
        if (!request || (await this.lane(request.key)).thread !== event.thread) throw new Error("Approval belongs to another thread");
      } else if (!known || event.control.args?.key !== known.key) throw new Error("Control belongs to another lane");
      this.putInbox({ id, target: "owner-control", text: JSON.stringify(event.control), source, thread: event.thread, state: "queued", at: new Date().toISOString() });
      this.ingressHealth.set(source, { process: this.ingressHealth.get(source)?.process ?? "starting", lastAcceptedAt: new Date().toISOString() });
      await this.inbox.deliver(id, async () => { await this.handle(event.control.action, event.control.args, { role: "admin" }); return {}; });
      return;
    }
    // A lane's thread is its report destination, not ownership of owner input.
    // Preserve accepted delivery targets across retries; never relabel unknown work.
    const target = previous?.target ?? "lead";
    const intakeLane = target === "lead" ? await this.registry.read("lead") : null;
    const envelope = `Owner message in ${event.thread}${known && statusOf(known) === "closed" ? ` (closed lane ${known.key}; reopen if appropriate)` : ""}:`;
    // Retries of pre-metadata intake must retain the original operation text,
    // including when its delivery is uncertain. New events carry the source ID.
    const text = previous?.text === `${envelope}\n${event.text}` ? previous.text : `${envelope}\nSource message ID: ${event.id}\n${event.text}`;
    this.putInbox({ id, target, attachmentInstance: this.intakeInstance(intakeLane), thread: event.thread, text, source, sourceMessageId: event.id,
      ownerUser: event.user, ...(event.metadata !== undefined ? { metadata: event.metadata } : {}), state: "queued", at: new Date().toISOString() });
    this.ingressHealth.set(source, { process: this.ingressHealth.get(source)?.process ?? "starting", lastAcceptedAt: new Date().toISOString() });
  }
  tick(): Promise<void> { return this.withIntake(() => this.tickScoped()); }
  private async tickScoped(): Promise<void> {
    if (this.leadRestarts.hasActive()) {
      await this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => this.leadRestarts.tick()));
      await this.health(); return;
    }
    if (this.pendingHandoff()) {
      await this.deps.runtime.inspect("lead").catch(() => {}); await this.health(); return;
    }
    const once = async (name: string, fn: () => Promise<unknown>) => {
      const interval = ["inbox", "failures", "external-observation", "native-interactions"].includes(name) ? 1000 : name === "done" ? 30000 : 60000;
      if (this.ticks.has(name) || Date.now() - (this.lastTick.get(name) ?? 0) < interval) return;
      this.lastTick.set(name, Date.now()); this.ticks.add(name);
      try { await fn(); } catch { console.error(`MONITOR_ERROR ${name}`); } finally { this.ticks.delete(name); }
    };
    await Promise.all([
      once("native-interactions", () => this.nativeInteractions.poll()),
      once("external-observation", async () => {
        const lead = await this.registry.read("lead");
        if (lead?.runtime?.backend === "external-current-session" && lead.runtime.state !== "stopped" && !lead.runtime.external?.detachedAt) await this.deps.runtime.inspect(lead.key).catch(() => {});
      }),
      once("failures", () => this.notifyFailures()),
      once("done", () => watchTick(this.deps).then(lines => lines.forEach(l => console.log(l)))),
      once("freshness", () => freshnessTick(this.deps, process.env.HOME ?? "")),
      once("supervision", () => supervisionTick(this.deps, mail => this.putInbox(mail))),
      once("runtime-health", async () => {
        for (const lane of await this.registry.open()) {
          if (isRemovedOmpLane(lane) || !lane.runtime || lane.runtime.state === "stopped" || lane.cleanupFence) continue;
          if (lane.runtime.backend === "external-current-session") continue;
          const age = Date.now() - Date.parse(lane.runtime.lastHeartbeatAt ?? lane.openedAt);
          const timeout = lane.runtime.state === "starting" ? Math.max(this.config.runtime.heartbeatTimeoutMs, this.config.runtime.startupTimeoutMs + 10_000) : this.config.runtime.heartbeatTimeoutMs;
          if (age <= timeout || lane.holdReason === "recovery") continue;
          await this.registry.update(lane.key, l => ({ ...l, dispatchBlocked: true, holdReason: l.holdReason ?? "recovery", runtime: l.runtime && { ...l.runtime, state: "recovering" } }));
          if (lane.role !== "lead") this.putInbox({ id: `host-unreachable:${lane.key}:${lane.runtime.hostInstanceId}`, target: "lead", text: `Host unreachable for ${lane.key}; dispatch held. Reconcile before recovery.`, state: "queued", at: new Date().toISOString() });
        }
      }),
      once("inbox", async () => {
        for (const row of this.inbox.list().filter(r => r.state === "queued" && !r.abandonment)) {
          const lane = await this.registry.read(row.target);
          if (!lane || lane.dispatchBlocked || statusOf(lane) === "closed") continue;
          if (lane.runtime?.backend === "external-current-session" && row.attachmentInstance && row.attachmentInstance !== lane.runtime.hostInstanceId) continue;
          if (lane.runtime?.backend === "external-current-session" && this.attachment(lane).excludedInboxIds.includes(row.id)) continue;
          const snapshot = await this.deps.runtime.inspect(lane.key).catch(() => null);
          if (!snapshot || !["idle", "running"].includes(snapshot.state)) continue;
          await this.deps.runtime.input(lane.key, row.text, row.id).catch(() => {});
        }
      }),
    ]);
    await this.health();
  }
  stop(): void { this.stopping = true; this.setPhase("stopping"); }
}

/** Keep the service lock and intake alive until producers exit and accepted frames drain. */
export const drainIngress = async (children: readonly ReturnType<typeof Bun.spawn>[], readers: readonly Promise<void>[], timeoutMs = 2000): Promise<void> => {
  const settled = Promise.allSettled([...children.map(child => child.exited), ...readers]);
  const wait = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([settled.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
  if (await wait()) return;
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  if (!await wait()) throw new Error("Ingress shutdown drain incomplete; service ownership retained");
};

const serveService = async (config: DoriConfig): Promise<void> => {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); chmodSync(config.stateDir, 0o700);
  const socket = serviceSocket(config.stateDir), lockPath = join(config.stateDir, "service.lock");
  if (existsSync(lockPath)) {
    const old = readJson<{ pid: number }>(lockPath);
    try { process.kill(old.pid, 0); throw new Error("Dori service owner still exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    unlinkSync(lockPath);
  }
  const instance = crypto.randomUUID(); const fd = openSync(lockPath, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, instance })); closeSync(fd);
  const controlPath = join(config.stateDir, "control.json");
  if (!existsSync(controlPath)) atomicJson(controlPath, { token: crypto.randomUUID() });
  if (existsSync(socket)) unlinkSync(socket);
  const service = await withBindingFence(config.stateDir, async () => new DoriService(config));
  service.setPhase("reconciling");
  for (const lane of await service.registry.open()) if (lane.runtime?.backend === "external-current-session" && lane.runtime.state !== "stopped") await service.deps.runtime.inspect(lane.key).catch(() => {});
  const server = Bun.serve({ unix: socket, async fetch(request) {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) return new Response(null, { status: 413 });
      const caller = await service.authorize((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      const { action, args } = await request.json() as { action: string; args: any };
      return Response.json({ result: await service.handle(action, args, caller) });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Service request failed" }, { status: 409 }); }
  } });
  chmodSync(socket, 0o600);
  let stopping = false;
  const timer = setInterval(() => { void service.tick(); }, 1000);
  const laneEvents: LaneEventSource = await startLaneEvents(service.registry);
  const guard = { alerting: false }; let guardBusy = false;
  const monitor = setInterval(() => {
    if (guardBusy) return; guardBusy = true;
    void Promise.all([sampleHost(run).then(s => guardTick(s, config.guard, guard).forEach(console.log)), deadPaneTick(config, service.registry).then(lines => lines.forEach(console.log))]).catch(() => console.error("MONITOR_ERROR host")).finally(() => { guardBusy = false; });
  }, 60000);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const readers: Promise<void>[] = [];
  const shutdown = new AbortController();
  shutdown.signal.addEventListener("abort", () => laneEvents.stop());
  for (const ingress of config.ingress) {
    service.setIngressProcess(ingress.id, "starting");
    readers.push((async () => {
      for (let attempt = 0; !stopping && attempt < 5; attempt++) {
        let producer: ReturnType<typeof Bun.spawn> | undefined;
        try {
          const child = Bun.spawn(ingress.command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" }); children.push(child); producer = child; service.setIngressProcess(ingress.id, "running");
          const reader = child.stdout as ReadableStream<Uint8Array>; const decoder = new TextDecoder(); let pending = "";
          for await (const chunk of reader) {
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > 1024 * 1024) throw new Error("Ingress frame too large");
            while (pending.includes("\n")) { const at = pending.indexOf("\n"), line = pending.slice(0, at); pending = pending.slice(at + 1); if (line.trim()) { const event = JSON.parse(line); await service.receive(ingress.id, event); (child.stdin as Bun.FileSink).write(JSON.stringify({ ack: event.id, thread: event.thread }) + "\n"); (child.stdin as Bun.FileSink).flush(); } }
          }
          await child.exited;
        } catch { console.error(`INGRESS_ERROR ${ingress.id}`); }
        finally { producer?.kill(); service.setIngressProcess(ingress.id, stopping ? "stopped" : "failed"); }
        if (!stopping) await new Promise<void>(resolveWait => {
          const wake = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", wake); resolveWait(); };
          const timer = setTimeout(wake, 1000 * 2 ** attempt);
          shutdown.signal.addEventListener("abort", wake, { once: true });
          if (shutdown.signal.aborted) wake();
        });
      }
      if (!stopping) console.error(`INGRESS_STOPPED ${ingress.id}; restart service after fixing adapter`);
    })());
  }
  service.setPhase("ready"); await service.health();
  console.log("DORI_SERVICE_READY");
  await new Promise<void>(resolveStop => {
    const stop = () => { stopping = true; shutdown.abort(); resolveStop(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  clearInterval(timer); clearInterval(monitor);
  try { await drainIngress(children, readers); }
  catch (error) {
    // Keep socket/lock ownership until producer and reader shutdown is proven,
    // but reject new RPC mutations while accepted receive work can still settle.
    service.stop();
    throw error;
  }
  for (const lane of await service.registry.open()) if (lane.runtime?.backend !== "external-current-session") await service.deps.runtime.hold(lane.key, "automatic").catch(() => {});
  service.stop(); server.stop(true);
  if (existsSync(socket)) unlinkSync(socket);
  if (readJson<{ instance: string }>(lockPath).instance === instance) unlinkSync(lockPath);
};

export const serve = async (config: DoriConfig): Promise<void> => {
  try { await serveService(config); }
  catch (error) {
    const path = join(config.stateDir, "service-health.json");
    let previous: any;
    try { previous = readJson(path); } catch { /* startup may fail before its first write */ }
    // A second start must not overwrite the live owner's health.
    if (!previous || previous.pid === process.pid) atomicJson(path, { ...previous, schemaVersion: 1, phase: "failed", pid: process.pid,
      startedAt: previous?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), cause: { code: "service-failed", message: "Service startup or runtime failed; inspect service logs." } });
    throw error;
  }
};
