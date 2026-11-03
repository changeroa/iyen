import type { DoriConfig } from "../../config.ts";
import { connectOmp } from "./client.ts";
import { OmpError, validRestartIntent, sameLaunchMetadata, type LeadRestartIntent, type LeadRestartBootstrap, type LeadRestartStatus, type LeadRestartContinuation, type OmpTarget } from "./contract.ts";
export type { OmpLaunchMetadata, LeadRestartIntent, LeadRestartBootstrap, LeadRestartStatus, LeadRestartContinuation } from "./contract.ts";

const invoke = async (config: DoriConfig, target: OmpTarget, intent: LeadRestartIntent,
  method: "restart-prepare" | "restart-inspect" | "restart-commit" | "restart-release"): Promise<LeadRestartStatus> => {
  if (!validRestartIntent(intent)) throw new OmpError("invalid-params", "Restart requires pinned native launch metadata", false);
  if (config.runtime.kind !== "omp" || target.role !== "attached-lead" || target.laneKey !== "lead")
    throw new OmpError("restart-target-forbidden", "Restart requires the exact attached OMP lead", false);
  const client = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
  try {
    if (method === "restart-prepare") {
      const snapshot = await client.inspect();
      if (snapshot.capabilities.leadRestart !== true || !snapshot.launchMetadata)
        throw new OmpError("restart-native-unavailable", "Loaded native launch/restart capability unavailable; explicit first bootstrap required", false);
      if (!sameLaunchMetadata(snapshot.launchMetadata, intent.launchMetadata))
        throw new OmpError("restart-launch-mismatch", "Pinned launch profile does not match the borrowed native lead", false);
    }
    return await client.leadRestart(method, intent);
  }
  finally { client.close(); }
};
/** Arm once. Busy native turns finish normally; the controller polls its native atomic idle latch. */
export const prepareLeadRestart = (config: DoriConfig, target: OmpTarget, intent: LeadRestartIntent) => invoke(config, target, intent, "restart-prepare");
/** Read only: never re-arms, commits, releases, or infers process exit. */
export const inspectLeadRestart = (config: DoriConfig, target: OmpTarget, intent: LeadRestartIntent) => invoke(config, target, intent, "restart-inspect");
/** Shutdown intent ACK is not process exit. Parent must independently prove exact PID exit + Herdr detach. */
export const commitLeadRestart = (config: DoriConfig, target: OmpTarget, intent: LeadRestartIntent) => invoke(config, target, intent, "restart-commit");
/** Fresh bootstrap-bound controller only. No historical/native parked input is replayed. */
export const releaseLeadRestart = (config: DoriConfig, target: OmpTarget, intent: LeadRestartBootstrap) => invoke(config, target, intent, "restart-release");
/** Real session-entry receipt while held; ordinary input cannot implement this. */
export const stageLeadRestartContinuation = async (config: DoriConfig, target: OmpTarget, intent: LeadRestartBootstrap, text: string): Promise<LeadRestartContinuation> => {
  if (config.runtime.kind !== "omp" || target.role !== "attached-lead" || target.laneKey !== "lead")
    throw new OmpError("restart-target-forbidden", "Restart continuation requires the exact attached lead", false);
  const client = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
  try { return await client.leadRestartStage(intent, text); }
  finally { client.close(); }
};
