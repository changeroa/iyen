import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RuntimeConfig } from "../config.ts";
import { DeliveryDeferred } from "../mailbox.ts";
import { realClock, type Clock, type Runner } from "../run.ts";
import { operationText, type Agent } from "./herdr.ts";
import { connectObserver, ObserverCompatibilityError, readThread, readOptionalGoal, readLoadedThreads, readTurns, receipt, type Observer } from "./observer.ts";
import { RpcError } from "./protocol.ts";
import { resolveCodexBinary } from "./session-host.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { ExternalHoldCode, RuntimeSnapshot } from "./types.ts";

export const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ExternalIdentity = { threadId: string; pane: string; cwd: string; model?: string; effort?: string };
export type Attachment = ExternalIdentity & { instance: string; generation: number; token: string; socketPath: string; binary: string; binaryVersion?: string; bridge: string; excludedInboxIds: string[] };

export class ExternalSessionError extends Error {
  constructor(readonly code: ExternalHoldCode, message: string) { super(message); }
}
const safeVersion = (version: unknown): string => typeof version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : "unrecognized";
const knownIdentity = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
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
  if (client === "unrecognized" || server === "unrecognized")
    throw new ExternalSessionError("runtime-incompatible", "Shared Codex runtime version unrecognized; a validated matching client and server are required.");
  if (version.cliVersion !== version.appServerVersion)
    throw new ExternalSessionError("runtime-version-changed", `Shared Codex runtime version changed (client ${client}, server ${server}); a matching client is required for reconnection.`);
  return { socketPath: version.socketPath, binaryVersion: version.appServerVersion };
};

export const discoverExternal = async (run: Runner, config: RuntimeConfig): Promise<{ binary: string; socketPath: string; binaryVersion: string }> => {
  let binary: string;
  try { binary = resolveCodexBinary(config.externalBinary ?? config.binary); }
  catch { throw new ExternalSessionError("runtime-unavailable", "Configured external Codex executable unavailable; delivery is waiting for reconnection."); }
  const daemon = await sharedDaemon(run, binary, config);
  // Help is a read-only feature probe. Never start or repair the user's daemon
  // and never infer queue compatibility merely from a release number.
  try {
    const help = await run([binary, "queue", "--help"], { timeoutMs: config.rpcTimeoutMs });
    const flags = `${help.out}\n${help.err}`;
    if (help.code !== 0 || !/(?:^|\s)--thread(?=[\s=,<\[]|$)/m.test(flags) || !/(?:^|\s)--message(?=[\s=,<\[]|$)/m.test(flags)) throw new Error();
  } catch { throw new ExternalSessionError("runtime-incompatible", "Shared Codex client lacks required queue --thread/--message capabilities; delivery is held."); }
  return { binary, ...daemon };
};

const observerError = (error: unknown): unknown => error instanceof ObserverCompatibilityError
  ? new ExternalSessionError("runtime-incompatible", error.message)
  : error instanceof RpcError ? new ExternalSessionError("runtime-unavailable", "Shared Codex observer unavailable; delivery is waiting for reconnection.") : error;

export class ExternalCurrentSession {
  constructor(readonly observer: Observer, readonly run: Runner, readonly config: RuntimeConfig,
    readonly identity: ExternalIdentity, readonly binary: string, readonly clock: Clock = realClock,
    readonly onObservedTurns: (turns: Turn[]) => Promise<void> = async () => {}) {}

  async inspect(): Promise<RuntimeSnapshot & { model?: string; effort?: string; capabilities?: { messaging: true; goal: boolean } }> {
    try { return await this.inspectVerified(); }
    catch (error) { throw observerError(error); }
  }

  private async inspectVerified(): Promise<RuntimeSnapshot & { model?: string; effort?: string; capabilities: { messaging: true; goal: boolean } }> {
    const { threadId, pane, cwd } = this.identity;
    let agent: Agent;
    try {
      const result = await this.run(["herdr", "agent", "get", pane], { timeoutMs: this.config.rpcTimeoutMs });
      if (result.code !== 0) throw new Error();
      agent = JSON.parse(result.out).result?.agent;
    } catch { throw new ExternalSessionError("runtime-unavailable", "Attached Herdr pane unavailable; delivery is waiting for revalidation."); }
    const hooked = agent?.agent_session;
    if (knownIdentity(agent?.agent) && agent.agent !== "codex" || knownIdentity(agent?.pane_id) && agent.pane_id !== pane ||
      knownIdentity(hooked?.agent) && hooked.agent !== "codex" || hooked?.kind === "id" && knownIdentity(hooked.value) && hooked.value !== threadId)
      throw new ExternalSessionError("identity-unverified", "Attached Herdr pane/thread identity mismatch; delivery is held.");
    if (agent?.agent !== "codex" || agent.pane_id !== pane || hooked?.agent !== "codex" || hooked.kind !== "id" || !knownIdentity(hooked.value))
      throw new ExternalSessionError("runtime-unavailable", "Attached Herdr pane/thread association unavailable; delivery is waiting for revalidation.");
    // Herdr is the executing TUI's primary signal. Unknown hook states cannot
    // be interpreted as idle even when the observer happens to look idle. Done
    // is only a quiescent candidate, subject to every Codex check below.
    if (!["working", "blocked", "idle", "done"].includes(agent.agent_status))
      throw new ExternalSessionError("runtime-unavailable", "Attached Herdr execution status unknown; delivery is waiting for revalidation.");
    const [{ thread }, loaded, { goal, available }, turns] = await Promise.all([
      readThread(this.observer, threadId), readLoadedThreads(this.observer), readOptionalGoal(this.observer, threadId), readTurns(this.observer, threadId),
    ]);
    if (thread.id !== threadId)
      throw new ExternalSessionError("identity-unverified", "Attached loaded thread/cwd identity mismatch; delivery is held.");
    let sameCwd: boolean;
    try { sameCwd = realpathSync(thread.cwd) === realpathSync(cwd); }
    catch { throw new ExternalSessionError("runtime-unavailable", "Attached thread/cwd observation unavailable; delivery is waiting for revalidation."); }
    if (!sameCwd) throw new ExternalSessionError("identity-unverified", "Attached loaded thread/cwd identity mismatch; delivery is held.");
    // A shared-daemon restart can temporarily unload the exact saved thread.
    // Keep input queued and observe it again later; never resume it here.
    if (!loaded.includes(threadId) || thread.status.type === "notLoaded")
      throw new ExternalSessionError("runtime-unavailable", "Attached thread is not loaded; delivery is waiting for revalidation.");
    const active = turns.filter(turn => turn.status === "inProgress");
    if (active.length > 1) throw new ExternalSessionError("identity-unverified", "Ambiguous attached active turn; delivery is held.");
    const flags = thread.status.type === "active" ? thread.status.activeFlags : [];
    const state = thread.status.type === "systemError" ? "failed" : flags.includes("waitingOnApproval") ? "waiting_approval" :
      agent.agent_status === "blocked" || flags.includes("waitingOnUserInput") ? "waiting_input" :
      agent.agent_status === "working" || thread.status.type === "active" || active.length ? "running" : "idle";
    // A TUI working signal can precede app-server turn materialization. Keep
    // it busy without inventing an active turn ID or allowing idle dispatch.
    if (thread.status.type === "active" && !active[0]) throw new ExternalSessionError("runtime-unavailable", "Attached active turn identity unknown; delivery is waiting for revalidation.");
    await this.onObservedTurns(turns);
    // The user owns /model and effort choices. Observe them without changing or
    // pinning them as part of the pane/thread/cwd identity contract.
    return { threadId, state, activeTurnId: active[0]?.id, goal, model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined, capabilities: { messaging: true, goal: available } };
  }

  async input(text: string, id: string, onIdentityLoss: (error: unknown) => Promise<void>): Promise<{ turnId: string }> {
    const verify = async () => {
      try { return await this.inspect(); }
      catch (error) { await onIdentityLoss(error); throw new DeliveryDeferred("Attached identity unavailable; dispatch held"); }
    };
    const snap = await verify();
    if (!["idle", "running"].includes(snap.state)) throw new DeliveryDeferred("Attached session requires approval or input; dispatch held");
    const marked = operationText(text, id);
    // Read-only reconciliation is allowed; an uncertain prior send is never
    // resubmitted by this adapter. Mailbox enforces that before invoking us.
    const prior = await receipt(this.observer, this.identity.threadId, marked);
    if (prior) return { turnId: prior };
    const ready = await verify();
    if (!["idle", "running"].includes(ready.state) || ready.state === "running" && !ready.activeTurnId)
      throw new DeliveryDeferred("Attached session not ready for input; dispatch held");
    // CLI queue defers until the current turn ends. Herdr submits through the
    // verified TUI so a working lead receives this input during its active turn.
    // Choose once: an uncertain submission must never fall back to another path.
    const command = ready.state === "running"
      ? ["herdr", "agent", "prompt", this.identity.pane, marked]
      : [this.binary, "queue", "--thread", this.identity.threadId, "--message", marked];
    let failure: unknown;
    try {
      const result = await this.run(command, { timeoutMs: this.config.rpcTimeoutMs });
      if (result.code !== 0) failure = new Error("Codex input submission outcome unknown");
    } catch { failure = new Error("Codex input submission outcome unknown"); }
    const deadline = this.clock.now() + this.config.rpcTimeoutMs;
    do {
      // Verify borrowed identity before accepting any observed receipt too.
      try { await this.inspect(); } catch (error) { await onIdentityLoss(error); throw new Error("Attached identity lost after submission; delivery unknown"); }
      const turnId = await receipt(this.observer, this.identity.threadId, marked);
      if (turnId) return { turnId };
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw failure ?? new Error("Input receipt unknown; reconcile before retry");
  }
}

export const observeExternal = async <T>(run: Runner, config: RuntimeConfig, attachment: Pick<Attachment, "binary" | "socketPath" | "binaryVersion">,
  action: (observer: Observer) => Promise<T>): Promise<T> => {
  const daemon = await sharedDaemon(run, attachment.binary, config);
  if (daemon.socketPath !== attachment.socketPath) throw new ExternalSessionError("identity-unverified", "Shared Codex daemon affinity changed; explicit attachment required.");
  if (attachment.binaryVersion && daemon.binaryVersion !== attachment.binaryVersion)
    throw new ExternalSessionError("runtime-version-changed", `Shared Codex runtime version changed (attached ${safeVersion(attachment.binaryVersion)}, observed ${daemon.binaryVersion}); explicit attachment required.`);
  const observer = await connectObserver(daemon.socketPath, config.rpcTimeoutMs).catch(() => { throw new ExternalSessionError("runtime-unavailable", "Shared Codex observer unavailable; delivery is waiting for reconnection."); });
  try { return await action(observer); } catch (error) { throw observerError(error); } finally { observer.close(); }
};
