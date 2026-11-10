import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { OmpError, assertIdentity, exactKeys, nonempty, object, payloadHash, validRestartIntent, validLaunchMetadata, sameLaunchMetadata, type OmpExtensionBootstrap, type OmpTarget } from "./contract.ts";
import { parseOmpVersion } from "./launcher.ts";
import { durableJson, privateDirectory, readPrivateJson } from "./receipts.ts";
import { OmpControlServer, type OmpContext, type OmpNativeApi } from "./server.ts";

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
  if (!object(value) || !exactKeys(value, ["protocol", "registryDir", "role", "laneKey", "expectedCwd", "expectedPaneId", "expectedTerminalId"], ["expectedSessionId", "expectedSessionFile", "restart"]) || value.protocol !== 1 ||
    value.role !== "attached-lead" || !["registryDir", "laneKey", "expectedCwd", "expectedPaneId", "expectedTerminalId"].every(key => nonempty(value[key])) ||
    !isAbsolute(value.registryDir as string) || !isAbsolute(value.expectedCwd as string) ||
    (value.expectedSessionId !== undefined && !nonempty(value.expectedSessionId)) || (value.expectedSessionFile !== undefined && (!nonempty(value.expectedSessionFile) || !isAbsolute(value.expectedSessionFile))) ||
    value.laneKey !== "lead") throw new OmpError("invalid-bootstrap", "Invalid OMP extension bootstrap", false);
  if (value.restart !== undefined && (!validRestartIntent(value.restart) || !value.restart.previousTarget ||
    value.role !== "attached-lead" || value.expectedSessionId !== value.restart.previousTarget.sessionId ||
    value.expectedSessionFile !== value.restart.previousTarget.sessionFile ||
    value.expectedPaneId !== value.restart.previousTarget.paneId || value.expectedTerminalId !== value.restart.previousTarget.terminalId ||
    value.expectedCwd !== value.restart.previousTarget.cwd)) throw new OmpError("invalid-restart-bootstrap", "Restart bootstrap must pin exact previous native session", false);
  return value as OmpExtensionBootstrap;
}

/** Explicit opt-in only. Uses a small structural boundary to keep native OMP out of Iyen's install. */
export async function registerOmpExtension(native: unknown, options: OmpExtensionOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (!object(native) || typeof native.on !== "function" || typeof native.sendUserMessage !== "function" || typeof native.getThinkingLevel !== "function" || typeof native.registerTool !== "function") throw new OmpError("sdk-incompatible", "OMP extension SDK incompatible", false);
  const api = native as unknown as OmpExtensionApi;
  // Native --iyen-omp-bootstrap is extracted BEFORE extension factory loading.
  // Extension getFlag() is populated later and cannot configure this factory.
  const bootstrapPath = env.IYEN_OMP_BOOTSTRAP;
  if (!bootstrapPath && !env.IYEN_OMP_REGISTRY_DIR) return;
  const bootstrap = bootstrapPath ? parseBootstrap(readPrivateJson(bootstrapPath)) : undefined;
  const registryDir = bootstrap?.registryDir ?? env.IYEN_OMP_REGISTRY_DIR!;
  if (!isAbsolute(registryDir)) throw new OmpError("invalid-registry", "OMP registry must be an explicit absolute path", false);
  privateDirectory(registryDir);
  // OMP injects its own SDK exports as api.pi; do not resolve a second runtime dependency.
  const version = parseOmpVersion(options.runtimeVersion ?? (object(native.pi) ? native.pi.VERSION as string : ""));
  const herdrPane = options.herdrPane ?? (async (paneId: string) => {
    const { stdout } = await promisify(execFile)("herdr", ["pane", "get", paneId], { timeout: 5000, maxBuffer: 65536 });
    const result = JSON.parse(stdout); if (!object(result?.result?.pane)) throw new Error("Herdr pane unavailable");
    return result.result.pane;
  });
  const instanceId = randomUUID(), startedAt = new Date().toISOString(); let generation = 0;
  let controller: OmpControlServer | undefined, descriptor: string | undefined, tokenFile: string | undefined;
  let current: OmpContext | undefined, lifecycle = Promise.resolve();
  let epoch = 0;
  const cleanup = () => {
    epoch++; controller?.close(); controller = undefined;
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
    if (startupEpoch !== epoch) return;
    const sessionsRoot = join(registryDir, "sessions"); privateDirectory(sessionsRoot);
    const sessionDirectory = join(sessionsRoot, payloadHash([sessionId, sessionFile, target.role, target.laneKey].join("\0")));
    const ownedController = new OmpControlServer(target, token, sessionDirectory, () => current!, api, { timeoutMs: options.timeoutMs,
      startHeld: !!bootstrap?.expectedSessionId && !!bootstrap.restart,
      restart: bootstrap?.restart,
      verifyAssociation,
    });
    controller = ownedController;
    await ownedController.listen();
    if (startupEpoch !== epoch) { ownedController.close(); return; }
    descriptor = join(registryDir, `${name}.json`); durableJson(descriptor, { ...target, pid: process.pid, startedAt });
  };
  const scheduleStart = (ctx: OmpContext) => {
    cleanup(); current = ctx;
    if (bootstrap?.restart) {
      const core = ctx.executionHold;
      if (!core?.tryHoldForRestart || core.isRestartStartupHeld?.() !== true)
        throw new OmpError("restart-fresh-native-required", "Restart bootstrap requires a fresh --start-held native process", false);
      const metadata = core.getLaunchMetadata?.();
      if (!validLaunchMetadata(metadata) || metadata.agentDir !== metadata.settingsHome ||
        !sameLaunchMetadata(metadata, bootstrap.restart.launchMetadata))
        throw new OmpError("restart-launch-mismatch", "Fresh native launch profile differs from original borrowed lead", false);
      // Adopt the constructor-time fence before disk/Herdr awaits in start().
      const latch = core.tryHoldForRestart(bootstrap.restart.operationId, bootstrap.restart.authorizationHash);
      lifecycle = lifecycle.catch(() => {}).then(async () => {
        const held = await latch;
        if (held?.status !== "held") throw new OmpError("restart-startup-busy", "Fresh startup did not acquire idle latch", false);
        await start(ctx);
      });
      return lifecycle;
    }
    lifecycle = lifecycle.catch(() => {}).then(() => start(ctx)); return lifecycle;
  };
  // Do not await registry readiness from SessionStart: the native Herdr hook may run later.
  // Publication stays gated, while OMP remains free to finish startup and report its session.
  const startInBackground = (ctx: OmpContext) => { void scheduleStart(ctx).catch(() => { cleanup(); }); };
  api.on("session_start", (_event, ctx) => { startInBackground(ctx); });
  api.on("session_before_switch", () => { cleanup(); });
  api.on("session_switch", (_event, ctx) => { startInBackground(ctx); });
  api.on("session_shutdown", () => { cleanup(); });
  for (const event of ["user_interaction_requested", "user_interaction_resolved", "agent_start", "agent_end", "turn_start", "turn_end", "message_end", "tool_execution_start", "tool_execution_end", "tool_approval_requested", "tool_approval_resolved", "plan_review_requested", "plan_review_resolved", "mode_changed", "session_compact", "session.compacting", "auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end"]) {
    api.on(event, (value, ctx) => { if (ctx.agent.kind === "main") { current = ctx; controller?.observe(value); } });
  }
}
export default async function extension(api: unknown): Promise<void> { await registerOmpExtension(api); }
