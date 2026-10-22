import { resolve } from "node:path";
import type { RuntimeConfig, RoleConfig } from "../config.ts";
import type { RuntimeSnapshot, RuntimeState } from "./types.ts";
import { RpcClient, type RpcMessage } from "./protocol.ts";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.ts";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts";
import type { ThreadGoalGetResponse } from "./generated/v2/ThreadGoalGetResponse.ts";
import type { ThreadGoalSetParams } from "./generated/v2/ThreadGoalSetParams.ts";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.ts";

export const safeEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CODEX_HOME", "OPENAI_API_KEY", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_LANE_KEY", "DORI_LANE_TOKEN", "DORI_CONTEXT"]) if (env[name]) out[name] = env[name]!;
  return out;
};
export class CodexSession {
  threadId = "";
  activeTurnId: string | undefined;
  state: RuntimeState = "starting";
  held = false;
  goalWasActive = false;
  pending = new Map<string, RpcMessage>();
  onEvent: (event: RpcMessage) => void = () => {};
  constructor(readonly rpc: RpcClient, readonly config: RuntimeConfig, readonly context?: { file: string; configFile: string; stateDir: string }) {
    rpc.onNotification = event => {
      const p = event.params;
      if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (event.method === "turn/started") { this.activeTurnId = p.turn.id; this.state = "running"; }
      if (event.method === "turn/completed" && p.turn.id === this.activeTurnId) { this.activeTurnId = undefined; this.state = p.turn.status === "failed" ? "failed" : "idle"; }
      if (event.method === "serverRequest/resolved") this.pending.delete(String(p.requestId));
      this.onEvent(event);
    };
    rpc.onRequest = event => {
      const method = event.method ?? "";
      if (![/^item\/(commandExecution|fileChange|permissions)\/requestApproval$/, /^item\/tool\/requestUserInput$/, /^mcpServer\/elicitation\/request$/].some(r => r.test(method))) {
        rpc.reject(event.id!, `Unsupported server request: ${method}`); return;
      }
      this.pending.set(String(event.id), event);
      this.state = method.includes("requestApproval") ? "waiting_approval" : "waiting_input";
      this.onEvent(event);
    };
    rpc.onDisconnect = () => { this.state = "failed"; this.onEvent({ method: "runtime/disconnected" }); };
  }
  async initialize(): Promise<void> {
    const params: InitializeParams = { clientInfo: { name: "dori", title: "Dori", version: "0.2.0" }, capabilities: null };
    await this.rpc.request("initialize", params); this.rpc.notify("initialized");
  }
  async models(): Promise<ModelListResponse["data"]> {
    const models: ModelListResponse["data"] = []; let cursor: string | null = null;
    do { const page: ModelListResponse = await this.rpc.request("model/list", { cursor }); models.push(...page.data); cursor = page.nextCursor; } while (cursor);
    return models;
  }
  async open(cwd: string, role: RoleConfig, instructions: string, threadId?: string): Promise<ThreadStartResponse> {
    const models = await this.models();
    const chosen = role.model ? models.find(m => m.model === role.model || m.id === role.model) : undefined;
    if (role.model && !chosen) throw new Error(`Codex model unavailable: ${role.model}`);
    if (role.effort && chosen && !chosen.supportedReasoningEfforts.some(e => e.reasoningEffort === role.effort)) throw new Error("Unsupported model effort");
    const params: ThreadStartParams = { cwd, model: chosen?.model, modelProvider: "openai", sandbox: this.config.sandbox,
      approvalPolicy: this.config.approvalPolicy, developerInstructions: instructions,
      config: { ...(this.context ? { "mcp_servers.dori_runtime": { command: process.execPath, args: [resolve(import.meta.dir, "../cli.ts"), "mcp-server"], env: { DORI_CONTEXT: this.context.file, DORI_CONFIG: this.context.configFile, DORI_STATE_DIR: this.context.stateDir }, enabled: true, required: true } } : {}), "features.multi_agent": false, "features.multi_agent_v2": false, "features.multi_agent_v2_dynamic_tools": false, ...(role.effort ? { model_reasoning_effort: role.effort } : {}) } };
    const response = await this.rpc.request<ThreadStartResponse>(threadId ? "thread/resume" : "thread/start", threadId ? { ...params, threadId, excludeTurns: true } : params);
    if (response.modelProvider !== "openai") throw new Error("Dori requires the OpenAI Codex provider");
    if (threadId && response.thread.id !== threadId) throw new Error("Resumed thread identity mismatch");
    this.threadId = response.thread.id; this.state = "idle";
    return response;
  }
  async inspect(): Promise<RuntimeSnapshot> {
    const [{ thread }, { goal }] = await Promise.all([
      this.rpc.request<ThreadReadResponse>("thread/read", { threadId: this.threadId }),
      this.rpc.request<ThreadGoalGetResponse>("thread/goal/get", { threadId: this.threadId }),
    ]);
    let turnId: string | undefined;
    if (thread.status.type === "active") {
      let cursor: string | null = null;
      do {
        const turns: ThreadTurnsListResponse = await this.rpc.request("thread/turns/list", { threadId: this.threadId, cursor, limit: 20, sortDirection: "desc" });
        turnId = turns.data.find(t => t.status === "inProgress")?.id; cursor = turns.nextCursor;
      } while (!turnId && cursor);
      if (!turnId) turnId = this.activeTurnId;
    }
    this.activeTurnId = turnId;
    const flags = thread.status.type === "active" ? thread.status.activeFlags : [];
    this.state = flags.includes("waitingOnApproval") ? "waiting_approval" : flags.includes("waitingOnUserInput") ? "waiting_input" : thread.status.type === "active" ? "running" : thread.status.type === "systemError" ? "failed" : thread.status.type === "notLoaded" ? "recovering" : "idle";
    return { threadId: this.threadId, state: this.state, activeTurnId: turnId, goal };
  }
  async input(text: string, operationId: string): Promise<{ turnId: string }> {
    if (this.held) throw new Error("Runtime dispatch is held");
    const snapshot = await this.inspect();
    if (["waiting_approval", "waiting_input", "recovering", "failed"].includes(snapshot.state)) throw new Error(`Runtime ${snapshot.state}`);
    const input = [{ type: "text" as const, text, text_elements: [] }];
    if (snapshot.state === "running") {
      if (!snapshot.activeTurnId) throw new Error("Active turn identity unknown");
      const params: TurnSteerParams = { threadId: this.threadId, expectedTurnId: snapshot.activeTurnId, clientUserMessageId: operationId, input };
      return this.rpc.request("turn/steer", params);
    }
    const params: TurnStartParams = { threadId: this.threadId, clientUserMessageId: operationId, input };
    const { turn } = await this.rpc.request<TurnStartResponse>("turn/start", params);
    // A completed event can arrive before the response. Inspect again rather than overwrite it.
    await this.inspect();
    return { turnId: turn.id };
  }
  async hold(origin: "user" | "automatic"): Promise<RuntimeSnapshot> {
    this.held = true;
    const snap = await this.inspect();
    if (snap.goal?.status === "active") {
      this.goalWasActive = true;
      const params: ThreadGoalSetParams = { threadId: this.threadId, status: "paused", origin };
      await this.rpc.request("thread/goal/set", params);
    }
    if (snap.state === "running" || snap.state.startsWith("waiting_")) {
      if (!snap.activeTurnId) throw new Error("Cannot interrupt unknown active turn");
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: snap.activeTurnId });
    }
    const deadline = Date.now() + this.config.rpcTimeoutMs;
    do {
      const current = await this.inspect();
      if (current.state === "idle" && current.goal?.status !== "active") return current;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    throw new Error("Runtime stop unconfirmed; dispatch remains blocked");
  }
  async release(origin: "user" | "automatic"): Promise<RuntimeSnapshot> {
    const snapshot = await this.inspect();
    if (this.goalWasActive && snapshot.goal?.status === "paused") {
      const params: ThreadGoalSetParams = { threadId: this.threadId, status: "active", origin };
      await this.rpc.request("thread/goal/set", params);
    }
    this.held = false; this.goalWasActive = false;
    return this.inspect();
  }
  answer(id: string, result: any): void {
    const req = this.pending.get(id);
    if (!req) throw new Error("Expired or unknown approval");
    const method = req.method!;
    if (method.includes("commandExecution") || method.includes("fileChange")) {
      if (!["accept", "decline", "cancel"].includes(result?.decision)) throw new Error("Use one-shot accept, decline or cancel");
      result = { decision: result.decision };
    } else if (method.includes("permissions")) {
      const requested = req.params.permissions ?? {};
      const permissions = result?.permissions;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("Expected permissions object");
      const subset = (grant: any, request: any): boolean => {
        if (Array.isArray(grant)) return Array.isArray(request) && grant.every(g => request.some(r => JSON.stringify(r) === JSON.stringify(g)));
        if (grant && typeof grant === "object") return request && typeof request === "object" && Object.keys(grant).every(k => k in request && subset(grant[k], request[k]));
        return grant === request;
      };
      if (!subset(permissions, requested)) throw new Error("Grant exceeds requested permissions");
      if (result.scope && !["turn", "session"].includes(result.scope)) throw new Error("Invalid permission scope");
      result = { permissions, scope: result.scope ?? "turn" };
    } else if (method.includes("requestUserInput")) {
      const questions = req.params.questions ?? [];
      if (!result?.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) throw new Error("Expected answers object");
      if (Object.keys(result.answers).some(k => !questions.some((q: any) => q.id === k)) || questions.some((q: any) => !Array.isArray(result.answers[q.id]?.answers) || result.answers[q.id].answers.some((s: any) => typeof s !== "string"))) throw new Error("Answers must match pending question IDs");
      result = { answers: result.answers };
    } else {
      if (!["accept", "decline", "cancel"].includes(result?.action)) throw new Error("Expected elicitation action");
      result = { action: result.action, content: result.action === "accept" ? result.content ?? null : null, _meta: null };
    }
    this.rpc.respond(req.id!, result); this.pending.delete(id);
  }
}

export const startCodex = async (config: RuntimeConfig, env = process.env): Promise<{ session: CodexSession; exited: Promise<number>; close: () => void }> => {
  const version = Bun.spawn([config.binary, "--version"], { stdout: "pipe", stderr: "pipe", env: safeEnvironment(env) });
  const versionText = (await new Response(version.stdout).text()).trim();
  if (await version.exited !== 0 || versionText !== `codex-cli ${config.requiredVersion}`) throw new Error(`Codex version mismatch: expected ${config.requiredVersion}, got ${versionText}`);
  const child = Bun.spawn([config.binary, "app-server", "--listen", "stdio://"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: safeEnvironment(env) });
  const rpc = new RpcClient({ send: line => { child.stdin.write(line); child.stdin.flush(); }, close: () => { child.kill(); } }, config.rpcTimeoutMs);
  const session = new CodexSession(rpc, config, env.DORI_CONTEXT && env.DORI_CONFIG && env.DORI_STATE_DIR ? { file: env.DORI_CONTEXT, configFile: env.DORI_CONFIG, stateDir: env.DORI_STATE_DIR } : undefined);
  void (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stdout) rpc.feed(decoder.decode(chunk, { stream: true })); rpc.feed(decoder.decode()); rpc.disconnect(); })().catch(() => rpc.disconnect());
  // Drain stderr without persisting potentially sensitive upstream diagnostics.
  void (async () => { for await (const _ of child.stderr) { /* intentionally drained */ } })();
  try { await session.initialize(); } catch (error) { rpc.disconnect(); throw error; }
  return { session, exited: child.exited, close: () => rpc.disconnect() };
};
