import { homedir } from "node:os";
import { join } from "node:path";

export type ArgvTemplate = readonly string[];
export type Hooks = { readonly threadReply?: ArgvTemplate; readonly threadDone?: ArgvTemplate; readonly transcribe?: ArgvTemplate };
export type GuardThresholds = { readonly loadAlert: number; readonly loadOk: number; readonly memFreeMinPct: number; readonly diskFreeMinGb: number; readonly panesMax: number };
export type RoleConfig = { model: string | null; effort: string | null };
export type RuntimeConfig = {
  kind: "codex"; binary: string; requiredVersion: string; startupTimeoutMs: number; rpcTimeoutMs: number;
  settingsHome?: string;
  heartbeatIntervalMs: number; heartbeatTimeoutMs: number;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "never";
  roles: { lead: RoleConfig; lane: RoleConfig };
};
export type IngressConfig = { id: string; command: string[]; owners: string[] };
export type DoriConfig = {
  schemaVersion: 2; stateDir: string; leadWorkspace?: string; laneWorkspace: string; workspaces: readonly string[];
  ignorePanes: readonly string[]; leadPane: string; defaultCwd: string; runtime: RuntimeConfig;
  nudgeAfterMin: number; postAfterMin: number; closeAfterMin: number; workThresholdSec: number; heavySlots: number; heavyMaxLoad: number;
  guard: GuardThresholds; hooks: Hooks; ingress: IngressConfig[];
};
export const defaultConfig = (home = homedir()): DoriConfig => ({
  schemaVersion: 2, stateDir: join(home, ".dori", "state"), laneWorkspace: "", workspaces: [], ignorePanes: [], leadPane: "", defaultCwd: home,
  runtime: { kind: "codex", binary: "codex", requiredVersion: "0.163.0", startupTimeoutMs: 30000, rpcTimeoutMs: 15000,
    heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 20000, sandbox: "workspace-write", approvalPolicy: "on-request",
    roles: { lead: { model: null, effort: null }, lane: { model: null, effort: null } } },
  nudgeAfterMin: 15, postAfterMin: 20, closeAfterMin: 5, workThresholdSec: 120, heavySlots: 1, heavyMaxLoad: 80,
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 }, hooks: {}, ingress: [],
});
export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");
export const expandHome = (path: string, home = homedir()): string => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
export const legacyKeys = ["agentCommand", "defaultModel", "launchKeywords", "sessionsDir", "deadPanePatterns"] as const;
export const parseConfig = (raw: Record<string, any>, home = homedir()): DoriConfig => {
  if (legacyKeys.some(k => k in raw)) throw new Error("Legacy runtime configuration: run dori migrate --dry-run, then --apply");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) throw new Error("Unsupported config schemaVersion");
  const base = defaultConfig(home);
  const cfg: DoriConfig = { ...base, ...raw, runtime: { ...base.runtime, ...raw.runtime, roles: {
    lead: { ...base.runtime.roles.lead, ...raw.runtime?.roles?.lead }, lane: { ...base.runtime.roles.lane, ...raw.runtime?.roles?.lane },
  } }, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks } };
  if (cfg.runtime.kind !== "codex" || !cfg.runtime.binary || !/^\d+\.\d+\.\d+$/.test(cfg.runtime.requiredVersion)) throw new Error("A pinned Codex runtime is required");
  if (cfg.runtime.settingsHome !== undefined && (typeof cfg.runtime.settingsHome !== "string" || !cfg.runtime.settingsHome)) throw new Error("settingsHome must be a directory path");
  if (cfg.leadWorkspace !== undefined && typeof cfg.leadWorkspace !== "string") throw new Error("leadWorkspace must be a string");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(cfg.runtime.sandbox) || !["untrusted", "on-request", "never"].includes(cfg.runtime.approvalPolicy)) throw new Error("Invalid runtime policy");
  for (const [key, value] of Object.entries(cfg.runtime)) if (key.endsWith("Ms") && (!Number.isFinite(value) || Number(value) <= 0)) throw new Error(`Invalid ${key}`);
  if (cfg.runtime.heartbeatTimeoutMs <= cfg.runtime.heartbeatIntervalMs) throw new Error("heartbeat timeout must exceed interval");
  for (const role of Object.values(cfg.runtime.roles)) {
    if (role.model !== null && (typeof role.model !== "string" || !role.model || role.model.includes("/"))) throw new Error("Use a Codex model ID, not a provider/model route");
    if (role.effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(role.effort)) throw new Error("Invalid reasoning effort");
  }
  for (const n of [cfg.nudgeAfterMin, cfg.postAfterMin, cfg.closeAfterMin, cfg.heavySlots, cfg.heavyMaxLoad]) if (!Number.isFinite(n) || n <= 0) throw new Error("Intervals and limits must be positive");
  if (!Number.isFinite(cfg.workThresholdSec) || cfg.workThresholdSec <= 0) throw new TypeError("workThresholdSec must be a positive number");
  if (!Number.isInteger(cfg.heavySlots)) throw new Error("heavySlots must be an integer");
  if (Object.values(cfg.guard).some(n => !Number.isFinite(n) || n < 0)) throw new Error("Invalid guard threshold");
  if (new Set(cfg.ingress.map(i => i.id)).size !== cfg.ingress.length) throw new Error("Ingress IDs must be unique");
  for (const hook of Object.values(cfg.hooks)) if (!Array.isArray(hook) || !hook.length || hook.some(x => typeof x !== "string")) throw new Error("Hooks must be nonempty argv arrays");
  if (!Array.isArray(cfg.ingress) || cfg.ingress.some(i => !i.id || !Array.isArray(i.command) || !i.command.length || !Array.isArray(i.owners) || !i.owners.length)) throw new Error("Ingress needs id, command argv and owners");
  return { ...cfg, stateDir: expandHome(process.env.DORI_STATE_DIR ?? cfg.stateDir, home), defaultCwd: expandHome(cfg.defaultCwd, home), leadPane: process.env.DORI_LEAD_PANE ?? cfg.leadPane };
};
export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const f = Bun.file(path);
  return parseConfig(await f.exists() ? await f.json() : {}, home);
};
export const workspaceForRole = (config: DoriConfig, role = "lane"): string => role === "lead" ? config.leadWorkspace ?? config.laneWorkspace : config.laneWorkspace;
export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] => template.map(part => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
