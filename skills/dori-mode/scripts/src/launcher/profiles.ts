import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome, loadConfig, type DoriConfig } from "../config.ts";
export type Kind = "omp" | "codex";
export type Profile = { configPath: string; leadInstructionsPath?: string; service?: { start: string[]; stop: string[]; stopped?: string[] } };
export type Registry = { version: 1; profiles: Partial<Record<Kind, Profile>> };
export type Selection = { kind: Kind; registryPath: string; profile: Profile; config: DoriConfig; registered: { kind: Kind; profile: Profile; config: DoriConfig }[] };
export const registryPath = (env = process.env, home = homedir()) => resolve(env.XDG_CONFIG_HOME || join(home, ".config"), "iyen", "launchers.json");
export function assertOperator(env = process.env) {
  if (["DORI_CONTEXT", "DORI_LANE_KEY", "DORI_LANE_TOKEN"].some(key => env[key] !== undefined)) throw new Error("iyen launcher requires an operator shell; scoped lane/lead invocation cannot elevate to administrator");
  if (["DORI_STATE_DIR", "DORI_LEAD_PANE"].some(key => env[key] !== undefined)) throw new Error("Remove DORI_STATE_DIR/DORI_LEAD_PANE overrides before using a launcher profile");
}
const argv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === "string" && x.length > 0 && !x.includes("\0"));
export function parseRegistry(raw: any, path: string): Registry {
  if (raw?.version !== 1 || !raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) throw new Error("Launcher registry requires version:1 and profiles");
  const profiles: Registry["profiles"] = {};
  for (const [kind, value] of Object.entries(raw.profiles) as [string, any][]) {
    if (!["omp", "codex"].includes(kind) || !value || typeof value.configPath !== "string" || !value.configPath.trim()) throw new Error("Invalid launcher profile");
    if (value.leadInstructionsPath !== undefined && (typeof value.leadInstructionsPath !== "string" || !value.leadInstructionsPath.trim())) throw new Error("Invalid leadInstructionsPath");
    if (value.service && (!argv(value.service.start) || !argv(value.service.stop) || value.service.stopped !== undefined && !argv(value.service.stopped))) throw new Error("service.start and service.stop must both be nonempty argv arrays");
    profiles[kind as Kind] = { configPath: resolve(dirname(path), expandHome(value.configPath)), ...(value.leadInstructionsPath ? { leadInstructionsPath: resolve(dirname(path), expandHome(value.leadInstructionsPath)) } : {}), ...(value.service ? { service: value.service } : {}) };
  }
  return { version: 1, profiles };
}
export async function selectProfile(kind: Kind, options: { registry?: string; config?: string } = {}): Promise<Selection> {
  assertOperator();
  const path = resolve(expandHome(options.registry ?? registryPath()));
  const registry = existsSync(path) ? parseRegistry(await Bun.file(path).json(), path) : { version: 1 as const, profiles: {} as Registry["profiles"] };
  if (!options.config && !registry.profiles[kind]) throw new Error(`No ${kind} launcher profile; register it in ${path} or use --config PATH`);
  const explicit = options.config ? realpathSync(expandHome(options.config)) : undefined;
  const configured = registry.profiles[kind];
  const profile: Profile = explicit ? { configPath: explicit, ...(configured && realpathSync(configured.configPath) === explicit && configured.service ? { service: configured.service } : {}), ...(configured && realpathSync(configured.configPath) === explicit && configured.leadInstructionsPath ? { leadInstructionsPath: configured.leadInstructionsPath } : {}) } : configured!;
  const registered: Selection["registered"] = [];
  for (const [name, entry] of Object.entries(registry.profiles) as [Kind, Profile][]) {
    if (!existsSync(entry.configPath)) throw new Error(`Registered ${name} config missing: ${entry.configPath}`);
    const config = await loadConfig(entry.configPath);
    if (config.runtime.kind !== name) throw new Error(`Registered ${name} runtime.kind mismatch`);
    registered.push({ kind: name, profile: entry, config });
  }
  if (!existsSync(profile.configPath)) throw new Error(`Config missing: ${profile.configPath}`);
  const config = await loadConfig(profile.configPath);
  if (config.runtime.kind !== kind) throw new Error(`Requested ${kind}, config runtime.kind is ${config.runtime.kind}`);
  for (const entry of registered) if (realpathSync(entry.profile.configPath) !== realpathSync(profile.configPath) && resolve(entry.config.stateDir) === resolve(config.stateDir)) throw new Error("Launcher profiles must use isolated state directories");
  return { kind, registryPath: path, profile, config, registered };
}
export function overlaps(a: DoriConfig, b: DoriConfig): boolean {
  return a.ingress.some(x => b.ingress.some(y => x.id === y.id && x.owners.some(owner => y.owners.includes(owner))));
}
