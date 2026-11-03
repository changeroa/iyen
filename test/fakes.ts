import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";

export type World = {
  runtimeState?: "idle" | "running" | "waiting_approval";
  holdFails?: boolean;
  runtimeCalls?: string[];
  prState: string;
  issueState: string;
  aheadCount: string;
  dirty: string;
  stuckReads: number;
  screen: string;
  panes: { pane_id: string; workspace_id: string; agent?: string; agent_status?: string; agent_session?: { agent: string; kind: string; value: string }; title?: string; cwd?: string }[];
  /** agent_status the target pane moves to when Enter is pressed (models a lane picking up the message). */
  onEnterStatus?: string;
  /** Screens returned by successive reads; falls back to `screen` when empty. */
  screens?: string[];
  calls: string[][];
};

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", panes: [], calls: [] });

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  if (cmd === "herdr" && a1 === "agent" && a2 === "list") return ok(JSON.stringify({ result: { agents: w.panes.filter(p => p.agent) } }));
  if (cmd === "herdr") return ok();
  if (argv.includes("session-host-start")) return ok();
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) return ok(`worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`);
  if (cmd === "git" && argv.includes("rev-parse")) return ok("a".repeat(40));
  if (cmd === "git" && argv.includes("--show-current")) return ok("dori/demo-lane");
  if (cmd === "git" && argv.includes("status")) return ok(w.dirty);
  if (cmd === "git" && argv.includes("rev-list")) return ok(w.aheadCount);
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`/tmp/dori-${process.getuid?.() ?? "user"}-${createHash("sha256").update(dir).digest("hex").slice(0,16)}`, { recursive: true, force: true });
  } };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, defaultCwd: "/repo", leadPane: "lead:p1", ...patch };
  const runtime = {
    inspect: async (_key: string) => ({ threadId: "thread-test", state: w.runtimeState ?? "idle" as const, goal: null }),
    input: async (_key: string, text: string, _id: string) => { (w.runtimeCalls ??= []).push(text); return { turnId: "turn-test" }; },
    hold: async (_key: string, _origin: "user" | "automatic") => { (w.runtimeCalls ??= []).push("hold"); if (w.holdFails) throw new Error("unconfirmed"); w.runtimeState = "idle"; return { threadId: "thread-test", state: "idle" as const, goal: null }; },
    release: async (_key: string, _origin: "user" | "automatic") => { (w.runtimeCalls ??= []).push("release"); return { threadId: "thread-test", state: "idle" as const, goal: null }; },
    stop: async (_key: string) => { (w.runtimeCalls ??= []).push("stop"); },
  };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, runtime, exists: () => true };
};
