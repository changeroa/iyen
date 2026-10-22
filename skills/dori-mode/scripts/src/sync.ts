import type { FlowDeps } from "./done-flow.ts";
import { listPanes } from "./panes.ts";
import { statusOf } from "./registry.ts";
export type SyncRow = { key: string; thread: string; pane: string; session: string; status: string };
export type SyncResult = { rows: SyncRow[]; drift: string[]; unregistered: SyncRow[] };
export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const panes = await listPanes(deps.run), live = new Set(panes.map(p => p.pane_id));
  const rows: SyncRow[] = [], drift: string[] = [];
  const lanes = await deps.registry.open();
  for (const lane of lanes) {
    if (lane.pane && !live.has(lane.pane)) drift.push(`${lane.key}: pane missing`);
    const snap = await deps.runtime.inspect(lane.key).catch(() => null);
    if (!snap) drift.push(`${lane.key}: runtime unreachable`);
    else if (snap.threadId !== lane.runtime?.threadId) drift.push(`${lane.key}: runtime identity mismatch; not replaced`);
    else if (write) await deps.registry.update(lane.key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, state: snap.state, activeTurnId: snap.activeTurnId } }));
    rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: lane.runtime?.threadId ?? "-", status: statusOf(lane) });
  }
  const owned = new Set(lanes.map(l => l.pane));
  const unregistered = panes.filter(p => p.agent && !owned.has(p.pane_id) && !deps.config.ignorePanes.includes(p.pane_id)).map(p => ({ key: p.title ?? p.pane_id, thread: "-", pane: p.pane_id, session: "explicit thread-id required", status: "unregistered" }));
  return { rows, drift, unregistered };
};
