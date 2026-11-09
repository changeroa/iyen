import { join } from "node:path";
import { Records, requiredText } from "./records.ts";
import type { Lane } from "./registry.ts";
import type { Clock } from "./run.ts";
export const checkpointStages = ["accepted", "investigating", "implementing", "validating", "blocked", "halted", "ready-for-review", "reconciled"] as const;
export type TaskCheckpoint = { key: string; cycle: number; stage: typeof checkpointStages[number]; evidence: string; nextAction: string; threadId?: string; hostInstanceId?: string; generation?: number };
/** Checkpoints describe confirmed state for reconciliation, never replay instructions. */
export class Checkpoints {
  readonly records: Records<TaskCheckpoint>;
  constructor(stateDir: string, clock: Clock) { this.records = new Records(join(stateDir, "checkpoints"), clock); }
  list(key: string) { return this.records.list().filter(row => row.payload.key === key); }
  record(lane: Lane, args: { eventId: string; stage: TaskCheckpoint["stage"]; evidence: string; nextAction: string }) {
    requiredText(args.eventId, "eventId");
    if (!checkpointStages.includes(args.stage)) throw new Error("Invalid checkpoint stage");
    requiredText(args.evidence, "evidence"); requiredText(args.nextAction, "nextAction");
    return this.records.append(`${lane.key}:${args.eventId}`, { key: lane.key, cycle: lane.cycle ?? 1, stage: args.stage, evidence: args.evidence, nextAction: args.nextAction,
      threadId: lane.runtime?.threadId, hostInstanceId: lane.runtime?.hostInstanceId, generation: lane.runtime?.generation });
  }
}
