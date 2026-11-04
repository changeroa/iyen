import { isDeepStrictEqual } from "node:util";
import { type FlowDeps } from "./done-flow.ts";
import { type Lane, type Retirement, statusOf, withStatus } from "./registry.ts";
import { payloadHash } from "./runtime/omp/contract.ts";
import { iso } from "./run.ts";

export type RetireArgs = { key: string; operationId: string; evidence: string; expectedInstance: string; expectedGeneration: number };
const scope = (lane: Lane) => ({ key: lane.key, role: lane.role, pane: lane.pane, cwd: lane.cwd,
  kind: lane.runtime?.kind, backend: lane.runtime?.backend, instance: lane.runtime?.hostInstanceId,
  generation: lane.runtime?.generation, threadId: lane.runtime?.threadId, target: lane.runtime?.omp?.target });
const result = (lane: Lane) => ({ retired: statusOf(lane) === "closed", key: lane.key,
  operationId: lane.retirement!.operationId, runtimeStop: lane.retirement!.runtimeStop,
  processExitVerified: lane.retirement!.runtimeStop === "confirmed", filesPreserved: true, panePreserved: true });

/** Explicit lead retirement is not a completion claim and never resumes, replays or deletes work. */
export async function retireManagedLane(deps: Pick<FlowDeps, "registry" | "runtime" | "clock">,
  args: RetireArgs, assertAuthority: () => Promise<void>) {
  if (!args.operationId?.trim() || args.operationId.length > 200 || !args.evidence?.trim() || args.evidence.length > 4000 ||
    !args.expectedInstance?.trim() || !Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 1)
    throw new Error("Retirement requires bounded operation/evidence and exact worker instance/generation");
  await assertAuthority();
  const lane = await deps.registry.read(args.key), runtime = lane?.runtime;
  if (!lane || lane.key === "lead" || lane.role !== "lane" || runtime?.kind !== "omp" || runtime.backend !== "herdr-tui" ||
    runtime.hostInstanceId !== args.expectedInstance || runtime.generation !== args.expectedGeneration || lane.cleanupFence)
    throw new Error("Retirement requires the exact registered managed OMP worker; borrowed leads are excluded");
  const pinned = scope(lane), digest = payloadHash(JSON.stringify(args)), scopeHash = payloadHash(JSON.stringify(pinned));
  const prior = lane.retirement;
  if (prior && (prior.operationId !== args.operationId || prior.payloadHash !== digest || prior.scopeHash !== scopeHash))
    throw new Error("Retirement operation payload or worker scope changed");
  if (statusOf(lane) === "closed") {
    if (!prior) throw new Error("Lane was already closed by a different lifecycle");
    return result(lane);
  }
  const target = runtime.omp?.target;
  if (target && (target.role !== "managed-lane" || target.laneKey !== lane.key || target.sessionId !== runtime.threadId ||
    target.paneId !== lane.pane || target.cwd !== lane.cwd || runtime.omp!.attachmentInstanceId !== runtime.hostInstanceId ||
    runtime.omp!.attachmentGeneration !== runtime.generation)) throw new Error("Managed native retirement identity is inconsistent");
  const addressable = !!target && !!runtime.threadId;
  let retirement: Retirement = prior ?? { operationId: args.operationId, evidence: args.evidence, payloadHash: digest, scopeHash,
    requestedAt: iso(deps.clock), phase: addressable ? "stop-attempted" : "requested", runtimeStop: addressable ? "unknown" : "not-addressable" };
  const assertCurrent = (current: Lane) => {
    if (!isDeepStrictEqual(scope(current), pinned) || current.cleanupFence ||
      current.retirement && (current.retirement.operationId !== args.operationId || current.retirement.payloadHash !== digest))
      throw new Error("Retirement worker scope changed; no further effects permitted");
  };
  if (!prior) {
    await deps.registry.update(lane.key, current => {
      assertCurrent(current);
      if (statusOf(current) === "closed") throw new Error("Lane closed concurrently");
      return { ...current, retirement, dispatchBlocked: true };
    });
    await assertAuthority();
    const current = await deps.registry.read(lane.key);
    if (!current) throw new Error("Retirement worker disappeared");
    assertCurrent(current);
    if (addressable) {
      // Existing managed stop proves exact native process exit and Herdr detach. A lost ACK is not retried.
      try { await deps.runtime.stop(lane.key); retirement = { ...retirement, runtimeStop: "confirmed" }; }
      catch { retirement = { ...retirement, runtimeStop: "unknown" }; }
    }
  }
  // Reconstructing a pending intent only retires the record: never issue another uncertain native stop.
  await assertAuthority();
  const closed = await deps.registry.update(lane.key, current => {
    assertCurrent(current);
    return withStatus(current, "closed", `Retired by lead: ${args.evidence}`, iso(deps.clock), {
      closedAt: iso(deps.clock), dispatchBlocked: true,
      retirement: { ...retirement, phase: "closed", closedAt: iso(deps.clock) },
    });
  });
  return result(closed);
}
