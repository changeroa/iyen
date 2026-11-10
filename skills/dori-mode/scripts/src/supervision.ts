import type { FlowDeps } from "./done-flow.ts";
import type { Mail } from "./mailbox.ts";
import { isRemovedOmpLane, statusOf } from "./registry.ts";
/** Bounded minute-level observation only. No stale/budget-based input or runtime controls. */
export const supervisionTick = async (deps: FlowDeps, put: (mail: Mail) => Mail): Promise<void> => {
  let failed = false;
  for (const lane of await deps.registry.open()) {
    if (lane.role === "lead" || isRemovedOmpLane(lane) || statusOf(lane) !== "working" || lane.dispatchBlocked) continue;
    try {
      const heard = Math.max(Date.parse(lane.openedAt), lane.report?.at ?? 0);
    const observedAt = deps.clock.now(), stale = observedAt - heard >= deps.config.nudgeAfterMin * 60000;
      const warnings: string[] = [];
    if (stale) warnings.push("No recent structured worker report; inspect checkpoints and actual work before deciding a follow-up.");
      const snapshot = await deps.runtime.inspect(lane.key).catch(() => null);
      if (!snapshot) warnings.push("Runtime observation unavailable; do not infer completion or restart automatically.");
      else if (["failed", "waiting_approval", "waiting_input"].includes(snapshot.state)) warnings.push(`Runtime state: ${snapshot.state}; inspect the exact pending request or failure.`);
      // RuntimeSnapshot exposes the configured goal budget, not usage. Never invent consumption.
      if (snapshot?.goal?.tokenBudget != null) warnings.push(`Configured goal token budget: ${snapshot.goal.tokenBudget}; consumed/remaining usage is unavailable here. Lead decides whether any action is needed.`);
      if (!warnings.length) continue;
    put({ id: `supervision:${lane.key}:${lane.runtime?.hostInstanceId ?? "none"}:${heard}:${snapshot?.state ?? "unavailable"}:${snapshot?.goal?.tokenBudget ?? "none"}:${stale ? "stale" : "fresh"}`,
      target: "lead", text: `[OBSERVATION] ${lane.key}\n${warnings.join("\n")}`, metadata: { type: "supervision", key: lane.key, heard, state: snapshot?.state ?? "unavailable" }, state: "queued", at: new Date(observedAt).toISOString() });
    } catch { failed = true; } // One failed lane must not starve observations for the rest.
  }
  if (failed) throw new Error("Supervision observation failed; remaining lanes were still checked");
};
