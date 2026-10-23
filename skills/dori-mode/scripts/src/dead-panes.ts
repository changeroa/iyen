import type { DoriConfig } from "./config.ts";
import type { Registry } from "./registry.ts";
import type { Runner } from "./run.ts";
import { listPanes } from "./panes.ts";
export const deadPaneTick = async (run: Runner, config: DoriConfig, registry: Registry, now = Date.now()): Promise<string[]> => {
  const panes = new Set((await listPanes(run)).map(p => p.pane_id));
  const lines: string[] = [];
  for (const lane of await registry.open()) {
    if (lane.pane && !panes.has(lane.pane)) lines.push(`DEAD_PANE ${lane.key} ${lane.pane}`);
    if (lane.runtime && lane.runtime.backend !== "external-current-session" && now - Date.parse(lane.runtime.lastHeartbeatAt ?? lane.openedAt) > config.runtime.heartbeatTimeoutMs) lines.push(`RUNTIME_UNREACHABLE ${lane.key}`);
  }
  return lines;
};
