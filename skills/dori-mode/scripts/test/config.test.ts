import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultConfig, fill, loadConfig, parseConfig, workspaceForRole } from "../src/config.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterAll(() => state.done());
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.runtime.kind).toBe("codex");
  expect(c.runtime.requiredVersion).toBe("0.163.0");
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("work timing threshold defaults to two minutes and accepts a configured override", async () => {
  const fallback = await loadConfig(join(state.dir, "missing.json"), "/home/ana");
  expect(fallback.workThresholdSec).toBe(120);
  const path = join(state.dir, "threshold.json");
  await Bun.write(path, JSON.stringify({ workThresholdSec: 45 }));
  expect((await loadConfig(path)).workThresholdSec).toBe(45);
});

test("invalid work thresholds are refused at the config boundary", async () => {
  const path = join(state.dir, "invalid-threshold.json");
  for (const value of [0, -1, "120", null]) {
    await Bun.write(path, JSON.stringify({ workThresholdSec: value }));
    await expect(loadConfig(path)).rejects.toThrow("workThresholdSec must be a positive number");
  }
});

test("lead workspace is independent and falls back to lane workspace for existing configs", () => {
  const config = { ...defaultConfig(), laneWorkspace: "workers" };
  expect(workspaceForRole(config, "lead")).toBe("workers");
  expect(workspaceForRole({...config, leadWorkspace: "lead"}, "lead")).toBe("lead");
  expect(workspaceForRole({...config, leadWorkspace: "lead"}, "lane")).toBe("workers");
  expect(() => parseConfig({leadWorkspace: 5})).toThrow("leadWorkspace must be a string");
});
