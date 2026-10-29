import { chmodSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync, realpathSync, fsyncSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { workspaceForRole, type DoriConfig } from "./config.ts";
import { atomicJson, SerialQueue } from "./journal.ts";
import { ipc, serviceSocket, hostSocket, readJson } from "./ipc.ts";
import { Registry, statusOf, withStatus, type Lane, LANE_KEY } from "./registry.ts";
import { claimDone, closeLane, objectDone, watchTick, type FlowDeps } from "./done-flow.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { launchLane, quoteForPane, validateLaunch, LaunchError, type LaunchInput } from "./launch.ts";
import { freshnessTick } from "./freshness.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { syncRegistry } from "./sync.ts";
import { sampleHost, guardTick } from "./host-guard.ts";
import { canLaunch } from "./routing.ts";
import { run, realClock, type Runner } from "./run.ts";
import { backendSocket, bootstrapPath, type Bootstrap } from "./runtime/session-host.ts";
import type { ExternalHoldCode, RuntimeControl, RuntimeRef, RuntimeSnapshot } from "./runtime/types.ts";
import { WorkTimers } from "./work.ts";
import { turnFailure } from "./turn-failure.ts";
import { DeliveryDeferred, Mailbox, postHook, type Mail } from "./mailbox.ts";
import { ExternalCurrentSession, ExternalSessionError, discoverExternal, observeExternal, sharedDaemon, THREAD_UUID, type Attachment } from "./runtime/external-current-session.ts";
import { connectObserver, receiptInTurns } from "./runtime/observer.ts";
import { operationText } from "./runtime/herdr.ts";
import type { Turn } from "./runtime/generated/v2/Turn.ts";

export type Caller = { role: "admin" | "lead" | "lane" | "host"; key?: string; instance?: string };
export type ExternalTransport = { connect: typeof connectObserver; observe: typeof observeExternal };
type OwnedFailure = Mail & { leadIntakeInstance?: string };
const UNOWNED_LEAD = "unattached-lead";
type HandoffArgs = { fromThreadId: string; threadId: string; pane: string; cwd: string; mailIds: string[]; operationId: string };
type HandoffIntent = { version: 1; status: "prepared" | "committed"; args: HandoffArgs; before: Lane; beforeAttachment: Attachment; after: Lane; afterAttachment: Attachment; result: any; createdAt: string; identityHeld?: boolean; cleanupPending?: boolean };
export type HandoffIO = { removeMarker(path: string): void };
const durableMarkerRemoval = (path: string): void => {
  // Open before unlink so an open failure leaves the recovery marker intact.
  const directory = openSync(dirname(path), "r");
  try { unlinkSync(path); fsyncSync(directory); } finally { closeSync(directory); }
};
export type ServicePhase = "starting" | "replaying" | "reconciling" | "ready" | "stopping" | "failed";
const reconnectable = (code?: ExternalHoldCode): boolean => Boolean(code && ["runtime-unavailable", "runtime-version-changed", "runtime-version-unsupported", "runtime-incompatible", "rebind-interrupted"].includes(code));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export class DoriService {
  readonly registry: Registry;
  readonly inbox: Mailbox;
  readonly outbox: Mailbox;
  readonly operations: Mailbox;
  readonly failures: Mailbox;
  readonly deps: FlowDeps;
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
    this.registry = new Registry(config.stateDir);
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
      if (!lane?.runtime?.threadId) throw new Error("Runtime is not registered");
      if (lane.runtime.backend === "external-current-session") return this.externalCall(lane, action, args) as Promise<T>;
      if (action === "stop" && lane.runtime.state === "stopped") return undefined as T;
      const boot = readJson<Bootstrap>(bootstrapPath(config.stateDir, key));
      const result = await ipc<T>(hostSocket(config.stateDir, key), boot.hostToken, action, args, config.runtime.rpcTimeoutMs * 3);
      if (action === "stop") await this.registry.update(key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, state: "stopped", activeTurnId: undefined } }));
      return result;
    };
    const runtime: RuntimeControl = {
      inspect: key => this.dispatchQueue.run(key, () => call(key, "inspect")),
      input: (key, text, operationId) => this.withIntake(() => this.dispatchQueue.run(key, async () => {
        const lane = await this.registry.read(key);
        if (!lane || lane.dispatchBlocked || statusOf(lane) === "closed") throw new Error("Lane dispatch is blocked");
        const mail = this.putInbox({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString() });
        if (lane.runtime?.backend === "external-current-session") {
          if (mail.attachmentInstance && mail.attachmentInstance !== lane.runtime.hostInstanceId) throw new DeliveryDeferred("Mail belongs to a previous lead attachment");
          if (this.attachment(lane).excludedInboxIds.includes(mail.id)) throw new DeliveryDeferred("Historical mail is held for explicit reconciliation");
          if (mail.state === "queued" && !["idle", "running"].includes((await call<RuntimeSnapshot>(key, "inspect")).state)) throw new DeliveryDeferred("Attached session requires approval or input; dispatch held");
          if (mail.state === "queued") this.inbox.mark(mail.id, { attachmentInstance: lane.runtime.hostInstanceId });
        }
        const delivered = await this.inbox.deliver(mail.id, async row => {
          const result = await call<{ turnId: string }>(key, "input", { text: row.text, operationId: row.id });
          if (typeof result?.turnId !== "string" || !result.turnId.trim()) throw new Error("Missing turn receipt");
          return result;
        });
        if (!delivered.turnId) throw new Error("Missing turn receipt");
        return { turnId: delivered.turnId };
      })),
      hold: (key, origin) => call(key, "hold", { origin }), release: (key, origin) => call(key, "release", { origin }), stop: key => call(key, "stop"),
    };
    this.deps = { config, registry: this.registry, clock: realClock, run: runner, runtime, post: (id, hook, values) => postHook(this.outbox, runner, id, hook, values),
      queueInput: (key, text, operationId) => this.withIntake(async () => {
        const lane = await this.lane(key);
        this.putInbox({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString(), attachmentInstance: this.intakeInstance(lane) });
      }) };
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
    this.healthSnapshot = { delivery, queue, ingress: this.ingressStatus() }; this.writeHealth();
    return readJson(join(this.config.stateDir, "service-health.json"));
  }
  private activeHandoffPath(): string { return join(this.config.stateDir, "attachments", "handoff.json"); }
  private handoffPath(id: string): string { return join(this.config.stateDir, "attachments", "handoffs", `${createHash("sha256").update(id).digest("hex")}.json`); }
  private pendingHandoff(): HandoffIntent | undefined {
    if (!existsSync(this.activeHandoffPath())) return undefined;
    const { operationId } = readJson<{ operationId: string }>(this.activeHandoffPath());
    return readJson<HandoffIntent>(this.handoffPath(operationId));
  }
  private captureIntakeInstance(): string {
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
    return this.inbox.put(mail.target === "lead" ? { ...mail, attachmentInstance: mail.attachmentInstance ?? this.intakeScope.getStore() ?? this.captureIntakeInstance() } : mail);
  }
  private putFailure(mail: Mail): Mail {
    const owned: OwnedFailure = { ...mail, leadIntakeInstance: this.intakeScope.getStore() ?? this.captureIntakeInstance() };
    return this.failures.put(owned);
  }
  private assertNoPendingLeadMutation(): void {
    if (this.pendingHandoff()) throw new Error("Lead handoff incomplete; mutations are held until its recorded operation finishes");
  }
  private blocksPendingMutation(action: string, args: any, caller: Caller): boolean {
    if (["health", "status", "lead-handoff", "tick", "mail-list", "approval-list", "can-launch"].includes(action)) return false;
    if (["lead", "lead-attach", "lead-detach", "lead-handoff-preview"].includes(action)) return true;
    if (action === "sync") return Boolean(args.write);
    if (action === "mail-resolve") return args.box !== "outbox" && (!this.inbox.get(args.id) || this.inbox.get(args.id)?.target === "lead");
    return (args.key ?? caller.key) === "lead";
  }
  private handoffArgs(args: any, apply: boolean): HandoffArgs {
    if (typeof args.fromThreadId !== "string" || !THREAD_UUID.test(args.fromThreadId) || typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId) || args.fromThreadId === args.threadId ||
      typeof args.pane !== "string" || !args.pane.trim() || typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new Error("Handoff requires exact fromThreadId, different UUID threadId, pane and absolute cwd");
    if (apply && (!Array.isArray(args.mailIds) || typeof args.operationId !== "string" || !args.operationId.trim() || args.operationId.length > 200)) throw new Error("Handoff requires explicit mailIds array and stable operationId");
    if (args.mailIds !== undefined && (!Array.isArray(args.mailIds) || args.mailIds.some((id: unknown) => typeof id !== "string" || !id) || new Set(args.mailIds).size !== args.mailIds.length)) throw new Error("mailIds must contain unique nonempty strings");
    return { fromThreadId: args.fromThreadId, threadId: args.threadId, pane: args.pane, cwd: realpathSync(args.cwd), mailIds: [...(args.mailIds ?? [])].sort(), operationId: args.operationId ?? "" };
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
  private async validateHandoffTarget(args: HandoffArgs, socketPath: string): Promise<{ daemon: Awaited<ReturnType<typeof discoverExternal>>; snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>> }> {
    const daemon = await discoverExternal(this.runner, this.config.runtime);
    if (daemon.socketPath !== socketPath) throw new ExternalSessionError("identity-unverified", "Handoff daemon affinity changed; explicit detach and attach required.");
    const observer = await this.externalTransport.connect(daemon.socketPath, this.config.runtime.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Handoff target observer unavailable; replacement remains held."); });
    try {
      const snap = await new ExternalCurrentSession(observer, this.runner, this.config.runtime, args, daemon.binary).inspect();
      if (snap.state === "failed") throw new ExternalSessionError("runtime-failed", "Handoff target reports a runtime failure; replacement remains held.");
      return { daemon, snap };
    } finally { observer.close(); }
  }
  private async previewHandoff(raw: any): Promise<any> {
    const args = this.handoffArgs(raw, false), lane = await this.lane("lead");
    if (lane.runtime?.threadId !== args.fromThreadId || lane.runtime.backend !== "external-current-session") throw new Error("Handoff expected source session mismatch");
    const saved = this.attachment(lane), summary = this.handoffMail(saved);
    await this.validateHandoffTarget(args, saved.socketPath);
    return { fromThreadId: args.fromThreadId, threadId: args.threadId, pane: args.pane, cwd: args.cwd, ...summary,
      selectedMailIds: args.mailIds, selectionValid: args.mailIds.every(id => summary.eligibleMailIds.includes(id)), dispatches: false };
  }
  private async applyHandoff(raw: any): Promise<any> {
    const args = this.handoffArgs(raw, true), path = this.handoffPath(args.operationId);
    let intent: HandoffIntent;
    if (existsSync(path)) {
      intent = readJson<HandoffIntent>(path);
      if (!sameJson(intent.args, args)) throw new Error("Handoff operationId reused with different arguments");
      if (intent.status === "committed" && !this.pendingHandoff()) {
        await this.assertHandoffCurrent(intent);
        if (!intent.cleanupPending) return this.completedHandoff(intent);
        atomicJson(this.activeHandoffPath(), { operationId: args.operationId });
        return this.finishHandoff(intent);
      }
    } else {
      if (this.pendingHandoff()) throw new Error("Another handoff is pending; finish its recorded operation first");
      const before = await this.lane("lead");
      if (before.runtime?.threadId !== args.fromThreadId || before.runtime.backend !== "external-current-session") throw new Error("Handoff expected source session mismatch");
      const beforeAttachment = this.attachment(before), summary = this.handoffMail(beforeAttachment);
      if (args.mailIds.some(id => !summary.eligibleMailIds.includes(id))) throw new Error("Handoff selection includes attempted, reconciled, unknown or other-attachment mail");
      const { daemon, snap } = await this.validateHandoffTarget(args, beforeAttachment.socketPath);
      const excluded = [...new Set([...beforeAttachment.excludedInboxIds, ...this.inbox.list().filter(row => row.target === "lead").map(row => row.id)])].filter(id => !args.mailIds.includes(id));
      const { saved: afterAttachment, lead: after } = this.prepareAttachment(args, args.cwd, before, daemon.binary, daemon, snap, excluded);
      const protectedHold = before.holdReason === "owner-pause" || before.holdReason === "done-review" || statusOf(before) === "paused" || statusOf(before) === "done-claimed" || statusOf(before) === "verified-done";
      if (protectedHold) { Object.assign(after, { status: before.status, dispatchBlocked: true, holdReason: before.holdReason, claim: before.claim }); after.runtime!.held = true; }
      const publicLead = { ...after, mode: "external-current-session", bridge: afterAttachment.bridge, identityVerified: true,
        verifiedIdentity: { threadId: args.threadId, pane: args.pane, cwd: args.cwd, model: snap.model, effort: snap.effort }, readiness: protectedHold ? "held" : snap.state === "idle" ? "ready" : "busy" };
      intent = { version: 1, status: "prepared", args, before, beforeAttachment, after, afterAttachment, createdAt: new Date().toISOString(),
        result: { attached: true, handedOff: true, operationId: args.operationId, fromThreadId: args.fromThreadId, threadId: args.threadId, mailIds: args.mailIds, bridge: afterAttachment.bridge, lead: publicLead } };
      atomicJson(path, intent);
    }
    const pending = this.pendingHandoff();
    if (pending && pending.args.operationId !== args.operationId) throw new Error("Another handoff is pending");
    if (!pending) {
      // An orphan prepared record means no transaction write was started. Its
      // selected mail may have progressed meanwhile; never replay it.
      const current = await this.lane("lead"), summary = this.handoffMail(this.attachment(current));
      if (current.runtime?.hostInstanceId !== intent.beforeAttachment.instance || current.revision !== intent.before.revision || args.mailIds.some(id => !summary.eligibleMailIds.includes(id))) throw new Error("Handoff source or selected mail changed before intent activation");
      atomicJson(this.activeHandoffPath(), { operationId: args.operationId });
    }
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
      await this.validateHandoffTarget(args, beforeAttachment.socketPath);
      if (intent.identityHeld) { intent = { ...intent, identityHeld: undefined }; atomicJson(path, intent); }
      if (intent.status !== "committed") {
        await this.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason: lane.holdReason ?? "recovery", runtime: { ...lane.runtime!, held: true, state: "recovering" } }));
        for (const id of args.mailIds) {
          const row = this.inbox.get(id);
          if (!row || row.target !== "lead" || row.state !== "queued" || row.turnId || row.source?.startsWith("reconciled:") || row.attachmentInstance && ![UNOWNED_LEAD, beforeAttachment.instance, afterAttachment.instance].includes(row.attachmentInstance)) throw new Error("Handoff selected mail no longer safe; operator reconciliation required");
          if (row.attachmentInstance !== afterAttachment.instance) this.inbox.mark(id, { attachmentInstance: afterAttachment.instance });
        }
        if (!sameJson(readJson(this.attachmentPath()), afterAttachment)) atomicJson(this.attachmentPath(), afterAttachment);
        await this.registry.update("lead", lane => ({ ...lane, pane: intent.after.pane, cwd: intent.after.cwd, model: intent.after.model, runtimeHistory: intent.after.runtimeHistory,
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
      return await this.completedHandoff(intent);
    } catch (error) {
      if (!(error instanceof DeliveryDeferred)) {
        const current = await this.registry.read("lead");
        if (intent.cleanupPending && current?.runtime?.hostInstanceId === afterAttachment.instance && !existsSync(this.activeHandoffPath()))
          atomicJson(this.activeHandoffPath(), { operationId: args.operationId });
        if (error instanceof ExternalSessionError && error.code === "identity-unverified") { intent = { ...intent, identityHeld: true }; atomicJson(path, intent); }
        const lane = await this.registry.read("lead");
        if (lane?.runtime) {
          await this.holdExternal(lane.runtime.hostInstanceId, new ExternalSessionError("handoff-interrupted", "Recorded lead handoff is incomplete; verify its exact target and retry the same operationId."));
          await this.recordRetry(lane.runtime.hostInstanceId);
        }
      }
      throw error;
    }
  }
  private attachmentPath(): string { return join(this.config.stateDir, "attachments", "lead.json"); }
  private attachment(lane: Lane): Attachment {
    const saved = readJson<Attachment>(this.attachmentPath());
    if (lane.key !== "lead" || lane.runtime?.backend !== "external-current-session" || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped" ||
        saved.instance !== lane.runtime.hostInstanceId || saved.generation !== lane.runtime.generation || saved.threadId !== lane.runtime.threadId || saved.pane !== lane.pane || saved.cwd !== lane.cwd ||
        saved.socketPath !== lane.runtime.external?.socketPath || saved.bridge !== lane.runtime.external.bridge ||
        (saved.binary !== lane.runtime.external.binary || (saved.binaryVersion && saved.binaryVersion !== lane.runtime.binaryVersion)) &&
          !(lane.runtime.external.rebind?.binary === saved.binary && lane.runtime.external.rebind.binaryVersion === saved.binaryVersion)) throw new Error("Stale or detached lead attachment");
    return saved;
  }
  private async holdExternal(instance: string, error: unknown = new ExternalSessionError("identity-unverified", "Attached session identity unavailable; explicit attachment required.")): Promise<void> {
    const reason = error instanceof ExternalSessionError ? error : new ExternalSessionError("identity-unverified", "Attached session could not be verified; explicit reconnection required.");
    await this.registry.update("lead", lane => {
      if (lane.runtime?.hostInstanceId !== instance || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped") return lane;
      const ext = lane.runtime.external!;
      const latest = ext.latestHoldReason?.code === reason.code && ext.latestHoldReason.message === reason.message ? ext.latestHoldReason : { code: reason.code, message: reason.message, at: new Date().toISOString() };
      const next: Lane = { ...lane, dispatchBlocked: true, holdReason: lane.holdReason ?? "recovery", runtime: { ...lane.runtime, held: true, state: "recovering", activeTurnId: undefined,
        external: { ...ext, holdReason: ext.holdReason ?? latest, firstHoldReason: ext.firstHoldReason ?? ext.holdReason ?? latest, latestHoldReason: latest,
          reconnectBlocked: Boolean(ext.reconnectBlocked || !reconnectable(reason.code)) } } };
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
    const protectedHold = lane.holdReason === "owner-pause" || lane.holdReason === "done-review" || statusOf(lane) === "paused" || statusOf(lane) === "done-claimed" || statusOf(lane) === "verified-done";
    if (automatic && (protectedHold || lane.runtime?.external?.reconnectBlocked)) throw new DeliveryDeferred("Attached lead requires explicit reconciliation");
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
        const next: Lane = { ...current, model: snap.model, dispatchBlocked: protectedHold, holdReason: protectedHold ? current.holdReason : undefined, runtime: { ...current.runtime!,
          binaryVersion: daemon.binaryVersion, model: snap.model, effort: snap.effort, held: protectedHold, state: protectedHold ? "recovering" : snap.state, activeTurnId: snap.activeTurnId,
          external: { ...current.runtime!.external!, binary: daemon.binary, holdReason: undefined, reconnectBlocked: undefined, reconnect: undefined, rebind: undefined } } };
        return sameJson(current, next) ? current : next;
      });
    } catch {
      throw new ExternalSessionError("rebind-interrupted", "Recorded runtime rebind is incomplete; delivery is waiting for verified reconnection.");
    }
    return snap;
  }
  private async reconnectExternal(lane: Lane, saved: Attachment): Promise<Awaited<ReturnType<ExternalCurrentSession["inspect"]>> | null> {
    const ext = lane.runtime!.external!;
    if (lane.holdReason && lane.holdReason !== "recovery" || ext.reconnectBlocked || !ext.rebind && !reconnectable(ext.holdReason?.code)) return null;
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
    const pending = this.pendingHandoff();
    if (pending) {
      if (action !== "inspect") throw new DeliveryDeferred("Recorded lead handoff is incomplete; dispatch held");
      await this.finishHandoff(pending, true); lane = await this.lane("lead");
    }
    let saved: Attachment;
    try { saved = this.attachment(lane); }
    catch (error) { await this.holdExternal(lane.runtime!.hostInstanceId, new ExternalSessionError("attachment-inconsistent", "Attached session records are inconsistent; explicit attachment required.")); throw error; }
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
  private async publicLane(lane: Lane, dispatchLocked = false): Promise<any> {
    if (lane.runtime?.backend === "external-current-session" && !dispatchLocked) return this.dispatchQueue.run(lane.key, async () => this.publicLane(await this.lane(lane.key), true));
    if (lane.runtime?.backend !== "external-current-session") return lane;
    const attached = !lane.runtime.external?.detachedAt && lane.runtime.state !== "stopped";
    const snap = attached ? await this.externalCall(lane, "inspect", {}).catch(() => null) as RuntimeSnapshot | null : null;
    const current = await this.lane(lane.key);
    const stillAttached = !current.runtime?.external?.detachedAt && current.runtime?.state !== "stopped";
    const identityVerified = Boolean(snap) && stillAttached && current.runtime?.hostInstanceId === lane.runtime.hostInstanceId;
    return { ...current, mode: "external-current-session", bridge: current.runtime?.external?.bridge, identityVerified,
      verifiedIdentity: identityVerified ? { threadId: current.runtime?.threadId, pane: current.pane, cwd: current.cwd, model: current.runtime?.model, effort: current.runtime?.effort } : null,
      readiness: !stillAttached ? "detached" : !identityVerified || current.dispatchBlocked ? "held" : snap?.state === "idle" ? "ready" : "busy" };
  }
  private async attachLead(args: any): Promise<any> {
    if (typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId) || typeof args.pane !== "string" || !args.pane.trim() || typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new Error("lead-attach requires UUID thread-id, pane and absolute cwd");
    const cwd = realpathSync(args.cwd), previous = await this.registry.read("lead");
    const same = previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && previous.runtime.threadId === args.threadId && previous.pane === args.pane && previous.cwd === cwd;
    if (previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && !same) throw new Error("A different lead is attached; explicitly detach it first");
    // Matching identity may keep its existing capability across a binary upgrade.
    // This also accepts either side of a previously interrupted, recorded rebind.
    const saved = same ? this.attachment(previous) : undefined;
    try {
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
    const { saved, lead } = this.prepareAttachment(args, cwd, previous, binary, daemon, snap, this.inbox.list().filter(row => row.target === "lead").map(row => row.id));
    await this.registry.write(lead);
    // Publish the credential only after the registry commit succeeds. A revision
    // conflict must not revoke a previously valid attachment's capability.
    atomicJson(this.attachmentPath(), saved);
    return { attached: true, bridge: saved.bridge, lead: await this.publicLane(await this.lane("lead"), true) };
  }
  private prepareAttachment(args: any, cwd: string, previous: Lane | null, binary: string,
    daemon: Awaited<ReturnType<typeof sharedDaemon>>, snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>, excludedInboxIds: string[]): { saved: Attachment; lead: Lane } {
    const instance = crypto.randomUUID(), generation = (previous?.runtime?.generation ?? 0) + 1;
    const clientDir = resolve(this.config.stateDir, "clients", "attached-lead", instance), bridge = join(clientDir, "iyen");
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    const saved: Attachment = { threadId: args.threadId, pane: args.pane, cwd, model: snap.model, effort: snap.effort, instance, generation, token: crypto.randomUUID(), ...daemon, binary, bridge,
      excludedInboxIds: excludedInboxIds };
    atomicJson(join(clientDir, "context.json"), { token: saved.token, key: "lead", stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    writeFileSync(bridge, `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=lead exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`, { mode: 0o700 });
    const lead: Lane = { key: "lead", title: "Iyen current-session lead", role: "lead", thread: "none", brief: "", done: "", pane: args.pane, cwd, model: snap.model,
      openedAt: new Date().toISOString(), status: "working", dispatchBlocked: false, revision: previous?.revision,
      runtimeHistory: [...(previous?.runtimeHistory ?? []), ...(previous?.runtime ? [previous.runtime] : [])],
      runtime: { kind: "codex", backend: "external-current-session", threadId: args.threadId, state: snap.state, activeTurnId: snap.activeTurnId,
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
    const live = await this.runner(["herdr", "agent", "list"]);
    if (live.code !== 0) throw new Error("Cannot prove exclusive TUI ownership");
    const agents = JSON.parse(live.out).result.agents as { pane_id: string; agent_session?: { value: string } }[];
    if (agents.some(a => a.pane_id === lane.pane || (lane.runtime?.threadId && a.agent_session?.value === lane.runtime.threadId))) throw new Error("A live TUI already owns this pane or thread");
  }
  async boot(lane: Lane): Promise<void> {
    if (lane.key === "lead" || lane.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
    if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session boot is unsupported; use lead-attach");
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
    const boot: Bootstrap = { key: lane.key, role: lane.role ?? "lane", pane, instance, generation: (lane.runtime?.generation ?? 0) + 1, hostToken: crypto.randomUUID(), laneToken: crypto.randomUUID(), cwd: lane.cwd ?? this.config.defaultCwd, threadId: lane.runtime?.threadId, model: lane.model, blocked: Boolean(lane.dispatchBlocked), config: this.config };
    atomicJson(path, boot);
    const clientDir = join(this.config.stateDir, "clients", lane.key);
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    atomicJson(join(clientDir, "context.json"), { token: boot.laneToken, key: lane.key, stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    const wrapper = `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=${quoteForPane(lane.key)} exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`;
    writeFileSync(join(clientDir, "dori"), wrapper, { mode: 0o700 });
    await this.registry.update(lane.key, current => ({ ...current, runtime: { kind: "codex", backend: "herdr-tui", threadId: boot.threadId, state: "starting", hostInstanceId: instance, generation: boot.generation, binaryVersion: this.config.runtime.requiredVersion, lastHeartbeatAt: new Date().toISOString() } }));
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
    if (this.stopping) throw new Error("Service stopping");
    if (this.pendingHandoff() && this.blocksPendingMutation(action, args, caller)) throw new Error("Lead handoff incomplete; mutations are held until its recorded operation finishes");
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
      if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session cannot register a managed host");
      if (!lane.runtime || lane.runtime.hostInstanceId !== args.instance || args.runtime?.hostInstanceId !== args.instance || args.runtime?.generation !== lane.runtime.generation) throw new Error("Stale host generation");
      if (lane.runtime.threadId && lane.runtime.threadId !== args.runtime.threadId) throw new Error("Thread identity mismatch");
      if (!args.runtime.threadId || args.runtime.kind !== "codex") throw new Error("Invalid runtime identity");
      if (action === "host-register") atomicJson(join(this.config.stateDir, "hosts", `${lane.key}.pid.json`), { pid: args.pid, instance: args.instance });
      await this.registry.update(lane.key, l => ({ ...l,
        ...(args.runtime.held && !l.dispatchBlocked ? { dispatchBlocked: true, holdReason: "recovery" as const } : {}),
        runtime: { ...args.runtime as RuntimeRef, lastHeartbeatAt: new Date().toISOString() } }));
      if (action === "host-event" && args.event?.id !== undefined) {
        const id = args.event.method === "tui/inputRequired" ? `${lane.key}:${args.event.id}` : `${args.instance}:${args.event.id}`;
        this.outbox.put({ id: `approval:${id}`, target: lane.thread, text: JSON.stringify({ lane: lane.key, id, method: args.event.method, params: args.event.params }), state: "queued", at: new Date().toISOString() });
        this.putInbox({ id: `approval-notice:${id}`, target: "lead", text: `Approval or input required for ${lane.key}. Inspect dori approval list. ID: ${id}`, state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "runtime/disconnected" && lane.role !== "lead") {
        this.putInbox({ id: `runtime-failed:${lane.key}:${args.instance}`, target: "lead", text: `Runtime failed for ${lane.key}. Inspect status and reconcile unknown operations before recover.`, state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "turn/completed" && args.event.params?.turn?.status === "failed") {
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
    if (caller.role === "lane" && (!(["report", "claim-done", "status"].includes(action)) || key !== caller.key)) throw new Error("Lane capability does not authorize this command");
    if (["pause", "resume", "close", "recover", "reopen", "claim-done", "object-done"].includes(action) && (await this.registry.read(key))?.runtime?.backend === "external-current-session") throw new Error(`External current-session ${action} is unsupported; use lead-detach`);
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
      if (!args.threadId || args.transferConfirmed !== true) throw new Error("adopt requires thread-id and confirmed exclusive ownership transfer");
      await validateLaunch(this.deps, args);
      const lane: Lane = { key, title: args.title, thread: args.thread ?? "none", brief: args.brief, done: args.done, pane: args.pane, cwd: args.cwd ?? this.config.defaultCwd, role: "lane", openedAt: new Date().toISOString(), status: "paused", pausedFrom: "working", dispatchBlocked: true, holdReason: "owner-pause", runtime: { kind: "codex", threadId: args.threadId, hostInstanceId: "", generation: 0, state: "stopped", binaryVersion: this.config.runtime.requiredVersion } };
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
      if (mail.state === "sent") {
        if (!mail.turnId) throw new Error("Missing turn receipt");
        return { turnId: mail.turnId };
      }
      if (lane.dispatchBlocked) return { queued: true, operationId: mail.id };
      if (lane.runtime?.backend === "external-current-session") {
        try { return await this.deps.runtime.input(key, args.text, args.operationId); }
        catch (error) { if (error instanceof DeliveryDeferred) return { queued: true, operationId: mail.id }; throw error; }
      }
      return this.deps.runtime.input(key, args.text, args.operationId);
    }
    if (action === "report") {
      if (!["milestone", "blocker", "question", "done"].includes(args.kind) || !args.text || !args.eventId) throw new Error("Invalid report");
      const id = `report:${key}:${args.eventId}`;
      const report = this.putInbox({ id, target: "lead", text: `[REPORT] ${key} | ${args.kind} | ${args.text}`, state: "queued", at: new Date().toISOString() });
      await this.registry.update(key, l => ({ ...l, report: { id: args.eventId, kind: args.kind, text: args.text, at: Date.parse(report.at) } }));
      const lane = await this.lane(key);
      if (this.config.hooks.threadReply && lane.thread !== "none") {
        await this.deps.post!(id, this.config.hooks.threadReply, { key, thread: lane.thread, text: args.text });
        await this.registry.update(key, l => ({ ...l, lastReplyAt: Date.now(), lastPostedReport: args.eventId }));
      }
      return { recorded: true };
    }
    if (action === "reply") {
      if (!args.thread || !args.text || !args.operationId || !this.config.hooks.threadReply) throw new Error("thread, text, operationId and threadReply hook required");
      await this.deps.post!(args.operationId, this.config.hooks.threadReply, { key: key ?? "lead", thread: args.thread, text: args.text }); return { sent: true };
    }
    if (action === "sync") return syncRegistry(this.deps, Boolean(args.write));
    if (action === "approval-list") return this.approvals();
    if (action === "approval-respond") {
      if (caller.role !== "admin") throw new Error("Approval requires the authenticated owner control channel");
      const approvals = await this.approvals(); const selected = approvals.find(a => a.id === args.id);
      if (!selected) throw new Error("Expired approval");
      const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, selected.key));
      return ipc(hostSocket(this.config.stateDir, selected.key), boot.hostToken, "approval", { id: selected.requestId, response: args.response });
    }
    if (action === "mail-list") return { inbox: this.inbox.list(), outbox: this.outbox.list(), operations: this.operations.list(), failures: this.failures.list() };
    if (action === "mail-resolve") {
      if (caller.role !== "admin" || !["sent", "queued"].includes(args.state) || !args.evidence) throw new Error("Explicit reconciliation evidence required");
      const box = args.box === "inbox" ? this.inbox : args.box === "outbox" ? this.outbox : undefined;
      if (!box || box.get(args.id)?.state !== "unknown") throw new Error("Only unknown mail can be reconciled");
      return box.mark(args.id, { state: args.state, source: `reconciled: ${args.evidence}` });
    }
    if (action === "reopen" || action === "recover") {
      if (key === "lead" || (await this.registry.read(key))?.role === "lead") throw new Error("Managed lead recovery is unsupported; use lead-attach for the current session");
      return this.launchQueue.run(key, async () => {
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
        const workspace = workspaceForRole(this.config, lane.role);
        const created = await this.runner(["herdr", "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", lane.cwd ?? this.config.defaultCwd, "--label", key, "--no-focus"]);
        if (created.code !== 0) throw new Error("Cannot create recovery tab");
        const made = JSON.parse(created.out).result;
        lane = await this.registry.update(key, l => ({ ...l, pane: made.root_pane.pane_id, tab: made.tab_id ?? made.root_pane.tab_id }));
        await this.boot(lane);
        const text = args.text ?? (!lane.runtime?.threadId ? await Bun.file(lane.brief).text() : undefined);
        if (text) this.putInbox({ id: args.operationId ?? `handoff:${key}:${lane.cycle ?? 1}`, target: key, text, state: "queued", at: new Date().toISOString() });
        return { recovering: true, key };
      });
    }
    if (action === "tick") { await this.tick(); return { accepted: true }; }
    throw new Error(`Unknown service action: ${action}`);
  }
  async approvals(): Promise<{ id: string; key: string; requestId: string; request: unknown }[]> {
    const result: { id: string; key: string; requestId: string; request: unknown }[] = [];
    for (const lane of await this.registry.open()) {
      if (!lane.runtime?.threadId || lane.runtime.backend === "external-current-session") continue;
      try {
        const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, lane.key));
        const requests = await ipc<{ id: string; request: unknown }[]>(hostSocket(this.config.stateDir, lane.key), boot.hostToken, "approvals", {}, 1000);
        result.push(...requests.map(r => ({ id: `${boot.instance}:${r.id}`, key: lane.key, requestId: r.id, request: r.request })));
      } catch { /* disconnected requests cannot be answered */ }
    }
    return result;
  }
  notifyFailures(): Promise<void> { return this.withIntake(() => this.notifyFailuresScoped()); }
  private async notifyFailuresScoped(): Promise<void> {
    for (const failure of this.failures.list().filter(row => row.state === "queued")) {
      await this.failureQueue.run(failure.id, async () => {
        if (this.failures.get(failure.id)?.state !== "queued") return;
        const lane = await this.lane(failure.target);
        if (failure.attachmentInstance && (lane.runtime?.backend !== "external-current-session" || lane.runtime.hostInstanceId !== failure.attachmentInstance)) return;
        const metadata = JSON.parse(failure.text) as ReturnType<typeof turnFailure>;
        const text = `Codex task failed (${metadata.category}). ${metadata.guidance} The task was not automatically retried.`;
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
    const known = (await this.registry.list()).find(l => l.thread === event.thread && l.role !== "lead");
    if (event.control) {
      const allowed = ["pause", "resume", "object-done", "approval-respond"];
      if (!allowed.includes(event.control.action)) throw new Error("Unsupported inbound control");
      if (event.control.action === "approval-respond") {
        const request = (await this.approvals()).find(a => a.id === event.control.args?.id);
        if (!request || (await this.lane(request.key)).thread !== event.thread) throw new Error("Approval belongs to another thread");
      } else if (!known || event.control.args?.key !== known.key) throw new Error("Control belongs to another lane");
      this.putInbox({ id, target: "owner-control", text: JSON.stringify(event.control), source, thread: event.thread, state: "queued", at: new Date().toISOString() });
      this.ingressHealth.set(source, { process: this.ingressHealth.get(source)?.process ?? "starting", lastAcceptedAt: new Date().toISOString() });
      await this.inbox.deliver(id, async () => { await this.handle(event.control.action, event.control.args, { role: "admin" }); return {}; });
      return;
    }
    const target = known && statusOf(known) !== "closed" ? known.key : "lead";
    const intakeLane = target === "lead" ? await this.registry.read("lead") : null;
    const envelope = `Owner message in ${event.thread}${known && statusOf(known) === "closed" ? ` (closed lane ${known.key}; reopen if appropriate)` : ""}:`;
    // Retries of pre-metadata intake must retain the original operation text,
    // including when its delivery is uncertain. New events carry the source ID.
    const previous = this.inbox.get(id);
    const text = previous?.text === `${envelope}\n${event.text}` ? previous.text : `${envelope}\nSource message ID: ${event.id}\n${event.text}`;
    this.putInbox({ id, target, attachmentInstance: this.intakeInstance(intakeLane), thread: event.thread, text, source, state: "queued", at: new Date().toISOString() });
    this.ingressHealth.set(source, { process: this.ingressHealth.get(source)?.process ?? "starting", lastAcceptedAt: new Date().toISOString() });
  }
  tick(): Promise<void> { return this.withIntake(() => this.tickScoped()); }
  private async tickScoped(): Promise<void> {
    if (this.pendingHandoff()) {
      await this.deps.runtime.inspect("lead").catch(() => {}); await this.health(); return;
    }
    const once = async (name: string, fn: () => Promise<unknown>) => {
      const interval = name === "inbox" || name === "failures" || name === "external-observation" ? 1000 : name === "done" ? 30000 : name === "launch-queue" ? 10000 : 60000;
      if (this.ticks.has(name) || Date.now() - (this.lastTick.get(name) ?? 0) < interval) return;
      this.lastTick.set(name, Date.now()); this.ticks.add(name);
      try { await fn(); } catch { console.error(`MONITOR_ERROR ${name}`); } finally { this.ticks.delete(name); }
    };
    await Promise.all([
      once("external-observation", async () => {
        const lead = await this.registry.read("lead");
        if (lead?.runtime?.backend === "external-current-session" && lead.runtime.state !== "stopped" && !lead.runtime.external?.detachedAt) await this.deps.runtime.inspect(lead.key).catch(() => {});
      }),
      once("failures", () => this.notifyFailures()),
      once("done", () => watchTick(this.deps).then(lines => lines.forEach(l => console.log(l)))),
      once("freshness", () => freshnessTick(this.deps, process.env.HOME ?? "")),
      once("runtime-health", async () => {
        for (const lane of await this.registry.open()) {
          if (!lane.runtime || lane.runtime.state === "stopped" || lane.cleanupFence) continue;
          if (lane.runtime.backend === "external-current-session") continue;
          const age = Date.now() - Date.parse(lane.runtime.lastHeartbeatAt ?? lane.openedAt);
          if (age <= this.config.runtime.heartbeatTimeoutMs || lane.holdReason === "recovery") continue;
          await this.registry.update(lane.key, l => ({ ...l, dispatchBlocked: true, holdReason: l.holdReason ?? "recovery", runtime: l.runtime && { ...l.runtime, state: "recovering" } }));
          if (lane.role !== "lead") this.putInbox({ id: `host-unreachable:${lane.key}:${lane.runtime.hostInstanceId}`, target: "lead", text: `Host unreachable for ${lane.key}; dispatch held. Reconcile before recovery.`, state: "queued", at: new Date().toISOString() });
        }
      }),
      once("launch-queue", async () => {
        for (const row of this.operations.list().filter(r => r.state === "queued")) {
          const args = JSON.parse(row.text);
          if (row.target === "lead" || args.role === "lead") continue;
          if ((await this.registry.read(row.target))?.runtime?.backend === "external-current-session") continue;
          if (args.operationId) await this.handle("launch", args, { role: "admin" }).catch(() => {});
        }
      }),
      once("inbox", async () => {
        for (const row of this.inbox.list().filter(r => r.state === "queued")) {
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
  const service = new DoriService(config);
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
  const guard = { alerting: false }; let guardBusy = false;
  const monitor = setInterval(() => {
    if (guardBusy) return; guardBusy = true;
    void Promise.all([sampleHost(run).then(s => guardTick(s, config.guard, guard).forEach(console.log)), deadPaneTick(run, config, service.registry).then(lines => lines.forEach(console.log))]).catch(() => console.error("MONITOR_ERROR host")).finally(() => { guardBusy = false; });
  }, 60000);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  for (const ingress of config.ingress) {
    service.setIngressProcess(ingress.id, "starting");
    void (async () => {
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
        if (!stopping) await Bun.sleep(1000 * 2 ** attempt);
      }
      if (!stopping) console.error(`INGRESS_STOPPED ${ingress.id}; restart service after fixing adapter`);
    })();
  }
  service.setPhase("ready"); await service.health();
  console.log("DORI_SERVICE_READY");
  await new Promise<void>(resolveStop => {
    const stop = () => { stopping = true; resolveStop(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  clearInterval(timer); clearInterval(monitor);
  for (const child of children) child.kill();
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
