import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FlowDeps } from "./done-flow.ts";
import { LANE_KEY, type Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors } from "./signals.ts";
import { canLaunch } from "./routing.ts";
import { sampleHost } from "./host-guard.ts";
export type LaunchInput = { key: string; title: string; brief: string; done: string; thread?: string; model?: string; cwd?: string; worktree?: boolean; role?: "lead" | "lane" };
export class LaunchError extends Error { constructor(message: string, readonly exitCode = 2) { super(message); } }
export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if ((input.key === "lead") !== (input.role === "lead")) throw new LaunchError("lead is a reserved role/key pair");
  if (!LANE_KEY.test(input.key)) throw new LaunchError("Invalid lane key");
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} already exists`);
  if (input.role !== "lead") { const errors = doneSyntaxErrors(input.done); if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`); }
  if (input.model?.includes("/")) throw new LaunchError("Use a Codex model ID");
};
export const footer = (lane: Lane): string => `\n## Dori lane contract\nKey: ${lane.key}\nThread: ${lane.thread}\nDone = ${lane.done}\nUse dori report ${lane.key} --kind milestone --text-file PATH --event-id ID at milestones.\nUse dori claim-done ${lane.key} --evidence TEXT when complete, then stay idle. Dori verifies evidence and closes after five minutes without an objection. Do not delete worktrees or spawn unregistered agents.\n`;
export const launchLane = async (deps: FlowDeps, input: LaunchInput, boot: (lane: Lane) => Promise<void>): Promise<{ lane: Lane; startup: string }> => {
  await validateLaunch(deps, input);
  const verdict = canLaunch(await sampleHost(deps.run), deps.config.guard);
  if (!verdict.ok) throw new LaunchError(`HOLD ${verdict.reasons.join("; ")}`, 4);
  const original = resolve(input.cwd ?? deps.config.defaultCwd);
  if (!existsSync(original)) throw new LaunchError("cwd does not exist");
  if (!(await Bun.file(input.brief).exists())) throw new LaunchError("brief not found");
  const briefText = await Bun.file(input.brief).text();
  let cwd = original, baseSha: string | undefined;
  const worktrees: string[] = [];
  if (input.worktree) {
    const head = await deps.run(["git", "-C", original, "rev-parse", "HEAD"]);
    if (head.code !== 0) throw new LaunchError("Cannot resolve worktree base");
    baseSha = head.out;
    cwd = join(original, ".dori-worktrees", input.key);
    const added = await deps.run(["git", "-C", original, "worktree", "add", "-b", `dori/${input.key}`, cwd, baseSha]);
    if (added.code !== 0) throw new LaunchError("Worktree creation failed; inspect repository");
    worktrees.push(cwd);
  }
  const brief = join(deps.config.stateDir, "briefs", `${input.key}.md`);
  let lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", role: input.role ?? "lane", brief, done: input.done, cwd, repository: original, baseSha, worktrees,
    model: input.model, status: "working", cycle: 1, openedAt: iso(deps.clock), runtime: { kind: "codex", state: "starting", hostInstanceId: "", generation: 0, binaryVersion: deps.config.runtime.requiredVersion } };
  mkdirSync(join(deps.config.stateDir, "briefs"), { recursive: true, mode: 0o700 });
  await Bun.write(brief, briefText + (lane.role === "lead" ? "" : footer(lane)));
  await deps.registry.write(lane);
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", input.key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError("Herdr tab creation failed; lane intent retained");
  const made = JSON.parse(created.out).result;
  lane = await deps.registry.update(input.key, l => ({ ...l, pane: made.root_pane.pane_id, tab: made.tab_id ?? made.root_pane.tab_id }));
  await boot(lane);
  const deadline = deps.clock.now() + deps.config.runtime.startupTimeoutMs;
  for (let attempts = 0; deps.clock.now() < deadline && attempts < 120; attempts++) {
    lane = (await deps.registry.read(input.key))!;
    if (lane.runtime?.threadId) {
      try {
        await deps.runtime.input(lane.key, await Bun.file(brief).text(), `launch:${lane.key}:${lane.cycle}`);
        return { lane, startup: `STARTUP_OK ${lane.key} ${lane.runtime.threadId}` };
      } catch { return { lane, startup: `STARTUP_UNCONFIRMED ${lane.key}: initial input outcome unknown` }; }
    }
    await deps.clock.sleep(250);
  }
  return { lane, startup: `STARTUP_UNCONFIRMED ${lane.key}: runtime handshake pending` };
};
export const quoteForPane = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { pane: string; threadId: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  if (!input.threadId) throw new LaunchError("Explicit Codex thread ID required");
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, role: "lane", status: "working", openedAt: iso(deps.clock), runtime: { kind: "codex", threadId: input.threadId, state: "idle", hostInstanceId: "adopted", generation: 0, binaryVersion: deps.config.runtime.requiredVersion } };
  await deps.registry.write(lane); return (await deps.registry.read(lane.key))!;
};
