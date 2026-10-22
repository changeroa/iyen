import type { FlowDeps } from "./done-flow.ts";
import { type Lane, type LaneStatus, statusOf, withStatus } from "./registry.ts";
export type PauseResult = { lane: Lane; lines: string[]; code: 0 | 2 | 3 };
const pausable = new Set<LaneStatus>(["working", "not-done"]);
export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  const status = statusOf(lane);
  if (status === "paused") return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
  if (!pausable.has(status)) return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}`], code: 2 };
  const blocked = await deps.registry.update(lane.key, current => {
    if (!pausable.has(statusOf(current)) || current.cleanupFence) throw new Error("Lane changed during pause");
    return { ...current, dispatchBlocked: true, holdReason: "owner-pause", pausedFrom: statusOf(current), runtime: current.runtime && { ...current.runtime, state: "pausing" } };
  });
  try {
    // Persist intent before interrupting; a restart must retain what explicit resume owes.
    const snapshot = await deps.runtime.inspect(lane.key);
    if (snapshot.state === "running" && snapshot.activeTurnId && !snapshot.goal) {
      await deps.registry.update(lane.key, current => ({ ...current, pausedContinuation: current.pausedContinuation ?? {
        id: `owner-resume:${lane.key}:${crypto.randomUUID()}`, interruptedTurnId: snapshot.activeTurnId!, at: new Date(deps.clock.now()).toISOString(),
      } }));
    }
    await deps.runtime.hold(lane.key, "user");
    const paused = await deps.registry.update(lane.key, current => withStatus(current, "paused", note, new Date(deps.clock.now()).toISOString()));
    return { lane: paused, lines: [`PAUSED ${lane.key} goal inactive and turn stopped`], code: 0 };
  } catch {
    return { lane: blocked, lines: [`PAUSE_UNVERIFIED ${lane.key}; dispatch remains blocked`], code: 3 };
  }
};
export const resumeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  if (statusOf(lane) !== "paused" && lane.holdReason !== "recovery") return { lane, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(lane)}`], code: 2 };
  try {
    if (statusOf(lane) === "done-claimed") await deps.runtime.hold(lane.key, "automatic");
    else {
      const released = await deps.runtime.release(lane.key, "user");
      if (statusOf(lane) === "paused" && lane.pausedContinuation && !released.goal) {
        if (!deps.queueInput) throw new Error("Durable continuation queue unavailable");
        // Queue before clearing the dispatch barrier. The inbox owns receipts and
        // unknown outcomes; neither a crash nor a repeated resume replays the task.
        await deps.queueInput(lane.key,
          "The owner explicitly resumed the task interrupted by their pause. Inspect the current state and confirmed results, then continue the unfinished work. Do not replay the original request or repeat side effects whose outcome is uncertain; reconcile those first.",
          lane.pausedContinuation.id);
      }
    }
    const resumed = await deps.registry.update(lane.key, current => {
      if (statusOf(current) !== "paused" && current.holdReason !== "recovery") throw new Error("Lane changed during resume");
      return withStatus(current, current.holdReason === "recovery" && statusOf(current) !== "paused" ? statusOf(current) : current.pausedFrom && pausable.has(current.pausedFrom) ? current.pausedFrom : "working", note, new Date(deps.clock.now()).toISOString(), {
        dispatchBlocked: statusOf(current) === "done-claimed", holdReason: statusOf(current) === "done-claimed" ? "done-review" : undefined, pausedFrom: undefined, pausedContinuation: undefined, lastReplyAt: deps.clock.now(),
      });
    });
    return { lane: resumed, lines: [`RESUMED ${lane.key} as ${statusOf(resumed)}`], code: 0 };
  } catch { return { lane, lines: [`RESUME_UNVERIFIED ${lane.key}; dispatch remains blocked`], code: 3 }; }
};
