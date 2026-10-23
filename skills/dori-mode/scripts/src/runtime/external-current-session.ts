import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RuntimeConfig } from "../config.ts";
import { DeliveryDeferred } from "../mailbox.ts";
import { realClock, type Clock, type Runner } from "../run.ts";
import { operationText, type Agent } from "./herdr.ts";
import { connectObserver, readGoal, readLoadedThreads, readTurns, receipt, type Observer } from "./observer.ts";
import type { Thread } from "./generated/v2/Thread.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { ExternalHoldCode, RuntimeSnapshot } from "./types.ts";

export const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ExternalIdentity = { threadId: string; pane: string; cwd: string; model?: string; effort?: string };
export type Attachment = ExternalIdentity & { instance: string; generation: number; token: string; socketPath: string; binary: string; binaryVersion?: string; bridge: string; excludedInboxIds: string[] };

// External sessions borrow a user-owned runtime. This explicit protocol support
// table is independent of the managed host's requiredVersion pin.
const supportedVersions = new Set(["0.163.0", "0.164.0"]);
export class ExternalSessionError extends Error {
  constructor(readonly code: ExternalHoldCode, message: string) { super(message); }
}
const safeVersion = (version: unknown): string => typeof version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : "unrecognized";
// Version is a supported read-only command: never start/restart/configure the
// user's daemon to obtain an endpoint.
export const sharedDaemon = async (run: Runner, binary: string, config: RuntimeConfig): Promise<{ socketPath: string; binaryVersion: string }> => {
  let version: any;
  try {
    const result = await run([binary, "app-server", "daemon", "version"], { timeoutMs: config.rpcTimeoutMs });
    if (result.code !== 0) throw new Error();
    version = JSON.parse(result.out);
  } catch { throw new ExternalSessionError("runtime-unavailable", "Shared Codex runtime unavailable; delivery is waiting for reconnection."); }
  if (version?.status !== "running" || typeof version.socketPath !== "string" || !isAbsolute(version.socketPath))
    throw new ExternalSessionError("runtime-unavailable", "Shared Codex runtime identity unavailable; delivery is waiting for reconnection.");
  const client = safeVersion(version.cliVersion), server = safeVersion(version.appServerVersion);
  if (version.cliVersion !== version.appServerVersion)
    throw new ExternalSessionError("runtime-version-changed", `Shared Codex runtime version changed (client ${client}, server ${server}); explicitly reattach with a supported matching client.`);
  if (!supportedVersions.has(version.cliVersion))
    throw new ExternalSessionError("runtime-version-unsupported", `Unsupported shared Codex runtime version (client ${client}, server ${server}); supported pairs are 0.163.0/0.163.0 and 0.164.0/0.164.0.`);
  return { socketPath: version.socketPath, binaryVersion: version.appServerVersion };
};

export class ExternalCurrentSession {
  constructor(readonly observer: Observer, readonly run: Runner, readonly config: RuntimeConfig,
    readonly identity: ExternalIdentity, readonly binary: string, readonly clock: Clock = realClock,
    readonly onObservedTurns: (turns: Turn[]) => Promise<void> = async () => {}) {}

  async inspect(): Promise<RuntimeSnapshot & { model?: string; effort?: string }> {
    const { threadId, pane, cwd } = this.identity;
    const result = await this.run(["herdr", "agent", "get", pane], { timeoutMs: this.config.rpcTimeoutMs });
    if (result.code !== 0) throw new Error("Attached Herdr pane unavailable");
    const agent: Agent = JSON.parse(result.out).result?.agent;
    if (agent?.agent !== "codex" || agent.pane_id !== pane || agent.agent_session?.agent !== "codex" || agent.agent_session.kind !== "id" || agent.agent_session.value !== threadId)
      throw new Error("Attached Herdr pane/thread identity mismatch");
    const [{ thread }, loaded, { goal }, turns] = await Promise.all([
      this.observer.read<{ thread: Thread }>("thread/read", { threadId }), readLoadedThreads(this.observer), readGoal(this.observer, threadId), readTurns(this.observer, threadId),
    ]);
    if (!loaded.includes(threadId) || thread.id !== threadId || thread.status.type === "notLoaded" || realpathSync(thread.cwd) !== realpathSync(cwd))
      throw new Error("Attached loaded thread/cwd identity mismatch");
    const active = turns.filter(turn => turn.status === "inProgress");
    if (active.length > 1) throw new Error("Ambiguous attached active turn");
    const flags = thread.status.type === "active" ? thread.status.activeFlags : [];
    const state = flags.includes("waitingOnApproval") ? "waiting_approval" : flags.includes("waitingOnUserInput") || agent.agent_status === "blocked" ? "waiting_input" :
      thread.status.type === "systemError" ? "failed" : thread.status.type === "active" || active.length ? "running" : "idle";
    if (state === "running" && !active[0]) throw new Error("Attached active turn identity unknown");
    await this.onObservedTurns(turns);
    // The user owns /model and effort choices. Observe them without changing or
    // pinning them as part of the pane/thread/cwd identity contract.
    return { threadId, state, activeTurnId: active[0]?.id, goal, model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined };
  }

  async input(text: string, id: string, onIdentityLoss: (error: unknown) => Promise<void>): Promise<{ turnId: string }> {
    const verify = async () => {
      try { return await this.inspect(); }
      catch (error) { await onIdentityLoss(error); throw new DeliveryDeferred("Attached identity unavailable; dispatch held"); }
    };
    const snap = await verify();
    if (snap.state !== "idle") throw new DeliveryDeferred("Attached session busy; input remains queued");
    const marked = operationText(text, id);
    // Read-only reconciliation is allowed; an uncertain prior send is never
    // resubmitted by this adapter. Mailbox enforces that before invoking us.
    const prior = await receipt(this.observer, this.identity.threadId, marked);
    if (prior) return { turnId: prior };
    if ((await verify()).state !== "idle") throw new DeliveryDeferred("Attached session busy; input remains queued");
    let failure: unknown;
    try {
      const result = await this.run([this.binary, "queue", "--thread", this.identity.threadId, "--message", marked], { timeoutMs: this.config.rpcTimeoutMs });
      if (result.code !== 0) failure = new Error("Codex queue submission outcome unknown");
    } catch (error) { failure = error; }
    const deadline = this.clock.now() + this.config.rpcTimeoutMs;
    do {
      // Verify borrowed identity before accepting any observed receipt too.
      try { await this.inspect(); } catch (error) { await onIdentityLoss(error); throw new Error("Attached identity lost after submission; delivery unknown"); }
      const turnId = await receipt(this.observer, this.identity.threadId, marked);
      if (turnId) return { turnId };
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw failure ?? new Error("Queue receipt unknown; reconcile before retry");
  }
}

export const observeExternal = async <T>(run: Runner, config: RuntimeConfig, attachment: Pick<Attachment, "binary" | "socketPath" | "binaryVersion">,
  action: (observer: Observer) => Promise<T>): Promise<T> => {
  const daemon = await sharedDaemon(run, attachment.binary, config);
  if (daemon.socketPath !== attachment.socketPath) throw new ExternalSessionError("identity-unverified", "Shared Codex daemon affinity changed; explicit attachment required.");
  if (attachment.binaryVersion && daemon.binaryVersion !== attachment.binaryVersion)
    throw new ExternalSessionError("runtime-version-changed", `Shared Codex runtime version changed (attached ${safeVersion(attachment.binaryVersion)}, observed ${daemon.binaryVersion}); explicit attachment required.`);
  const observer = await connectObserver(daemon.socketPath, config.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Shared Codex observer unavailable; delivery is waiting for reconnection."); });
  try { return await action(observer); } finally { observer.close(); }
};
