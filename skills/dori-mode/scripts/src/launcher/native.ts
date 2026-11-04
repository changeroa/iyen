import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "../config.ts";
import { atomicJson } from "../journal.ts";
import type { Runner } from "../run.ts";
import { discoverExternal, THREAD_UUID } from "../runtime/external-current-session.ts";
import { operationText } from "../runtime/herdr.ts";
import { connectObserver, readLoadedThreads, readThread, receipt } from "../runtime/observer.ts";
import { connectOmp } from "../runtime/omp/client.ts";
import { discoverOmpSafe, findOmpTarget, ompVersionMatches } from "../runtime/omp-integration.ts";
import { prepareOmpLaunch } from "../runtime/omp/launcher.ts";
export type Identity = { threadId: string; pane: string; cwd: string; terminalId?: string; sessionFile?: string };
export type LaunchRecord = { version: 1; operationId: string; configPath: string; phase: "prepared" | "native-starting" | "native-ready" | "attached" | "ready"; pane?: string; terminalId?: string; cwd: string; identity?: Identity; model: string; effort: string; nativeProcess?: { pid: number; pane: string; terminalId: string; verified?: boolean }; handshakeAttempted?: boolean; initialize?: boolean; attachmentRequest?: { action: "lead-activate" | "lead-reconnect"; args: Record<string, unknown>; completed?: boolean }; bootstrap?: { operationId: string; text: string; phase: "sending" | "received" }; attachment?: { instance: string; generation: number } };
export const agentName = (operationId: string) => `iyen-${operationId.replaceAll("-", "").slice(0, 24)}`;
export async function herdr(runner: Runner, args: string[], timeoutMs = 30000): Promise<any> {
  const result = await runner(["herdr", ...args], { timeoutMs });
  if (result.code) throw new Error(`Herdr ${args.slice(0,2).join(" ")} unavailable; recorded outcome must be reconciled`);
  return result.out ? JSON.parse(result.out).result : {};
}
export async function preflight(config: DoriConfig, runner: Runner) {
  const kind = config.runtime.kind, binary = kind === "codex" ? (await discoverExternal(runner, config.runtime)).binary : config.runtime.binary;
  const canonical = Bun.which(kind);
  if (!canonical || realpathSync(canonical) !== realpathSync(binary)) throw new Error(`Herdr canonical ${kind} executable must match the configured native binary`);
  if (kind === "codex") {
    const daemon = await discoverExternal(runner, config.runtime), observer = await connectObserver(daemon.socketPath, config.runtime.rpcTimeoutMs);
    try {
      let cursor: string | null = null; const models: any[] = [];
      do { const page: any = await observer.read("model/list", { cursor }); if (!Array.isArray(page.data)) throw new Error("Codex model capabilities unavailable"); models.push(...page.data); cursor = page.nextCursor; } while (cursor);
      const role = config.runtime.roles.lead, model = models.find(m => m.model === role.model || m.id === role.model);
      if (!model || !model.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === role.effort)) throw new Error("Configured native lead model/effort unavailable");
    } finally { observer.close(); }
  }
  if (kind === "omp") {
    if (!config.runtime.omp || !existsSync(config.runtime.omp.extensionPath) || !config.runtime.settingsHome || !existsSync(config.runtime.settingsHome)) throw new Error("Configured OMP extension/settings paths missing");
    const version = await runner([binary, "--version"]);
    if (version.code || !ompVersionMatches(version.out, config.runtime.requiredVersion)) throw new Error("Pinned OMP version mismatch");
    if (!config.runtime.settingsHome || !config.runtime.omp) throw new Error("Isolated OMP settings required");
    prepareOmpLaunch({ binary, registryDir: config.runtime.omp.registryDir, extensionPath: config.runtime.omp.extensionPath, bootstrapFile: join(config.stateDir, "launcher", "preflight.json"), cwd: realpathSync(config.defaultCwd), provider: config.runtime.omp.provider, model: config.runtime.roles.lead.model!, effort: config.runtime.roles.lead.effort!, approvalMode: config.runtime.omp.approvalMode });
  }
}
/** A complete agent and pane snapshot is mandatory before restoring a conversation. */
export async function selectPane(config: DoriConfig, saved: Identity | undefined, record: LaunchRecord, runner: Runner, persist: () => void, dryRun = false) {
  const { agents } = await herdr(runner, ["agent", "list"]);
  const { panes } = await herdr(runner, ["pane", "list"]);
  if (!Array.isArray(agents) || !Array.isArray(panes) || agents.some(a => !a?.pane_id || typeof a.agent !== "string" || !a.agent) || panes.some(p => !p?.pane_id || !p.terminal_id)) throw new Error("Complete Herdr ownership snapshot unavailable; refusing ambiguous resume");
  if (new Set(panes.map(p => p.pane_id)).size !== panes.length || new Set(agents.map(a => a.pane_id)).size !== agents.length) throw new Error("Duplicate Herdr ownership snapshot entries");
  const expectedPane = record.pane ?? saved?.pane;
  const exactOwners = saved ? agents.filter(a => a.agent_session?.value === (saved.sessionFile ?? saved.threadId)) : [];
  if (exactOwners.length > 1 || exactOwners.some(a => a.pane_id !== expectedPane)) throw new Error("Saved native session already has another or ambiguous TUI owner");
  if (expectedPane) {
    const pane = panes.find(p => p.pane_id === expectedPane);
    if (pane) {
      if (record.terminalId && pane.terminal_id !== record.terminalId || saved?.terminalId && expectedPane === saved.pane && pane.terminal_id !== saved.terminalId || realpathSync(pane.cwd) !== record.cwd) throw new Error("Saved pane terminal/cwd identity changed; refusing launch");
      const occupant = agents.find(a => a.pane_id === expectedPane);
      if (pane.agent || occupant) {
        const pendingStartup = record.phase === "native-starting" && occupant?.agent === config.runtime.kind && occupant.name === agentName(record.operationId) && (!saved || config.runtime.kind === "codex" && !occupant.agent_session);
        if (!pendingStartup && (!saved || occupant?.agent !== config.runtime.kind || occupant.agent_session?.value !== (saved.sessionFile ?? saved.threadId) || exactOwners.length !== 1)) throw new Error("Saved pane is occupied by a different or unknown conversation");
        record.pane = pane.pane_id; record.terminalId = pane.terminal_id; persist(); return { pane, occupied: true };
      }
      record.pane = pane.pane_id; record.terminalId = pane.terminal_id; persist(); return { pane, occupied: false };
    }
    if (exactOwners.length) throw new Error("Saved pane absence conflicts with agent ownership snapshot");
    if (record.phase === "native-starting") throw new Error("Recorded startup pane disappeared; reconcile the startup intent before replacing it");
  }
  if (dryRun) return { pane: undefined, occupied: false };
  const workspace = config.leadWorkspace ?? config.laneWorkspace;
  const made = await herdr(runner, ["tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", record.cwd, "--label", `iyen-${config.runtime.kind}`, "--no-focus"]);
  const pane = made.root_pane;
  if (!pane?.pane_id || !pane.terminal_id) throw new Error("Created pane identity unavailable; inspect Herdr before retry");
  record.pane = pane.pane_id; record.terminalId = pane.terminal_id; persist(); return { pane, occupied: false };
}
export async function nativeLead(config: DoriConfig, saved: Identity | undefined, record: LaunchRecord, occupied: boolean, runner: Runner, persist: () => void): Promise<Identity> {
  const kind = config.runtime.kind, timeout = config.runtime.startupTimeoutMs, deadline = Date.now() + timeout;
  if (kind === "omp") {
    const omp = config.runtime.omp!, bootstrapFile = join(config.stateDir, "launcher", `${record.operationId}.omp.json`);
    const inspect = async (): Promise<Identity | undefined> => {
      const targets = (await discoverOmpSafe(omp.registryDir)).filter(t => t.paneId === record.pane || saved && t.sessionFile === saved.sessionFile);
      if (!targets.length) return;
      if (targets.length !== 1) throw new Error("Ambiguous native OMP target");
      const target = targets[0]!;
      if (saved && (target.sessionId !== saved.threadId || target.sessionFile !== saved.sessionFile)) throw new Error("OMP resumed a different conversation");
      await findOmpTarget(config, { sessionId: target.sessionId, sessionFile: target.sessionFile, pane: record.pane!, terminalId: record.terminalId!, cwd: record.cwd }, runner);
      const client = await connectOmp(target);
      try { const snap = await client.inspect(); if (snap.held || snap.goal?.status === "paused" || !snap.capabilities.input || snap.provider !== omp.provider || snap.model !== record.model || snap.effort !== record.effort) throw new Error("OMP is held or native effective model/effort/input differs; owner reconciliation required"); } finally { client.close(); }
      return { threadId: target.sessionId, sessionFile: target.sessionFile, pane: target.paneId, terminalId: target.terminalId, cwd: target.cwd };
    };
    const existing = await inspect(); if (existing) return existing;
    if (occupied) throw new Error("Existing OMP TUI has no authenticated exact controller; load the configured Iyen extension");
    if (record.phase !== "native-starting") {
      atomicJson(bootstrapFile, { protocol: 1, role: "attached-lead", laneKey: "lead", registryDir: omp.registryDir, expectedCwd: record.cwd, expectedPaneId: record.pane, expectedTerminalId: record.terminalId,
        ...(saved ? { expectedSessionId: saved.threadId, expectedSessionFile: saved.sessionFile } : {}) });
      const spec = prepareOmpLaunch({ binary: config.runtime.binary, registryDir: omp.registryDir, bootstrapFile, extensionPath: omp.extensionPath, cwd: record.cwd, provider: omp.provider, model: record.model, effort: record.effort, approvalMode: omp.approvalMode, resumeSessionFile: saved?.sessionFile });
      record.phase = "native-starting"; persist();
      // A nonzero start result is uncertain; only discovery below can settle it.
      await runner(["herdr", "agent", "start", agentName(record.operationId), "--kind", "omp", "--pane", record.pane!, "--timeout", String(timeout), "--", "--agent-dir", config.runtime.settingsHome!, "--cwd", record.cwd, "--iyen-omp-bootstrap", bootstrapFile, ...spec.argv.slice(1)], { timeoutMs: timeout + 5000 });
    }
    do { const target = await inspect(); if (target) return target; await Bun.sleep(100); } while (Date.now() < deadline);
    throw new Error("OMP startup outcome unknown; exact launch intent retained, retry to reconcile without relaunch");
  }
  const daemon = await discoverExternal(runner, config.runtime), observer = await connectObserver(daemon.socketPath, config.runtime.rpcTimeoutMs);
  try {
    const verify = async (id: string) => {
      const { thread } = await readThread(observer, id);
      if (!THREAD_UUID.test(id) || thread.id !== id || realpathSync(thread.cwd) !== record.cwd || thread.status.type === "notLoaded" || thread.model !== record.model || thread.reasoningEffort !== record.effort) throw new Error("Exact Codex UUID/cwd/effective model/effort mismatch");
      return { threadId: id, pane: record.pane!, terminalId: record.terminalId!, cwd: record.cwd };
    };
    const nativeArgs = [
      ...(saved ? ["resume", saved.threadId] : []), "--remote", `unix://${daemon.socketPath}`, "--cd", record.cwd, "--model", record.model, "-c", `model_reasoning_effort=${JSON.stringify(record.effort)}`,
      ...(!saved ? ["--sandbox", config.runtime.sandbox, "--ask-for-approval", config.runtime.approvalPolicy] : []), "--no-alt-screen",
    ];
    if (!occupied && record.phase !== "native-starting") {
      record.phase = "native-starting"; persist();
      await runner(["herdr", "agent", "start", agentName(record.operationId), "--kind", "codex", "--pane", record.pane!, "--timeout", String(timeout), "--", ...nativeArgs], { timeoutMs: timeout + 5000 });
    }
    // A shared-daemon resume may never emit a session hook before user input.
    // Only this journal's exact named launch can use read-only process proof.
    const proveResumeProcess = async () => {
      if (!saved || record.phase !== "native-starting" && !(record.nativeProcess && ["native-ready", "attached"].includes(record.phase))) throw new Error("Unassociated Codex resume lacks a recorded launcher start intent");
      const [{ agent }, { pane }, { process_info: info }] = await Promise.all([
        herdr(runner, ["agent", "get", record.pane!]),
        herdr(runner, ["pane", "get", record.pane!]),
        herdr(runner, ["pane", "process-info", "--pane", record.pane!]),
      ]);
      if (agent?.agent !== "codex" || agent.pane_id !== record.pane || agent.name !== agentName(record.operationId) ||
        agent.agent_session && (agent.agent_session.agent !== "codex" || agent.agent_session.kind !== "id" || agent.agent_session.value !== saved.threadId) ||
        pane?.pane_id !== record.pane || !record.terminalId || pane.terminal_id !== record.terminalId || realpathSync(pane.cwd) !== record.cwd ||
        info?.pane_id !== record.pane || !Array.isArray(info.foreground_processes) || info.foreground_processes.length !== 1) throw new Error("Recorded Codex resume pane/process ownership mismatch");
      const process = info.foreground_processes[0];
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || process.pid !== info.foreground_process_group_id || process.pid === info.shell_pid ||
        process.name !== "codex" || realpathSync(process.cwd) !== record.cwd || !Array.isArray(process.argv) ||
        !["codex", daemon.binary].includes(process.argv[0]) || JSON.stringify(process.argv.slice(1)) !== JSON.stringify(nativeArgs)) throw new Error("Exact foreground Codex resume command not proven");
      const pinned = { pid: process.pid, pane: record.pane!, terminalId: record.terminalId };
      if (record.nativeProcess && (record.nativeProcess.pid !== pinned.pid || record.nativeProcess.pane !== pinned.pane || record.nativeProcess.terminalId !== pinned.terminalId)) throw new Error("Recorded Codex resume process was replaced");
      if (!record.nativeProcess) { record.nativeProcess = pinned; persist(); }
    };
    const text = operationText("Iyen runtime startup handshake. Reply READY only. Do not call tools or begin work; await the next operator message.", `launcher:${record.operationId}`);
    if (!saved && !record.handshakeAttempted) {
      const { agent } = await herdr(runner, ["agent", "get", record.pane!]);
      if (agent?.agent !== "codex" || agent.pane_id !== record.pane) throw new Error("Codex startup occupant not verified; handshake not sent");
      record.handshakeAttempted = true; persist();
      await runner(["herdr", "agent", "prompt", record.pane!, text], { timeoutMs: config.runtime.rpcTimeoutMs });
    }
    do {
      const { agent } = await herdr(runner, ["agent", "get", record.pane!]);
      if (agent?.agent !== "codex" || agent.pane_id !== record.pane) throw new Error("Codex pane occupant changed during startup");
      const hooked = agent.agent_session;
      if (saved) {
        if (hooked?.value && (hooked.agent !== "codex" || hooked.kind !== "id" || hooked.value !== saved.threadId)) throw new Error("Resumed Codex association differs from saved UUID");
        if (hooked?.value === saved.threadId) { if (record.nativeProcess && !record.nativeProcess.verified) { await proveResumeProcess(); const identity = await verify(saved.threadId); await proveResumeProcess(); record.nativeProcess.verified = true; persist(); return identity; } return await verify(saved.threadId); }
        if (hooked) throw new Error("Resumed Codex association is malformed; refusing process fallback");
        await proveResumeProcess();
        if (!(await readLoadedThreads(observer)).includes(saved.threadId)) throw new Error("Exact resumed Codex UUID is not loaded in the shared observer");
        const identity = await verify(saved.threadId);
        await proveResumeProcess();
        await herdr(runner, ["pane", "report-agent-session", record.pane!, "--source", "iyen:codex", "--agent", "codex", "--agent-session-id", identity.threadId]);
        await proveResumeProcess();
        const { agent: reported } = await herdr(runner, ["agent", "get", record.pane!]);
        if (reported?.agent !== "codex" || reported.pane_id !== record.pane || reported.agent_session?.agent !== "codex" || reported.agent_session.kind !== "id" || reported.agent_session.value !== saved.threadId) throw new Error("Reported Codex resume association unconfirmed; retry exact process reconciliation");
        record.nativeProcess!.verified = true; persist();
        return identity;
      } else {
        const matches: string[] = [];
        for (const id of await readLoadedThreads(observer)) if (await receipt(observer, id, text)) matches.push(id);
        if (matches.length > 1) throw new Error("Ambiguous Codex startup receipts");
        if (matches[0]) {
          if (hooked?.value && hooked.value !== matches[0]) throw new Error("Codex receipt and TUI association conflict");
          const identity = await verify(matches[0]);
          await herdr(runner, ["pane", "report-agent-session", record.pane!, "--source", "iyen:codex", "--agent", "codex", "--agent-session-id", identity.threadId]); return identity;
        }
      }
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    throw new Error("Codex exact startup identity/receipt unknown; retry reconciles only, never sends another handshake");
  } finally { observer.close(); }
}
