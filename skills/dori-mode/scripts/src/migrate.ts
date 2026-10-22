import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath, defaultConfig, expandHome, legacyKeys, parseConfig } from "./config.ts";
import { atomicJson } from "./journal.ts";
import { LANE_KEY, statusOf, type Lane } from "./registry.ts";
export type Handoff = { stoppedConfirmed: boolean; lanes: Record<string, string> };
export const migrate = async (apply: boolean, path = configPath(), handoff?: Handoff): Promise<unknown> => {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const stateDir = resolve(expandHome(process.env.DORI_STATE_DIR ?? raw.stateDir ?? defaultConfig().stateDir));
  if (existsSync(join(stateDir, "service.lock"))) throw new Error("Stop dori serve before migration");
  const dir = join(stateDir, "lanes");
  const lanes: any[] = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
  if (lanes.some(l => !LANE_KEY.test(l.key))) throw new Error("Invalid legacy lane key");
  const legacy = lanes.filter(l => l.schemaVersion !== 2);
  const report = { config: path, stateDir, removedKeys: legacyKeys.filter(k => k in raw), lanes: legacy.map(l => ({ key: l.key, status: statusOf(l), needsHandoff: statusOf(l) !== "closed" })) };
  if (!apply) return { dryRun: true, ...report };
  if (legacy.some(l => statusOf(l) !== "closed" && (!handoff?.stoppedConfirmed || !handoff.lanes[l.key] || !existsSync(handoff.lanes[l.key]!)))) throw new Error("Active legacy lanes need --handoff-file with stoppedConfirmed=true and a readable brief per lane");
  if (!legacy.length && !report.removedKeys.length && raw.schemaVersion === 2) return { applied: false, reason: "Already migrated" };
  const marker = join(stateDir, "migration.json");
  let backup: string;
  if (existsSync(marker)) backup = JSON.parse(readFileSync(marker, "utf8")).backup;
  else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"); backup = `${stateDir}.backup-${stamp}`;
    if (existsSync(stateDir)) cpSync(stateDir, backup, { recursive: true, errorOnExist: true });
    if (existsSync(path)) cpSync(path, `${path}.backup-${stamp}`, { errorOnExist: true });
    atomicJson(marker, { status: "started", backup });
  }
  const converted = { ...raw, schemaVersion: 2, runtime: raw.runtime ?? defaultConfig().runtime };
  for (const key of legacyKeys) delete converted[key];
  const config = parseConfig(converted);
  for (const old of legacy) {
    const { session, sessionVia, pane, tab, ...rest } = old;
    const closed = statusOf(old) === "closed";
    const lane: Lane = { ...rest, schemaVersion: 2, revision: 1, legacy: session ? { sessionId: session } : undefined,
      brief: handoff?.lanes[old.key] ?? old.brief, dispatchBlocked: true, holdReason: closed ? undefined : "recovery",
      runtime: closed ? undefined : { kind: "codex", state: "stopped", generation: 0, hostInstanceId: "", binaryVersion: config.runtime.requiredVersion } };
    atomicJson(join(dir, `${old.key}.json`), lane);
  }
  atomicJson(path, config); atomicJson(marker, { status: "complete", backup });
  return { applied: true, backup, ...report };
};
