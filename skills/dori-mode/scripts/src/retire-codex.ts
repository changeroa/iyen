import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { FlowDeps } from "./done-flow.ts";
import type { RetireArgs } from "./retire.ts";
import { type Lane, type Retirement, statusOf, withStatus } from "./registry.ts";
import { readJson } from "./ipc.ts";
import { bootstrapPath, type Bootstrap } from "./runtime/session-host.ts";
import { payloadHash } from "./runtime/omp/contract.ts";
import { iso } from "./run.ts";

const scope = (l: Lane) => ({ key: l.key, role: l.role, pane: l.pane, tab: l.tab, cwd: l.cwd,
  kind: l.runtime?.kind, backend: l.runtime?.backend, instance: l.runtime?.hostInstanceId,
  generation: l.runtime?.generation, thread: l.runtime?.threadId });

/** No signals are sent to processes: a live or reused PID is a blocker. */
export function assertFailedCodexProcessesExited(stateDir: string, lane: Lane): void {
  const boot = readJson<Bootstrap>(bootstrapPath(stateDir, lane.key));
  if (boot.key !== lane.key || boot.role !== "lane" || boot.instance !== lane.runtime?.hostInstanceId ||
    boot.generation !== lane.runtime.generation || boot.pane !== lane.pane || boot.cwd !== lane.cwd || boot.threadId)
    throw new Error("Failed startup bootstrap scope changed");
  const checkpoint = join(stateDir, "hosts", `${lane.key}.runtime.json`);
  if (existsSync(checkpoint)) {
    const saved = readJson<{ instance: string; threadId?: string }>(checkpoint);
    if (saved.instance !== boot.instance || saved.threadId) throw new Error("Saved native thread requires separate reconciliation");
  }
  for (const suffix of ["pid", "backend"]) {
    const path = join(stateDir, "hosts", `${lane.key}.${suffix}.json`);
    const saved = readJson<{ pid: number; instance: string }>(path);
    if (saved.instance !== boot.instance || !Number.isSafeInteger(saved.pid) || saved.pid <= 0)
      throw new Error("Failed startup process identity unavailable");
    try { process.kill(saved.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    throw new Error("Failed startup process still exists; retirement refused");
  }
}

/** Explicit cleanup of failed pre-thread managed Codex only. Never resumes, replays or claims Done. */
export async function retireFailedCodex(deps: FlowDeps, args: RetireArgs, assertAuthority: () => Promise<void>) {
  if (!args.operationId?.trim() || args.operationId.length > 200 || !args.evidence?.trim() || args.evidence.length > 4000 ||
    !args.expectedInstance?.trim() || !Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 1 ||
    !args.expectedTerminalId?.trim() || args.expectedTerminalId.length > 200) throw new Error("Exact failed-startup retirement arguments required");
  await assertAuthority();
  const lane = await deps.registry.read(args.key);
  if (!lane || lane.key === "lead" || lane.role !== "lane" || lane.runtime?.kind !== "codex" ||
    lane.runtime.backend !== "herdr-tui" || lane.runtime.threadId || lane.runtime.hostInstanceId !== args.expectedInstance ||
    lane.runtime.generation !== args.expectedGeneration || !lane.pane || !lane.tab || !lane.cwd || lane.cleanupFence ||
    lane.holdReason !== "recovery" || !lane.dispatchBlocked || statusOf(lane) === "paused" || lane.claim)
    throw new Error("Retirement requires exact recovery-held pre-thread managed Codex lane");
  const pinned = scope(lane), digest = payloadHash(JSON.stringify(args)), scopeHash = payloadHash(JSON.stringify(pinned));
  let intent: Retirement = lane.retirement ?? { operationId: args.operationId, evidence: args.evidence,
    payloadHash: digest, scopeHash, requestedAt: iso(deps.clock), phase: "requested", runtimeStop: "not-addressable",
    paneClose: { terminalId: args.expectedTerminalId, attempted: false, confirmed: false } };
  if (intent.operationId !== args.operationId || intent.payloadHash !== digest || intent.scopeHash !== scopeHash ||
    intent.paneClose?.terminalId !== args.expectedTerminalId) throw new Error("Retirement operation payload or scope changed");
  const assertCurrent = (l: Lane) => {
    if (!isDeepStrictEqual(scope(l), pinned) || l.cleanupFence || l.holdReason !== "recovery" || !l.dispatchBlocked ||
      statusOf(l) === "paused" || l.claim || l.retirement && (l.retirement.operationId !== args.operationId || l.retirement.payloadHash !== digest))
      throw new Error("Retirement worker scope or hold changed");
  };
  const check = async () => {
    await assertAuthority();
    const current = await deps.registry.read(lane.key);
    if (!current) throw new Error("Retirement worker disappeared");
    assertCurrent(current);
    assertFailedCodexProcessesExited(deps.config.stateDir, current);
  };
  // Successful listings, never a failed get, establish absence.
  const observe = async (): Promise<boolean> => {
    const panesResult = await deps.run(["herdr", "pane", "list"]);
    const agentsResult = await deps.run(["herdr", "agent", "list"]);
    if (panesResult.code !== 0 || agentsResult.code !== 0) throw new Error("Cannot verify failed startup pane absence");
    const panes = JSON.parse(panesResult.out).result?.panes, agents = JSON.parse(agentsResult.out).result?.agents;
    if (!Array.isArray(panes) || !Array.isArray(agents)) throw new Error("Invalid Herdr inventory");
    const matches = panes.filter(p => p.pane_id === lane.pane), occupants = agents.filter(a => a.pane_id === lane.pane);
    if (!matches.length && !occupants.length) return false;
    if (matches.length !== 1 || occupants.length > 1 || args.expectedTerminalId === "absent") throw new Error("Unexpected pane occupant");
    const p = matches[0], a = occupants[0];
    if (p.terminal_id !== args.expectedTerminalId || p.tab_id !== lane.tab || realpathSync(p.cwd) !== realpathSync(lane.cwd!) ||
      p.agent_session || p.agent && p.agent !== "codex") throw new Error("Failed startup pane identity changed");
    if (p.agent || a) {
      const name = `dori-${lane.key.replace(/[^a-z0-9_-]/g, "-").slice(0, 17)}-${args.expectedInstance.slice(0, 6)}`;
      if (!a || a.agent !== "codex" || a.name !== name || a.terminal_id !== args.expectedTerminalId || a.tab_id !== lane.tab ||
        a.agent_session || realpathSync(a.cwd) !== realpathSync(lane.cwd!)) throw new Error("Failed startup agent identity changed");
    }
    return true;
  };
  await check();
  let present = await observe();
  if (statusOf(lane) === "closed" && present) throw new Error("Retired pane unexpectedly present; no repeated close");
  if (!lane.retirement) await deps.registry.update(lane.key, current => { assertCurrent(current); return { ...current, retirement: intent }; });
  if (present) {
    if (intent.paneClose!.attempted) throw new Error("Pane close outcome unknown; read-only reconciliation required");
    await check();
    present = await observe();
    if (present) {
      intent = { ...intent, phase: "stop-attempted", paneClose: { ...intent.paneClose!, attempted: true } };
      await deps.registry.update(lane.key, current => { assertCurrent(current); return { ...current, retirement: intent }; });
      await check();
      if (await observe()) {
        await check();
        // One attempt only. Even a successful command requires observed absence.
        await deps.run(["herdr", "pane", "close", lane.pane]).catch(() => {});
      }
    }
  }
  await check();
  if (await observe()) throw new Error("Pane close unconfirmed; no automatic retry");
  const closed = await deps.registry.update(lane.key, current => {
    assertCurrent(current);
    return withStatus(current, "closed", `Failed startup retired: ${args.evidence}`, iso(deps.clock), {
      closedAt: current.closedAt ?? iso(deps.clock), dispatchBlocked: true,
      retirement: { ...intent, phase: "closed", closedAt: intent.closedAt ?? iso(deps.clock), paneClose: { ...intent.paneClose!, confirmed: true } },
    });
  });
  return { retired: true, key: lane.key, operationId: closed.retirement!.operationId, paneClosed: true,
    hostBackendExitVerified: true, processExitVerified: false, runtimeStop: "not-addressable", filesPreserved: true };
}
