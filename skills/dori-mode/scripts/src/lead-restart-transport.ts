import type { Runner } from "./run.ts";
import type { RestartObservation, RestartRecord } from "./lead-restart-coordinator.ts";
import { launchRestartNative, restartBootstrap } from "./lead-restart-launcher.ts";
import { connectOmp } from "./runtime/omp/client.ts";
import { payloadHash, validReceipt } from "./runtime/omp/contract.ts";
import { sameOmpTarget, verifyOmpHerdr } from "./runtime/omp-integration.ts";
import { prepareLeadRestart, inspectLeadRestart, commitLeadRestart, releaseLeadRestart, stageLeadRestartContinuation,
  type LeadRestartIntent, type LeadRestartStatus, type LeadRestartBootstrap, type LeadRestartContinuation } from "./runtime/omp/lead-restart.ts";

function intent(record: RestartRecord, fresh = false): LeadRestartIntent {
  return { operationId: record.operationId, authorizationHash: record.authorizationHash, sourceMessageId: record.authorization.sourceMessageId,
    ...(fresh ? { previousTarget: record.authorization.scope.target } : {}) };
}
function validateStatus(record: RestartRecord, status: LeadRestartStatus, fresh = false): RestartObservation {
  const target = fresh ? record.freshTarget : record.authorization.scope.target;
  if (!target || !sameOmpTarget(status.target, target) || status.operationId !== record.operationId || status.authorizationHash !== record.authorizationHash ||
    status.sourceMessageId !== record.authorization.sourceMessageId || status.process.controllerInstanceId !== target.instanceId ||
    status.process.controllerGeneration !== target.generation || !Number.isSafeInteger(status.process.pid) || status.process.pid <= 0 ||
    !fresh && status.process.pid !== record.process?.pid || status.phase === "failed") throw new Error("Native restart operation/epoch unverified");
  return status.phase;
}
export async function restartNativePrepare(record: RestartRecord): Promise<RestartObservation> {
  const status = await prepareLeadRestart(record.config, record.authorization.scope.target, intent(record));
  return validateStatus(record, status);
}
export async function restartNativeInspect(record: RestartRecord, fresh: boolean): Promise<RestartObservation> {
  const target = fresh ? record.freshTarget : record.authorization.scope.target;
  if (!target) throw new Error("Fresh restart target unavailable");
  const status = await inspectLeadRestart(record.config, target, intent(record, fresh));
  const phase = validateStatus(record, status, fresh);
  if (fresh) {
    validateBootstrap(record, status);
    if (phase === "released") {
      if (!status.continuation) throw new Error("Released restart continuation receipt missing");
      validateContinuation(record, status.continuation);
    }
  }
  return phase;
}
export async function restartNativeCommit(record: RestartRecord): Promise<void> {
  const status = await commitLeadRestart(record.config, record.authorization.scope.target, intent(record));
  if (validateStatus(record, status) !== "exit-requested") throw new Error("Native restart exit intent unconfirmed");
}
function validateBootstrap(record: RestartRecord, status: LeadRestartStatus): void {
  const boot = status.bootstrap, old = record.authorization.scope.target;
  if (!boot || boot.operationId !== record.operationId || boot.authorizationHash !== record.authorizationHash || boot.sourceMessageId !== record.authorization.sourceMessageId ||
    !sameOmpTarget(boot.previousTarget, old) || !status.fence || status.fence.sessionId !== old.sessionId || !Number.isSafeInteger(status.fence.generation) ||
    status.fence.generation < 1 || record.freshFence !== undefined && status.fence.generation !== record.freshFence ||
    status.phase === "held" && status.fence.status !== "held" || status.phase === "released" && status.fence.status !== "open") throw new Error("Fresh restart bootstrap/execution generation unverified");
}
export async function restartNativeStart(record: RestartRecord, runner: Runner): Promise<void> {
  const restart: LeadRestartBootstrap = { ...intent(record), previousTarget: record.authorization.scope.target };
  await launchRestartNative(record, { ...restartBootstrap(record), restart }, runner);
}
export async function restartNativeAttest(record: RestartRecord, runner: Runner): Promise<number> {
  const target = record.freshTarget;
  if (!target) throw new Error("Fresh native target missing");
  await verifyOmpHerdr(target, runner);
  const status = await inspectLeadRestart(record.config, target, intent(record, true));
  if (validateStatus(record, status, true) !== "held") throw new Error("Fresh native restart is not held");
  validateBootstrap(record, status);
  const client = await connectOmp(target, { timeoutMs: record.config.runtime.rpcTimeoutMs });
  try {
    const snapshot = await client.inspect(), role = record.config.runtime.roles.lead;
    if (!snapshot.held || snapshot.state !== "idle" || snapshot.activeRunId || snapshot.goal || snapshot.capabilities.leadRestart !== true ||
      snapshot.provider !== record.config.runtime.omp!.provider || snapshot.model !== role.model || snapshot.effort !== role.effort ||
      (await client.interactions()).length) throw new Error("Fresh native bootstrap/profile/idle hold not attested");
  } finally { client.close(); }
  return status.fence!.generation;
}
function validateContinuation(record: RestartRecord, staged: LeadRestartContinuation): void {
  const target = record.freshTarget, continuation = record.continuation;
  if (!target || !continuation || staged.operationId !== record.operationId || staged.authorizationHash !== record.authorizationHash || !sameOmpTarget(staged.target, target) ||
    staged.textHash !== payloadHash(continuation.text) || !validReceipt(staged.receipt, target, continuation.operationId, payloadHash(continuation.text))) throw new Error("Exact source-bound restart continuation receipt missing");
}
export async function restartNativeStage(record: RestartRecord): Promise<void> {
  if (!record.freshTarget || !record.continuation) throw new Error("Restart continuation unavailable");
  const staged = await stageLeadRestartContinuation(record.config, record.freshTarget, intent(record, true), record.continuation.text);
  validateContinuation(record, staged);
}
export async function restartNativeStaged(record: RestartRecord): Promise<LeadRestartContinuation | undefined> {
  if (!record.freshTarget) throw new Error("Fresh target missing");
  const status = await inspectLeadRestart(record.config, record.freshTarget, intent(record, true));
  validateStatus(record, status, true); validateBootstrap(record, status);
  if (status.continuation) { validateContinuation(record, status.continuation); return status.continuation; }
}
export async function restartNativeRelease(record: RestartRecord): Promise<void> {
  if (!record.freshTarget) throw new Error("Fresh target missing");
  const status = await releaseLeadRestart(record.config, record.freshTarget, intent(record, true));
  if (validateStatus(record, status, true) !== "released") throw new Error("Restart release outcome unknown");
  validateBootstrap(record, status);
  if (!status.continuation) throw new Error("Released restart continuation receipt missing");
  validateContinuation(record, status.continuation);
}
