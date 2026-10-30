import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, installationPaths, loadConfig } from "../src/config.ts";

const roots: string[] = [];
const original = { DORI_CONFIG: process.env.DORI_CONFIG, IYEN_HOME: process.env.IYEN_HOME, DORI_STATE_DIR: process.env.DORI_STATE_DIR };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  for (const key of Object.keys(original)) delete process.env[key];
  const home = mkdtempSync(join(tmpdir(), "iyen-installation-")); roots.push(home); return home;
}
function config(root: string, raw = {}) {
  mkdirSync(root, { recursive: true }); const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(raw)); return path;
}

test("discovery reuses current installation, falls back to legacy, and honors explicit selectors", () => {
  const home = setup();
  expect(configPath(home)).toBe(join(home, ".dori-codex/config.json"));
  const legacy = config(join(home, ".dori"));
  expect(configPath(home)).toBe(legacy);
  const current = config(join(home, ".dori-codex"));
  expect(configPath(home)).toBe(current);
  process.env.IYEN_HOME = "~/custom";
  expect(configPath(home)).toBe(join(home, "custom/config.json"));
  process.env.DORI_CONFIG = "~/explicit.json";
  expect(configPath(home)).toBe(join(home, "explicit.json"));
});

test("one persistent root supplies defaults regardless of the caller project", async () => {
  const home = setup(), root = join(home, "persistent"), path = config(root);
  const resolved = await installationPaths(path, home);
  expect(resolved).toEqual({ config_path: path, config_exists: true, home_dir: root, state_dir: join(root, "state"), persona_dir: join(root, "persona") });
  const other = config(join(home, "other"));
  process.env.IYEN_HOME = root;
  expect((await installationPaths(configPath(home), home)).home_dir).toBe(root);
  process.env.IYEN_HOME = join(home, "other");
  expect((await installationPaths(configPath(home), home)).config_path).toBe(other);
});

test("configured state and persona paths are preserved and relative paths are home-relative", async () => {
  const home = setup(), root = join(home, "persistent");
  const path = config(root, { stateDir: "data/state", personaDir: "~/shared-persona" });
  expect(await installationPaths(path, home)).toMatchObject({ state_dir: join(root, "data/state"), persona_dir: join(home, "shared-persona") });
  config(root, { stateDir: join(home, "old-state"), personaDir: "profiles/iyen" });
  expect(await installationPaths(path, home)).toMatchObject({ state_dir: join(home, "old-state"), persona_dir: join(root, "profiles/iyen") });
  process.env.DORI_STATE_DIR = join(home, "scoped-state");
  expect((await loadConfig(path, home)).stateDir).toBe(join(home, "scoped-state"));
});

test("legacy memory is discovered only within the selected installation", async () => {
  const home = setup(), root = join(home, ".dori"), path = config(root);
  mkdirSync(join(root, "memory"));
  expect((await installationPaths(path, home)).persona_dir).toBe(join(root, "memory"));
  mkdirSync(join(root, "persona"));
  expect((await installationPaths(path, home)).persona_dir).toBe(join(root, "persona"));
  const current = config(join(home, ".dori-codex"));
  expect((await installationPaths(current, home)).persona_dir).toBe(join(home, ".dori-codex/persona"));
});

test("path inspection never creates a missing installation or overwrites data", async () => {
  const home = setup(), path = join(home, "missing/config.json");
  expect((await installationPaths(path, home)).config_exists).toBe(false);
  expect(await Bun.file(path).exists()).toBe(false);
  config(join(home, "existing"), { personaDir: "kept", stateDir: "kept-state" });
  const existing = join(home, "existing/config.json"), before = await Bun.file(existing).text();
  await installationPaths(existing, home);
  expect(await Bun.file(existing).text()).toBe(before);
});
