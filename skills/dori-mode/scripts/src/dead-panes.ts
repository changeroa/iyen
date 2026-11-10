import type { DoriConfig } from "./config.ts";
import type { Registry } from "./registry.ts";
export const deadPaneTick = async (config: DoriConfig, registry: Registry, now = Date.now()): Promise<string[]> => {
  const lines: string[] = [];
  for (const lane of await registry.open()) {
    if (lane.runtime && lane.runtime.backend !== "external-current-session" && now - Date.parse(lane.runtime.lastHeartbeatAt ?? lane.openedAt) > config.runtime.heartbeatTimeoutMs) lines.push(`RUNTIME_UNREACHABLE ${lane.key}`);
  }
  return lines;
};
