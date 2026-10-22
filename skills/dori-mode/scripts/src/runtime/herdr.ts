import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { RuntimeConfig, RoleConfig } from "../config.ts";
import type { Clock, Runner } from "../run.ts";
import { realClock } from "../run.ts";
import type { RuntimeSnapshot, Goal } from "./types.ts";
import type { Thread } from "./generated/v2/Thread.ts";
import { readGoal, readLoadedThreads, readTurns, receipt, type Observer } from "./observer.ts";
import { verifyTurnPolicy, PolicyPending } from "./policy.ts";
import { RpcError } from "./protocol.ts";

export type Agent = { agent?: string; pane_id: string; name?: string; interactive_ready?: boolean; agent_status: string; agent_session?: { agent: string; kind: string; value: string } };
export const operationText = (text: string, id: string): string => `${text}\n\n[DORI_OPERATION:${createHash("sha256").update(id).digest("hex")}]`;
class ReadinessPending extends Error {}
export class HerdrSession {
  threadId = "";
  held = false;
  goalWasActive = false;
  pausedGoal?: Goal;
  lastControl?: { action: "hold" | "release"; origin: "user" | "automatic"; at: string };
  private stopping = false;
  persist: () => void = () => {};
  private async observeReady<T>(deadline: number, read: () => Promise<T>): Promise<T> {
    for (;;) {
      try { return await read(); }
      catch (error) {
        if (!(error instanceof RpcError || error instanceof PolicyPending || error instanceof ReadinessPending) || this.clock.now() >= deadline) throw error;
        await this.clock.sleep(100);
      }
    }
  }
  constructor(readonly observer: Observer, readonly run: Runner, readonly config: RuntimeConfig,
    readonly pane: string, readonly name: string, readonly clock: Clock = realClock) {}
  async command(args: string[]): Promise<any> {
    const result = await this.run(["herdr", ...args], { timeoutMs: this.config.startupTimeoutMs + 5000 });
    if (result.code !== 0) {
      let code = "unknown";
      try { code = JSON.parse(result.err || result.out).error?.code ?? code; } catch { /* no raw terminal/error text in diagnostics */ }
      throw new Error(code === "agent_not_ready" ? "Herdr TUI startup blocked; inspect its pane for folder trust or required input" : `Herdr ${args[0]} ${args[1]} failed (${code}); outcome unknown`);
    }
    return args[0] === "agent" && args[1] === "read" ? { text: result.out } : result.out ? JSON.parse(result.out).result : {};
  }
  async agent(): Promise<Agent> {
    const { agent } = await this.command(["agent", "get", this.pane]);
    if (agent?.agent !== "codex" || agent.pane_id !== this.pane || agent.name !== this.name) throw new Error("TUI occupant identity changed");
    if (this.threadId && (agent.agent_session?.kind !== "id" || agent.agent_session.value !== this.threadId)) throw new Error("TUI thread identity changed");
    return agent;
  }
  async open(cwd: string, role: RoleConfig, endpoint: string, instance: string, threadId?: string): Promise<void> {
    const deadline = this.clock.now() + this.config.startupTimeoutMs;
    if (!role.model || !role.effort) throw new Error("Visible runtime requires an explicit model and reasoning effort");
    const models: any[] = []; let cursor: string | null = null;
    do { const page: any = await this.observeReady(deadline, () => this.observer.read("model/list", { cursor })); models.push(...page.data); cursor = page.nextCursor; } while (cursor);
    const model = models.find(m => m.model === role.model || m.id === role.model);
    if (!model || !model.supportedReasoningEfforts.some((e: any) => e.reasoningEffort === role.effort)) throw new Error("Configured model/effort unavailable");
    if (threadId && this.held && (await readGoal(this.observer, threadId)).goal?.status === "active") throw new Error("Recovery goal is still active; operator must reconcile before TUI resume");
    await this.command(["agent", "start", this.name, "--kind", "codex", "--pane", this.pane, "--timeout", String(this.config.startupTimeoutMs), "--",
      ...(threadId ? ["resume", threadId] : []), "--remote", endpoint, "--cd", cwd, "--model", role.model, "-c", `model_reasoning_effort=${JSON.stringify(role.effort)}`,
      ...(!threadId ? ["--sandbox", this.config.sandbox, "--ask-for-approval", this.config.approvalPolicy] : []), "--no-alt-screen"]);
    // Permission/MCP/developer settings belong to the private backend. Remote
    // resume explicitly rejects CLI permission overrides.
    await this.command(["agent", "read", this.pane, "--source", "recent-unwrapped", "--lines", "20"]);
    let handshakeTurn: string | undefined;
    {
      const text = operationText("Dori runtime handshake. Reply READY only. Do not execute a task or call tools; await the next operator message.", `handshake:${instance}`);
      // A new TUI may not have created a thread until this first tiny prompt.
      let failure: unknown, observationFailure: unknown;
      try { await this.command(["agent", "prompt", this.pane, text]); } catch (e) { failure = e; }
      do {
        const matches: string[] = [];
        const { agent } = await this.command(["agent", "get", this.pane]);
        const hooked = agent?.agent_session;
        const ids = threadId ? [threadId] : hooked?.kind === "id" && hooked.agent === "codex" ? [hooked.value] : await this.observeReady(deadline, () => readLoadedThreads(this.observer));
        for (const id of ids) {
          try { const turn = await receipt(this.observer, id, text); if (turn) { matches.push(id); handshakeTurn = turn; } }
          catch (error) {
            // SessionStart can precede materialization/rollout metadata flush.
            // Retry only protocol reads to the same endpoint until the startup
            // deadline. Duplicate receipts and local validation errors fail now.
            if (!(error instanceof RpcError)) throw error;
            observationFailure = error;
          }
        }
        if (matches.length > 1) throw new Error("Ambiguous startup thread identity");
        if (matches[0]) { threadId = matches[0]; break; }
        await this.clock.sleep(100);
      } while (this.clock.now() < deadline);
      if (!handshakeTurn || !threadId) throw observationFailure ?? failure ?? new Error("Handshake receipt unknown; do not create a replacement thread");
    }
    const { thread } = await this.observeReady(deadline, () => this.observer.read<{ thread: Thread }>("thread/read", { threadId }));
    if (thread.status.type === "notLoaded" || thread.id !== threadId || realpathSync(thread.cwd) !== realpathSync(cwd) || thread.modelProvider !== "openai" || thread.model !== role.model || thread.reasoningEffort !== role.effort) throw new Error("Backend identity/configuration mismatch");
    await this.observeReady(deadline, () => verifyTurnPolicy(thread.path, threadId!, handshakeTurn!, this.config));
    const mcp: any = await this.observeReady(deadline, () => this.observer.read("mcpServerStatus/list", { threadId, serverName: "dori_runtime" }));
    if (!mcp.data.some((server: any) => server.name === "dori_runtime" && server.runtimeStatus === "connected" && server.tools?.control)) throw new Error("Scoped Dori MCP control is not connected");
    const { agent } = await this.command(["agent", "get", this.pane]);
    if (agent?.agent !== "codex" || agent.name !== this.name || (agent.agent_session && agent.agent_session.value !== threadId)) throw new Error("TUI association conflict");
    // This is a report of the exact backend-owned handshake/resume identity,
    // never a guessed ID inferred from terminal title or idle status.
    await this.command(["pane", "report-agent-session", this.pane, "--source", "dori:codex", "--agent", "codex", "--agent-session-id", threadId]);
    this.threadId = threadId; this.persist();
    await this.observeReady(deadline, async () => {
      const snap = await this.inspect();
      const turn = (await readTurns(this.observer, this.threadId)).find(t => t.id === handshakeTurn);
      if (!turn || turn.status === "failed" || turn.status === "interrupted") throw new Error("Handshake did not finish successfully; task dispatch refused");
      if (turn.status === "inProgress" || snap.state !== "idle" || snap.activeTurnId) throw new ReadinessPending("Handshake still running; task dispatch waits");
      if (snap.goal?.status === "active") throw new Error("Unexpected active goal after handshake");
    });
  }
  async inspect(): Promise<RuntimeSnapshot> {
    const agent = await this.agent();
    const [{ thread }, { goal }, turns] = await Promise.all([
      this.observer.read<{ thread: Thread }>("thread/read", { threadId: this.threadId }), readGoal(this.observer, this.threadId), readTurns(this.observer, this.threadId),
    ]);
    if (thread.id !== this.threadId || thread.status.type === "notLoaded") throw new Error("Observer affinity lost; thread is not loaded");
    const active = turns.filter(t => t.status === "inProgress");
    if (active.length > 1) throw new Error("Multiple active turns; refuse ambiguous control");
    const flags = thread.status.type === "active" ? thread.status.activeFlags : [];
    const state = flags.includes("waitingOnApproval") ? "waiting_approval" : flags.includes("waitingOnUserInput") || agent.agent_status === "blocked" ? "waiting_input" :
      thread.status.type === "systemError" ? "failed" : thread.status.type === "active" || active.length ? "running" : "idle";
    if (state === "running" && !active[0]) throw new Error("Active turn identity unknown");
    return { threadId: this.threadId, state, activeTurnId: active[0]?.id, goal };
  }
  async input(text: string, id: string): Promise<{ turnId: string }> {
    if (this.held || this.stopping) throw new Error("Runtime dispatch is held");
    const snap = await this.inspect();
    if (!["idle", "running"].includes(snap.state)) throw new Error(`Runtime ${snap.state}`);
    const marked = operationText(text, id);
    const prior = await receipt(this.observer, this.threadId, marked);
    if (prior) return { turnId: prior };
    let failure: unknown;
    try { await this.command(["agent", "prompt", this.pane, marked]); } catch (error) { failure = error; }
    const deadline = this.clock.now() + this.config.rpcTimeoutMs;
    do {
      // A successful receipt survives a later status failure or fast completion.
      const turnId = await receipt(this.observer, this.threadId, marked);
      if (turnId) return { turnId };
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw failure ?? new Error("Prompt receipt unknown; reconcile before retry");
  }
  async hold(origin: "user" | "automatic"): Promise<RuntimeSnapshot> {
    this.lastControl = { action: "hold", origin, at: new Date(this.clock.now()).toISOString() };
    this.held = true; this.persist();
    const before = await this.inspect();
    if (before.goal?.status === "active") { this.goalWasActive = true; this.pausedGoal = before.goal; this.persist(); }
    // Blocked UI cannot accept slash commands. Escape cancels that turn; native
    // goal state must still be read back before we acknowledge a pause.
    if (before.state.startsWith("waiting_")) await this.command(["agent", "send-keys", this.pane, "esc"]);
    else if (before.goal?.status === "active") await this.command(["agent", "prompt", this.pane, "/goal pause"]);
    const deadline = this.clock.now() + this.config.rpcTimeoutMs;
    let escaped = false, paused = before.goal?.status !== "active";
    do {
      const snap = await this.inspect();
      if (snap.goal?.status !== "active") paused = true;
      if (!paused && snap.state === "idle") await this.command(["agent", "prompt", this.pane, "/goal pause"]);
      if (paused && snap.state === "running" && !escaped) { await this.command(["agent", "send-keys", this.pane, "esc"]); escaped = true; }
      if (snap.state === "idle" && !snap.activeTurnId && snap.goal?.status !== "active") {
        if (before.activeTurnId && (await readTurns(this.observer, this.threadId)).some(t => t.id === before.activeTurnId && t.status === "inProgress")) throw new Error("Original turn still running");
        return snap;
      }
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw new Error("Runtime stop unconfirmed; dispatch remains blocked");
  }
  async release(origin: "user" | "automatic"): Promise<RuntimeSnapshot> {
    this.lastControl = { action: "release", origin, at: new Date(this.clock.now()).toISOString() }; this.persist();
    let snap = await this.inspect();
    if (this.goalWasActive) {
      if (snap.goal?.status !== "paused" || (this.pausedGoal && (snap.goal.objective !== this.pausedGoal.objective || snap.goal.tokenBudget !== this.pausedGoal.tokenBudget))) throw new Error("Paused goal changed; explicit reconciliation required");
      await this.command(["agent", "prompt", this.pane, "/goal resume"]);
      const deadline = this.clock.now() + this.config.rpcTimeoutMs;
      do { snap = await this.inspect(); if (snap.goal?.status !== "paused") break; await this.clock.sleep(100); } while (this.clock.now() < deadline);
      if (!snap.goal || snap.goal.status === "paused") throw new Error("Goal resume unconfirmed");
    } else if (snap.goal?.status === "active") throw new Error("Unexpected active goal while held");
    this.held = false; this.goalWasActive = false; this.pausedGoal = undefined; this.persist(); return snap;
  }
  async stop(): Promise<void> {
    await this.hold("automatic"); this.stopping = true;
    await this.command(["agent", "send-keys", this.pane, "ctrl+d"]);
    const deadline = this.clock.now() + this.config.rpcTimeoutMs;
    do {
      const { pane } = await this.command(["pane", "get", this.pane]);
      if (!pane?.agent) return;
      if (pane.agent !== "codex") throw new Error("TUI replaced while stopping");
      await this.clock.sleep(100);
    } while (this.clock.now() < deadline);
    throw new Error("TUI exit unconfirmed; backend retained");
  }
}
