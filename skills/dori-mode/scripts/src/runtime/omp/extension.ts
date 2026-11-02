import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { OmpError, assertIdentity, exactKeys, nonempty, object, payloadHash, type OmpExtensionBootstrap, type OmpTarget } from "./contract.ts";
import { parseOmpVersion } from "./launcher.ts";
import { durableJson, privateDirectory, readPrivateJson } from "./receipts.ts";
import { OmpControlServer, type OmpContext, type OmpNativeApi } from "./server.ts";
import { connectServiceTool, type OmpServiceTool } from "./service-tool.ts";

type Event = { type: string; [key: string]: unknown };
export type OmpExtensionApi = OmpNativeApi & {
  on(event: string, handler: (event: Event, ctx: OmpContext) => unknown): void;
  registerTool(tool: unknown): void;
};
export type OmpExtensionOptions = {
  env?: NodeJS.ProcessEnv; runtimeVersion?: string; timeoutMs?: number;
  herdrPane?: (paneId: string) => Promise<{ pane_id: string; terminal_id: string; cwd: string; agent?: string; agent_session?: { kind: string; value: string; agent: string; source: string } }>;
};
export function parseBootstrap(value: unknown): OmpExtensionBootstrap {
  if (!object(value) || !exactKeys(value, ["protocol", "registryDir", "role", "laneKey", "expectedCwd", "expectedPaneId", "expectedTerminalId"], ["expectedSessionId", "expectedSessionFile", "service"]) || value.protocol !== 1 ||
    !["attached-lead", "managed-lane"].includes(value.role as string) || !["registryDir", "laneKey", "expectedCwd", "expectedPaneId", "expectedTerminalId"].every(key => nonempty(value[key])) ||
    !isAbsolute(value.registryDir as string) || !isAbsolute(value.expectedCwd as string) ||
    (value.expectedSessionId !== undefined && !nonempty(value.expectedSessionId)) || (value.expectedSessionFile !== undefined && (!nonempty(value.expectedSessionFile) || !isAbsolute(value.expectedSessionFile))) ||
    (value.role === "attached-lead" && (value.laneKey !== "lead" || value.service !== undefined))) throw new OmpError("invalid-bootstrap", "Invalid OMP extension bootstrap", false);
  if (value.role === "managed-lane") {
    const s = value.service;
    if (!object(s) || !exactKeys(s, ["contextFile", "configFile", "stateDir", "cliPath", "bunBinary"]) || !Object.values(s).every(path => nonempty(path) && isAbsolute(path))) throw new OmpError("invalid-bootstrap", "Managed OMP requires explicit scoped service paths", false);
  }
  return value as OmpExtensionBootstrap;
}

/** Explicit opt-in only. Uses a small structural boundary to keep native OMP out of Iyen's install. */
export async function registerOmpExtension(native: unknown, options: OmpExtensionOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (!env.IYEN_OMP_BOOTSTRAP && !env.IYEN_OMP_REGISTRY_DIR) return;
  const bootstrap = env.IYEN_OMP_BOOTSTRAP ? parseBootstrap(readPrivateJson(env.IYEN_OMP_BOOTSTRAP)) : undefined;
  const registryDir = bootstrap?.registryDir ?? env.IYEN_OMP_REGISTRY_DIR!;
  if (!isAbsolute(registryDir)) throw new OmpError("invalid-registry", "OMP registry must be an explicit absolute path", false);
  privateDirectory(registryDir);
  if (!object(native) || typeof native.on !== "function" || typeof native.sendUserMessage !== "function" || typeof native.getThinkingLevel !== "function" || typeof native.registerTool !== "function") throw new OmpError("sdk-incompatible", "OMP extension SDK incompatible", false);
  const api = native as unknown as OmpExtensionApi;
  // OMP injects its own SDK exports as api.pi; do not resolve a second runtime dependency.
  const version = parseOmpVersion(options.runtimeVersion ?? (object(native.pi) ? native.pi.VERSION as string : ""));
  const herdrPane = options.herdrPane ?? (async (paneId: string) => {
    const { stdout } = await promisify(execFile)("herdr", ["pane", "get", paneId], { timeout: 5000, maxBuffer: 65536 });
    const result = JSON.parse(stdout); if (!object(result?.result?.pane)) throw new Error("Herdr pane unavailable");
    return result.result.pane;
  });
  const instanceId = randomUUID(), startedAt = new Date().toISOString(); let generation = 0;
  let controller: OmpControlServer | undefined, descriptor: string | undefined, tokenFile: string | undefined;
  let service: OmpServiceTool | undefined, current: OmpContext | undefined, lifecycle = Promise.resolve();
  let epoch = 0;
  const cleanup = () => {
    epoch++; controller?.close(); controller = undefined; service?.close(); service = undefined;
    for (const path of [descriptor, tokenFile]) if (path) { try { unlinkSync(path); } catch { /* Only this generation's random paths. */ } }
    descriptor = undefined; tokenFile = undefined;
  };
  const start = async (ctx: OmpContext) => {
    cleanup(); const startupEpoch = epoch;
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
    current = ctx;
    const paneId = bootstrap?.expectedPaneId ?? env.HERDR_PANE_ID;
    if (!paneId || (env.HERDR_PANE_ID && env.HERDR_PANE_ID !== paneId)) throw new OmpError("pane-mismatch", "OMP requires an exact verified Herdr pane", false);
    const pane = await herdrPane(paneId);
    if (pane.pane_id !== paneId || !nonempty(pane.terminal_id) || (bootstrap && pane.terminal_id !== bootstrap.expectedTerminalId)) throw new OmpError("terminal-mismatch", "OMP Herdr terminal identity mismatch", false);
    await ctx.sessionManager.ensureOnDisk();
    const file = ctx.sessionManager.getSessionFile(); if (!file) throw new OmpError("session-unpersisted", "OMP session file unavailable", false);
    const cwd = realpathSync(ctx.cwd), sessionFile = realpathSync(file), sessionId = ctx.sessionManager.getSessionId();
    if ((bootstrap && cwd !== bootstrap.expectedCwd) || (generation === 0 && bootstrap?.expectedSessionId && sessionId !== bootstrap.expectedSessionId) || (generation === 0 && bootstrap?.expectedSessionFile && sessionFile !== bootstrap.expectedSessionFile)) throw new OmpError("bootstrap-identity-mismatch", "OMP session does not match bootstrap", false);
    if (startupEpoch !== epoch) return;
    generation++;
    const name = payloadHash(`${instanceId}:${generation}`);
    const socketRoot = `/tmp/iyen-omp-${process.getuid?.() ?? "user"}`;
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 }); const socketDir = realpathSync(socketRoot); privateDirectory(socketDir);
    const token = randomBytes(32).toString("hex");
    tokenFile = join(registryDir, `${name}.token`); writeFileSync(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
    const target: OmpTarget = { kind: "omp", protocol: 1, sessionId, sessionFile, cwd, paneId, terminalId: pane.terminal_id, instanceId, generation,
      role: bootstrap?.role ?? "attached-lead", laneKey: bootstrap?.laneKey ?? "lead", runtimeVersion: version!, socketPath: join(socketDir, `${name.slice(0, 32)}.sock`), tokenFile };
    assertIdentity((({ socketPath: _socket, tokenFile: _token, ...identity }) => identity)(target));
    const verifyAssociation = async () => {
      const actual = await herdrPane(paneId);
      if (actual.pane_id !== paneId || actual.terminal_id !== target.terminalId || actual.agent !== "omp" || !nonempty(actual.cwd) || realpathSync(actual.cwd) !== target.cwd ||
        !actual.agent_session || actual.agent_session.agent !== "omp" || actual.agent_session.source !== "herdr:omp" || actual.agent_session.kind !== "path" || actual.agent_session.value !== target.sessionFile) {
        throw new OmpError("association-mismatch", "OMP exact Herdr path/source/pane/terminal/cwd association unavailable; outcome unknown");
      }
    };
    // Native SessionStart can precede the Herdr hook report. Retry only these reads;
    // do not publish an attachable descriptor until every association field matches.
    const associationDeadline = Date.now() + (options.timeoutMs ?? 15000);
    for (;;) {
      if (startupEpoch !== epoch) return;
      try { await verifyAssociation(); break; }
      catch (error) { if (Date.now() >= associationDeadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (bootstrap?.service) service = await connectServiceTool(bootstrap.service, { env, timeoutMs: options.timeoutMs });
    if (startupEpoch !== epoch) { service?.close(); return; }
    const sessionsRoot = join(registryDir, "sessions"); privateDirectory(sessionsRoot);
    const sessionDirectory = join(sessionsRoot, payloadHash([sessionId, sessionFile, target.role, target.laneKey].join("\0")));
    const ownedController = new OmpControlServer(target, token, sessionDirectory, () => current!, api, { timeoutMs: options.timeoutMs,
      startHeld: !!bootstrap?.expectedSessionId,
      verifyAssociation,
    });
    controller = ownedController;
    await ownedController.listen();
    if (startupEpoch !== epoch) { ownedController.close(); return; }
    descriptor = join(registryDir, `${name}.json`); durableJson(descriptor, { ...target, pid: process.pid, startedAt });
  };
  const scheduleStart = (ctx: OmpContext) => {
    cleanup(); current = ctx;
    lifecycle = lifecycle.catch(() => {}).then(() => start(ctx)); return lifecycle;
  };
  // Do not await registry readiness from SessionStart: the native Herdr hook may run later.
  // Publication stays gated, while OMP remains free to finish startup and report its session.
  const startInBackground = (ctx: OmpContext) => { void scheduleStart(ctx).catch(() => { cleanup(); }); };
  api.on("session_start", (_event, ctx) => { startInBackground(ctx); });
  api.on("session_before_switch", () => { cleanup(); });
  api.on("session_switch", (_event, ctx) => { startInBackground(ctx); });
  api.on("session_shutdown", () => { cleanup(); });
  for (const event of ["agent_start", "agent_end", "turn_start", "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "tool_approval_requested", "tool_approval_resolved", "plan_review_requested", "plan_review_resolved", "mode_changed", "session_compact", "session.compacting"]) {
    api.on(event, (value, ctx) => { if (ctx.agent.kind === "main") { current = ctx; controller?.observe(value); } });
  }
  if (bootstrap?.role === "managed-lane") {
    api.on("before_subagent_spawn", () => ({ block: true, reason: "Managed Iyen lanes cannot spawn native subagents" }));
    api.on("tool_call", (_event, ctx) => ctx.agent.kind !== "main" || !controller || controller.toolBlocked() ? { block: true, reason: "Iyen managed runtime is held or unavailable" } : undefined);
    const kind = Symbol.for("TypeBox.Kind");
    api.registerTool({ name: "iyen_control", label: "Iyen control", description: "Report or inspect your own Iyen lane through its scoped service capability.", mcpServerName: "dori_runtime", mcpToolName: "control", approval: "read",
      parameters: { [kind]: "Object", type: "object", properties: { action: { [kind]: "String", type: "string" }, args: { [kind]: "Object", type: "object", properties: {}, additionalProperties: true } }, required: ["action", "args"], additionalProperties: false },
      execute: async (_callId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: OmpContext) => {
        if (ctx.agent.kind !== "main" || !service || !controller || controller.toolBlocked() || !object(params) || !exactKeys(params, ["action", "args"]) || !nonempty(params.action) || !object(params.args)) throw new OmpError("service-tool-blocked", "Scoped Iyen tool is unavailable", false);
        return service.call(params.action, params.args, signal);
      },
    });
  }
}
export default async function extension(api: unknown): Promise<void> { await registerOmpExtension(api); }
