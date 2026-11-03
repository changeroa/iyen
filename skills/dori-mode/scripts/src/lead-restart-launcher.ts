import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicJson } from "./journal.ts";
import type { Runner } from "./run.ts";
import type { RestartRecord } from "./lead-restart-coordinator.ts";
import { connectOmp } from "./runtime/omp/client.ts";
import { payloadHash, validLaunchMetadata, type OmpLaunchMetadata, type OmpExtensionBootstrap, type OmpTarget } from "./runtime/omp/contract.ts";
import { discoverOmpSafe, sameOmpTarget, verifyOmpHerdr } from "./runtime/omp-integration.ts";
import type { DoriConfig } from "./config.ts";
import { prepareOmpLaunch, type OmpLaunchSpec } from "./runtime/omp/launcher.ts";

/** Pin the private descriptor only after authenticated identity/Herdr verification. Never signal a PID. */
export async function pinRestartProcess(target: OmpTarget, registryDir: string, runner: Runner) {
  await verifyOmpHerdr(target, runner);
  const client = await connectOmp(target);
  try { await client.inspect(); } finally { client.close(); }
  const fd = openSync(join(registryDir, `${payloadHash(`${target.instanceId}:${target.generation}`)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 65536 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error("Unsafe native process descriptor");
    const row = JSON.parse(readFileSync(fd, "utf8"));
    if (!sameOmpTarget(row, target) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isFinite(Date.parse(row.startedAt))) throw new Error("Native process identity unavailable");
    return { pid: row.pid as number, startedAt: row.startedAt as string };
  } finally { closeSync(fd); }
}
async function herdr(runner: Runner, args: string[]) {
  const result = await runner(["herdr", ...args]);
  if (result.code !== 0) throw new Error("Restart Herdr observation unavailable");
  return JSON.parse(result.out).result;
}
export async function restartProcessExited(record: RestartRecord, runner: Runner): Promise<boolean> {
  if (!record.process) throw new Error("Restart process was never pinned");
  try { process.kill(record.process.pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const old = record.authorization.scope.target;
  const { agents } = await herdr(runner, ["agent", "list"]);
  if (!Array.isArray(agents) || agents.some(a => !a || typeof a.agent !== "string" || !a.pane_id || a.agent === "omp" && !a.agent_session?.value)) throw new Error("Restart detachment is ambiguous");
  if (agents.some(a => a.pane_id === old.paneId || a.agent === "omp" && a.agent_session?.value === old.sessionFile)) return false;
  const { pane } = await herdr(runner, ["pane", "get", old.paneId]);
  if (pane?.pane_id !== old.paneId || pane.terminal_id !== old.terminalId || realpathSync(pane.cwd) !== old.cwd || pane.agent) throw new Error("Original restart pane is not detached");
  return true;
}
export async function discoverRestartTarget(record: RestartRecord, runner: Runner): Promise<OmpTarget | undefined> {
  const old = record.authorization.scope.target;
  const candidates = (await discoverOmpSafe(record.config.runtime.omp!.registryDir)).filter(t => t.sessionFile === old.sessionFile || t.paneId === old.paneId);
  if (!candidates.length) return;
  if (candidates.length !== 1) throw new Error("Restart native controller ambiguity");
  const target = candidates[0]!;
  if (target.sessionId !== old.sessionId || target.sessionFile !== old.sessionFile || target.paneId !== old.paneId || target.terminalId !== old.terminalId || target.cwd !== old.cwd ||
    target.instanceId === old.instanceId || target.role !== "attached-lead" || target.laneKey !== "lead" || target.runtimeVersion !== record.config.runtime.requiredVersion) throw new Error("Restart exact native identity mismatch");
  await verifyOmpHerdr(target, runner); return target;
}

/** Exact startup data; profile/persona contents are neither read nor copied. */
export function restartBootstrap(record: RestartRecord): OmpExtensionBootstrap {
  const old = record.authorization.scope.target;
  return { protocol: 1, role: "attached-lead", laneKey: "lead", registryDir: record.config.runtime.omp!.registryDir,
    expectedCwd: old.cwd, expectedPaneId: old.paneId, expectedTerminalId: old.terminalId, expectedSessionId: old.sessionId, expectedSessionFile: old.sessionFile };
}


/** All deterministic launcher refusals occur before source consumption or native shutdown. */
export function validateRestartProfile(config: DoriConfig, target: OmpTarget, bootstrapFile: string, metadata: OmpLaunchMetadata): OmpLaunchSpec {
  const { runtime } = config, omp = runtime.omp;
  if (runtime.kind !== "omp" || !omp || !runtime.settingsHome?.startsWith("/") || !runtime.roles.lead.model || !runtime.roles.lead.effort) throw new Error("Pinned restart profile unavailable");
  if (!validLaunchMetadata(metadata) || metadata.agentDir !== metadata.settingsHome || runtime.settingsHome !== metadata.agentDir ||
    omp.provider !== metadata.provider || omp.approvalMode !== metadata.approvalMode || runtime.roles.lead.model !== metadata.model ||
    runtime.roles.lead.effort !== metadata.effort) throw new Error("Configured restart launcher differs from effective native profile");
  const canonical = Bun.which("omp", { PATH: process.env.PATH ?? "" });
  if (!canonical || realpathSync(canonical) !== realpathSync(runtime.binary)) throw new Error("Configured OMP binary differs from Herdr canonical omp executable");
  return prepareOmpLaunch({ binary: runtime.binary, registryDir: omp.registryDir, bootstrapFile, extensionPath: omp.extensionPath, cwd: target.cwd,
    provider: omp.provider, model: runtime.roles.lead.model, effort: runtime.roles.lead.effort, approvalMode: omp.approvalMode, resumeSessionFile: target.sessionFile });
}

/** Herdr's structured agent launcher owns shell readiness; never send command text. */
export async function launchRestartNative(record: RestartRecord, bootstrap: OmpExtensionBootstrap, runner: Runner): Promise<void> {
  const { runtime } = record.config, old = record.authorization.scope.target;
  const spec = validateRestartProfile(record.config, old, record.launch.bootstrapFile, record.launchMetadata);
  if (!await restartProcessExited(record, runner)) throw new Error("Exact old process exit/Herdr detachment not proven");
  writeRestartBootstrap(record, bootstrap);
  const name = `iyen-restart-${payloadHash(record.operationId).slice(0, 16)}`;
  const result = await runner(["herdr", "agent", "start", name, "--kind", "omp", "--pane", old.paneId, "--timeout", String(runtime.startupTimeoutMs), "--",
    "--agent-dir", record.launchMetadata.agentDir, "--start-held", "--cwd", old.cwd, "--iyen-omp-bootstrap", record.launch.bootstrapFile, ...spec.argv.slice(1)],
    { timeoutMs: runtime.startupTimeoutMs + 5000 });
  if (result.code !== 0) throw new Error("Restart startup outcome unknown; discover exact fresh controller without relaunch");
}
export function writeRestartBootstrap(record: RestartRecord, bootstrap: OmpExtensionBootstrap) {
  const dir = resolve(record.config.stateDir, "clients", "attached-lead", record.launch.instance);
  atomicJson(join(dir, "context.json"), { token: record.launch.token, key: "lead", stateDir: record.config.stateDir });
  atomicJson(join(dir, "config.json"), record.config);
  atomicJson(record.launch.bootstrapFile, bootstrap);
}
