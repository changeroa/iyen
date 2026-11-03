import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { statusOf } from "./registry.ts";
export const scrubForThread = (text: string, home: string): string => (home ? text.split(home).join("~") : text).replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").trim();
export type SweepAct = { kind: "nudged" | "posted" | "no-report" | "stale-report" | "post-unknown"; lane: string; detail: string };
export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  for (const lane of await deps.registry.open()) {
    if (lane.role === "lead" || statusOf(lane) !== "working" || lane.dispatchBlocked) continue;
    const now = deps.clock.now(), heard = lane.lastReplyAt ?? Date.parse(lane.openedAt);
    const minutes = (now - heard) / 60000;
    const runtime = await deps.runtime.inspect(lane.key).catch(() => null);
    if (!runtime || !["idle", "running"].includes(runtime.state)) continue;
    if (minutes >= deps.config.nudgeAfterMin && (lane.lastNudgeAt ?? 0) < heard) {
      // Record before sending: unknown dispatch is never automatically duplicated.
      await deps.registry.update(lane.key, l => ({ ...l, lastNudgeAt: now }));
      const latest = await deps.registry.read(lane.key);
      if (latest?.dispatchBlocked) continue;
      await deps.runtime.input(lane.key, "Report a short progress update with dori report, then continue the authorized work.", `nudge:${lane.key}:${heard}`).catch(() => {});
      acts.push({ kind: "nudged", lane: lane.key, detail: "progress requested; inspect runtime for delivery" });
    }
    const hook = deps.config.hooks.threadReply;
    if (minutes < deps.config.postAfterMin || !hook || lane.thread === "none") continue;
    const report = lane.report;
    if (!report) { acts.push({ kind: "no-report", lane: lane.key, detail: "No explicit report" }); continue; }
    if (lane.lastPostedReport === report.id) continue;
    const text = scrubForThread(report.text, home);
    if (deps.post) {
      await deps.post(`report:${lane.key}:${report.id}`, hook, { thread: lane.thread, text, key: lane.key });
    } else {
      const result = await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      if (result.code !== 0) { acts.push({ kind: "post-unknown", lane: lane.key, detail: "Hook failed" }); continue; }
    }
    await deps.registry.update(lane.key, l => ({ ...l, lastPostedReport: report.id, lastAutoReplyAt: now }));
    acts.push({ kind: "posted", lane: lane.key, detail: text });
  }
  return acts;
};
