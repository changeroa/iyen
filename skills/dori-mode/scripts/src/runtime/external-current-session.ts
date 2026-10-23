import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RuntimeConfig } from "../config.ts";
import { DeliveryDeferred } from "../mailbox.ts";
import { realClock, type Clock, type Runner } from "../run.ts";
import { operationText, type Agent } from "./herdr.ts";
import { connectObserver, readGoal, readLoadedThreads, readTurns, receipt, type Observer } from "./observer.ts";
import type { Thread } from "./generated/v2/Thread.ts";
import type { RuntimeSnapshot } from "./types.ts";

export const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ExternalIdentity = { threadId: string; pane: string; cwd: string; model?: string; effort?: string };
export type Attachment = ExternalIdentity & { instance: string; generation: number; token: string; socketPath: string; binary: string; bridge: string; excludedInboxIds: string[] };

// Version is a supported read-only command: never start/restart/configure the
// user's daemon to obtain an endpoint.
export const sharedDaemon = async (run: Runner, binary: string, config: RuntimeConfig): Promise<{ socketPath: string }> => {
  const result = await run([binary, "app-server", "daemon", "version"], { timeoutMs: config.rpcTimeoutMs });
  if (result.code !== 0) throw new Error("Shared Codex daemon unavailable; attachment requires an already-running daemon");
  const version = JSON.parse(result.out);
  if (version.status !== "running" || version.cliVersion !== config.requiredVersion || version.appServerVersion !== config.requiredVersion ||
      typeof version.socketPath !== "string" || !isAbsolute(version.socketPath)) throw new Error("Unsupported shared Codex daemon identity/version");
  return { socketPath: version.socketPath };
};

export class ExternalCurrentSession {
  constructor(readonly observer: Observer, readonly run: Runner, readonly config: RuntimeConfig,
    readonly identity: ExternalIdentity, readonly binary: string, readonly clock: Clock = realClock) {}

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
    // The user owns /model and effort choices. Observe them without changing or
    // pinning them as part of the pane/thread/cwd identity contract.
    return { threadId, state, activeTurnId: active[0]?.id, goal, model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined };
  }

  async input(text: string, id: string, onIdentityLoss: () => Promise<void>): Promise<{ turnId: string }> {
    const verify = async () => {
      try { return await this.inspect(); }
      catch { await onIdentityLoss(); throw new DeliveryDeferred("Attached identity unavailable; dispatch held"); }
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
      try { await this.inspect(); } catch { await onIdentityLoss(); throw new Error("Attached identity lost after submission; delivery unknown"); }
      const turnId = await receipt(this.observer, this.identity.threadId, marked);
      if (turnId) return { turnId };
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw failure ?? new Error("Queue receipt unknown; reconcile before retry");
  }
}

export const observeExternal = async <T>(run: Runner, config: RuntimeConfig, attachment: Pick<Attachment, "binary" | "socketPath">,
  action: (observer: Observer) => Promise<T>): Promise<T> => {
  const daemon = await sharedDaemon(run, attachment.binary, config);
  if (daemon.socketPath !== attachment.socketPath) throw new Error("Shared daemon affinity changed; explicit attachment required");
  const observer = await connectObserver(daemon.socketPath, config.rpcTimeoutMs);
  try { return await action(observer); } finally { observer.close(); }
};
