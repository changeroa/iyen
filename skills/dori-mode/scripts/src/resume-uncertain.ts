import type { FlowDeps } from "./done-flow.ts";
import type { Mailbox } from "./mailbox.ts";
import { statusOf, withStatus, type Lane } from "./registry.ts";
import type { RuntimeSnapshot } from "./runtime/types.ts";
import { payloadHash, type OmpTarget } from "./runtime/omp/contract.ts";
import { sameOmpTarget } from "./runtime/omp-integration.ts";

type Intent = {
  key: string; operationId: string; evidence: string; instance: string; generation: number;
  target: OmpTarget; historyHash: string;
  uncertain: { id: string; payloadHash: string }[];
};
export type UncertainResumeArgs = { key: string; operationId: string; evidence: string; expectedInstance: string; expectedGeneration: number };
const historyHash = (lane: Lane) => payloadHash(JSON.stringify(lane.history ?? []));
const marker = (intent: Intent) => `Owner-authorized uncertain resume ${intent.operationId}`;
function assertScope(lane: Lane, intent: Intent): void {
  const runtime = lane.runtime;
  if (lane.key !== intent.key || lane.key === "lead" || lane.role === "lead" || lane.cleanupFence || runtime?.kind !== "omp" ||
    runtime.backend !== "herdr-tui" || runtime.state === "stopped" || runtime.hostInstanceId !== intent.instance || runtime.generation !== intent.generation ||
    !runtime.omp || !sameOmpTarget(runtime.omp.target, intent.target) || runtime.threadId !== intent.target.sessionId ||
    lane.pane !== intent.target.paneId || lane.cwd !== intent.target.cwd) throw new Error("Uncertain resume native scope changed");
  const history = lane.history ?? [];
  const ownFinalization = history.at(-1)?.note === marker(intent) && payloadHash(JSON.stringify(history.slice(0, -1))) === intent.historyHash;
  if (historyHash(lane) !== intent.historyHash && !ownFinalization) throw new Error("A newer lifecycle decision fences uncertain resume");
}
/** This operation releases execution only. It never submits or rewrites any inbox message. */
export async function resumeUncertain(deps: FlowDeps, inbox: Mailbox, operations: Mailbox, args: UncertainResumeArgs,
  release: (intent: Intent) => Promise<RuntimeSnapshot>): Promise<unknown> {
  if (!args.operationId?.trim() || args.operationId.length > 200 || !args.evidence?.trim() || !args.expectedInstance ||
    !Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 1) throw new Error("Explicit evidence, stable operationId and expected native attachment required");
  const id = `resume-uncertain:${args.operationId}`;
  let row = operations.get(id), lane = await deps.registry.read(args.key);
  if (!lane) throw new Error("Managed lane missing");
  let intent: Intent;
  if (row) {
    intent = JSON.parse(row.text) as Intent;
    if (intent.key !== args.key || intent.operationId !== args.operationId || intent.evidence !== args.evidence || intent.instance !== args.expectedInstance || intent.generation !== args.expectedGeneration)
      throw new Error("Uncertain resume operation payload changed");
    if (row.state === "sent") return { resumed: true, recorded: true, operationId: args.operationId, uncertainInputIds: intent.uncertain.map(x => x.id) };
  } else {
    const runtime = lane.runtime, target = runtime?.omp?.target;
    if (!target || target.role !== "managed-lane" || target.laneKey !== args.key || runtime?.hostInstanceId !== args.expectedInstance || runtime.generation !== args.expectedGeneration ||
      (!lane.dispatchBlocked || (statusOf(lane) !== "paused" && lane.holdReason !== "recovery"))) throw new Error("Explicit uncertain resume requires the held original managed attachment");
    const pending = inbox.list().filter(x => x.target === args.key && ["unknown", "sending"].includes(x.state));
    if (!pending.length || pending.some(x => x.state !== "unknown" || x.abandonment || x.attachmentInstance !== runtime.hostInstanceId ||
      x.ompProvenance?.attachmentInstanceId !== runtime.hostInstanceId || x.ompProvenance.attachmentGeneration !== runtime.generation ||
      !sameOmpTarget(x.ompProvenance.target, target))) throw new Error("Uncertain resume requires original settled unknown provenance, not sending or abandonment");
    intent = { key: args.key, operationId: args.operationId, evidence: args.evidence, instance: runtime.hostInstanceId, generation: runtime.generation,
      target, historyHash: historyHash(lane), uncertain: pending.map(x => ({ id: x.id, payloadHash: payloadHash(x.text) })) };
    assertScope(lane, intent);
    row = operations.put({ id, target: args.key, text: JSON.stringify(intent), state: "queued", at: new Date(deps.clock.now()).toISOString() });
  }
  assertScope(lane, intent);
  const assertInbox = () => {
    for (const captured of intent.uncertain) {
      const current = inbox.get(captured.id);
      if (!current || !["unknown", "sent"].includes(current.state) || current.abandonment || payloadHash(current.text) !== captured.payloadHash ||
        current.attachmentInstance !== intent.instance || current.ompProvenance?.attachmentInstanceId !== intent.instance ||
        current.ompProvenance.attachmentGeneration !== intent.generation || !sameOmpTarget(current.ompProvenance.target, intent.target))
        throw new Error("Uncertain resume original input changed");
    }
    if (inbox.list().some(current => current.target === intent.key && ["unknown", "sending"].includes(current.state) && !intent.uncertain.some(captured => captured.id === current.id)))
      throw new Error("A new uncertain input requires a new owner decision");
  };
  assertInbox();
  // An uncertain control retry only observes the exact existing process. Never send release again.
  let snapshot: RuntimeSnapshot;
  if (row.state !== "queued") snapshot = await deps.runtime.inspect(args.key);
  else {
    const before = await deps.runtime.inspect(args.key);
    if (before.held !== true || before.state !== "idle" || before.activeTurnId || before.threadId !== intent.target.sessionId) throw new Error("Original native execution hold is not settled");
    assertScope((await deps.registry.read(args.key))!, intent);
    assertInbox();
    operations.mark(id, { state: "sending" });
    try { snapshot = await release(intent); }
    catch (error) { operations.mark(id, { state: "unknown" }); throw error; }
  }
  if (snapshot.held !== false || snapshot.threadId !== intent.target.sessionId || !["idle", "running"].includes(snapshot.state)) {
    operations.mark(id, { state: "unknown" });
    return { resumed: false, status: "unknown", operationId: args.operationId };
  }
  try {
    lane = (await deps.registry.read(args.key))!;
    assertScope(lane, intent);
    assertInbox();
    if (lane.history?.at(-1)?.note !== marker(intent)) await deps.registry.update(args.key, current => {
      assertScope(current, intent);
      return withStatus(current, statusOf(current) === "paused" ? current.pausedFrom === "not-done" ? "not-done" : "working" : statusOf(current),
        marker(intent), new Date(deps.clock.now()).toISOString(), { dispatchBlocked: false, holdReason: undefined, pausedFrom: undefined });
    });
    operations.mark(id, { state: "sent" });
    return { resumed: true, operationId: args.operationId, uncertainInputIds: intent.uncertain.map(x => x.id), deliveryState: "unchanged" };
  } catch (error) { operations.mark(id, { state: "unknown" }); throw error; }
}
