import { existsSync } from "node:fs";
import { type DoriConfig, type ArgvTemplate, fill } from "./config.ts";
import { type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import type { RuntimeControl } from "./runtime/types.ts";
import { checkDone, type SignalIo } from "./signals.ts";
export type FlowDeps = {
  run: Runner; clock: Clock; registry: Registry; config: DoriConfig; runtime: RuntimeControl;
  exists?: (path: string) => boolean; signalIo?: SignalIo;
  post?: (id: string, hook: ArgvTemplate, values: Record<string, string>) => Promise<void>;
};
const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });
const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60000;
export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  await deps.registry.update(lane.key, current => {
    if (statusOf(current) === "done-claimed" && current.claim?.evidence === evidence) return current;
    if (!["working", "not-done"].includes(statusOf(current)) || current.dispatchBlocked || current.cleanupFence) throw new Error("Lane cannot claim completion in this state");
    return withStatus(current, "done-claimed", evidence, iso(deps.clock), { claim: { at: iso(deps.clock), evidence, emitted: false }, dispatchBlocked: true, holdReason: "done-review" });
  });
  // Do not interrupt the turn executing this tool before its ACK. Watcher quiesces it later.
  return `LANE_DONE_CLAIMED ${lane.key} ${evidence}`;
};
export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const updated = await deps.registry.update(lane.key, current => {
    if (current.cleanupFence || statusOf(current) === "closed" || current.holdReason === "owner-pause") throw new Error("Lane cannot accept an objection now");
    return withStatus(current, "not-done", reasons.join("; "), iso(deps.clock), { objection: { at: iso(deps.clock), reasons }, dispatchBlocked: true, holdReason: "recovery" });
  });
  try {
    await deps.runtime.release(lane.key, "automatic");
    await deps.registry.update(lane.key, current => {
      if (current.objection?.at !== updated.objection?.at || current.holdReason !== "recovery") throw new Error("Lane changed during objection");
      return { ...current, dispatchBlocked: false, holdReason: undefined };
    });
    await deps.runtime.input(lane.key, `Not done: ${reasons.join("; ")}. Address the reasons and claim again.`, `objection:${lane.key}:${updated.objection?.at}`);
  } catch { /* durable not-done remains; recovery never silently restarts unknown work */ }
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};
/** Only explicitly owned paths may be deleted; names and branch prefixes are not ownership. */
export const discoverWorktrees = async (lane: Lane, _run?: Runner, _roots?: readonly string[]): Promise<string[]> => [...new Set(lane.worktrees ?? [])];
export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane)) {
    if (!(deps.exists ?? existsSync)(wt)) continue;
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=all"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0 || !/^\d+$/.test(ahead.out.trim())) reasons.push(`git state unreadable in ${wt}`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`uncommitted, untracked or unpushed work in ${wt}`);
  }
  return reasons;
};
export const closeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ closed: boolean; lines: string[] }> => {
  if (statusOf(lane) === "closed") return { closed: true, lines: [`CLOSED ${lane.key} already`] };
  if (lane.role === "lead" || statusOf(lane) === "paused" || lane.holdReason === "owner-pause" || lane.holdReason === "recovery") return { closed: false, lines: [`REFUSED ${lane.key}: lane held`] };
  // Cleanup retries are safe only after the runtime was confirmed stopped and the close fence persisted.
  let fenced = lane.cleanupFence ? lane : undefined;
  const lines: string[] = [];
  if (!fenced) {
    const claimAt = lane.claim?.at;
    await deps.registry.update(lane.key, l => {
      if (l.claim?.at !== claimAt || statusOf(l) !== statusOf(lane) || l.holdReason === "owner-pause") throw new Error("Close state changed");
      return { ...l, dispatchBlocked: true, holdReason: "done-review" };
    });
    try { await deps.runtime.hold(lane.key, "automatic"); }
    catch { return { closed: false, lines: [`REFUSED ${lane.key}: runtime stop unconfirmed`] }; }
    const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
    const blocked = await unpushedWork(deps, lane);
    lines.push(...checks.map(c => `SIGNAL ${c.ok ? "OK" : "NOT"} ${c.signal} -> ${c.detail}`));
    if (!checks.length || checks.some(c => !c.ok) || blocked.length) {
      const reasons = [...blocked, ...checks.filter(c => !c.ok).map(c => `${c.signal}: ${c.detail}`)];
      if (!reasons.length) reasons.push("No checkable completion evidence");
      const current = await deps.registry.read(lane.key);
      if (current && current.claim?.at === claimAt && current.holdReason === "done-review") lines.push(await objectDone(deps, current, reasons));
      return { closed: false, lines };
    }
    // This mutation is the cleanup fence. A pause/objection accepted during verification wins.
    fenced = await deps.registry.update(lane.key, current => {
      if (current.claim?.at !== claimAt || statusOf(current) !== statusOf(lane) || current.holdReason !== "done-review" || current.objection?.at !== lane.objection?.at) throw new Error("Close invalidated by concurrent change");
      return withStatus(current, "verified-done", note, iso(deps.clock), { cleanupFence: crypto.randomUUID(), receipt: { checks, note, cleanup: [] } });
    });
  }
  const cleanup: string[] = [];
  try { await deps.runtime.stop(lane.key); cleanup.push("runtime stopped"); }
  catch { return { closed: false, lines: [...lines, `REFUSED ${lane.key}: runtime stop unconfirmed`] }; }
  for (const wt of (await discoverWorktrees(fenced)).filter(deps.exists ?? existsSync)) {
    // Recheck immediately before each destructive step, including cleanup retries.
    const blocked = await unpushedWork(deps, { ...fenced, worktrees: [wt] });
    if (blocked.length) return { closed: false, lines: [...lines, ...blocked] };
    const head = await deps.run(["git", "-C", wt, "rev-parse", "HEAD"]);
    const branch = await deps.run(["git", "-C", wt, "branch", "--show-current"]);
    if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head.out)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: cannot save worktree resume point`] };
    await deps.registry.update(lane.key, l => ({ ...l, resumeRefs: { ...l.resumeRefs, [wt]: { sha: head.out, branch: branch.code === 0 ? branch.out || undefined : undefined } } }));
    const result = await deps.run(["git", "-C", fenced.repository ?? deps.config.defaultCwd, "worktree", "remove", wt]);
    if (result.code !== 0) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: worktree cleanup failed`] };
    cleanup.push(`worktree ${wt} removed`);
  }
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    try {
      if (deps.post) await deps.post(`done:${lane.key}:${lane.cycle ?? 1}`, hook, { thread: lane.thread, text: note, key: lane.key });
      else if ((await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }))).code !== 0) throw new Error();
      cleanup.push("thread marked done");
    } catch { cleanup.push("thread delivery unknown; inspect outbox"); }
  }
  if (lane.tab || lane.pane) {
    const result = await deps.run(lane.tab ? ["herdr", "tab", "close", lane.tab] : ["herdr", "pane", "close", lane.pane!]);
    if (result.code !== 0) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: pane cleanup unconfirmed`] };
  }
  await deps.registry.update(lane.key, current => withStatus(current, "closed", note, iso(deps.clock), { closedAt: iso(deps.clock), receipt: { previous: current.receipt, cleanup } }));
  return { closed: true, lines: [...lines, `CLOSED ${lane.key}`] };
};
export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const lines: string[] = [];
  for (let lane of await deps.registry.open()) {
    if (lane.role === "lead") continue;
    if (statusOf(lane) === "verified-done" && lane.cleanupFence) { lines.push(...(await closeLane(deps, lane, "Cleanup recovery")).lines); continue; }
    if (statusOf(lane) !== "done-claimed" || !lane.claim) continue;
    if (lane.holdReason === "recovery") continue;
    if (!lane.claim.emitted) {
      lines.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.claim.evidence}`);
      lane = await deps.registry.update(lane.key, l => ({ ...l, claim: l.claim && { ...l.claim, emitted: true } }));
    }
    try { await deps.runtime.hold(lane.key, "automatic"); } catch { lines.push(`LANE_HOLD_UNCONFIRMED ${lane.key}`); continue; }
    if (deps.clock.now() - Date.parse(lane.claim!.at) < windowMs(deps)) continue;
    try { lines.push(...(await closeLane(deps, lane, `Done: ${lane.claim!.evidence}`)).lines); }
    catch { lines.push(`LANE_CLOSE_DEFERRED ${lane.key} state changed`); }
  }
  return lines;
};
