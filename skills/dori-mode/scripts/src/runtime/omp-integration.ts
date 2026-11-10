import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { DoriConfig } from "../config.ts";
import { DeliveryDeferred } from "../mailbox.ts";
import { run, type Runner } from "../run.ts";
import { connectOmp } from "./omp/client.ts";
import { discoverOmp } from "./omp/launcher.ts";
import { OmpError, sameIdentity, validReceipt, payloadHash, type OmpTarget, type OmpSnapshot } from "./omp/contract.ts";
import type { RuntimeInputReceipt, RuntimeSnapshot } from "./types.ts";

/** Establish the same narrow process boundary as managed Codex, without inherited service/admin context. */
export const ompProfileEnvironment = (settingsHome: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "OPENAI_API_KEY"]) if (env[key]) safe[key] = env[key]!;
  return { ...safe, PATH: `${dirname(process.execPath)}:${env.PATH ?? "/usr/bin:/bin"}`, PI_CODING_AGENT_DIR: settingsHome };
};
export const sameOmpTarget = (a: OmpTarget, b: OmpTarget): boolean => sameIdentity(a, b) && a.socketPath === b.socketPath && a.tokenFile === b.tokenFile;
export const ompSnapshot = (snap: OmpSnapshot): RuntimeSnapshot => ({ threadId: snap.identity.sessionId, state: snap.state, activeTurnId: snap.activeRunId, goal: snap.goal,
  held: snap.held, inputReady: !snap.held && snap.goal?.status !== "paused" && snap.state === "idle" && snap.capabilities.input && snap.capabilities.durableReceipts });
export const ompVersionMatches = (output: string, version: string): boolean => [version, `omp ${version}`, `omp/${version}`].includes(output.trim());
export const discoverOmpSafe = async (dir: string): Promise<OmpTarget[]> => {
  try { return await discoverOmp(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

export const verifyOmpHerdr = async (target: OmpTarget, runner: Runner = run): Promise<void> => {
  const result = await runner(["herdr", "agent", "list"]);
  if (result.code !== 0) throw new Error("OMP Herdr association unavailable");
  const agents = JSON.parse(result.out).result.agents as any[];
  const matching = agents.filter(a => a.agent === "omp" && a.agent_session?.agent === "omp" && a.agent_session?.kind === "path" && a.agent_session?.source === "herdr:omp" && a.agent_session?.value === target.sessionFile);
  if (matching.length !== 1 || matching[0].pane_id !== target.paneId || matching[0].terminal_id !== target.terminalId || realpathSync(matching[0].cwd) !== target.cwd) throw new Error("OMP exact session file/pane/terminal/cwd association mismatch");
};
export const findOmpTarget = async (config: DoriConfig, args: { sessionId: string; sessionFile: string; pane: string; terminalId: string; cwd: string }, runner: Runner = run): Promise<OmpTarget> => {
  if (config.runtime.kind !== "omp" || !config.runtime.omp) throw new Error("Explicit OMP profile required");
  if (!args.sessionId || !args.sessionFile || !args.pane || !args.terminalId || !args.cwd) throw new Error("OMP activation requires native UUID, session-file, pane, terminal-id and cwd");
  const file = realpathSync(args.sessionFile), cwd = realpathSync(args.cwd);
  const all = await discoverOmpSafe(config.runtime.omp.registryDir);
  // Multiple live controllers for a pinned file are an ambiguity, even if one matches the requested pane.
  const candidates = all.filter(t => t.sessionFile === file);
  if (candidates.length !== 1) throw new Error("OMP extension missing or ambiguous; explicitly load the Iyen extension in the existing TUI and inspect doctor");
  const target = candidates[0]!;
  if (target.sessionId !== args.sessionId || target.paneId !== args.pane || target.terminalId !== args.terminalId || target.cwd !== cwd || target.role !== "attached-lead" || target.laneKey !== "lead" || target.runtimeVersion !== config.runtime.requiredVersion) throw new Error("OMP activation exact target mismatch");
  await verifyOmpHerdr(target, runner);
  const controller = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
  try { const snap = await controller.inspect(); if (!snap.capabilities.input || !snap.capabilities.durableReceipts) throw new Error("OMP durable receipt capability required"); }
  finally { controller.close(); }
  return target;
};
export const callOmp = async (target: OmpTarget, action: string, args: any, config: DoriConfig, runner: Runner = run): Promise<any> => {
  await verifyOmpHerdr(target, runner);
  const controller = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
  try {
    if (action === "inspect") return ompSnapshot(await controller.inspect());
    if (action === "interactions" || action === "approvals") return await controller.interactions();
    if (action === "interaction-respond") return await controller.interactionRespond(args.requestId, args.response, args.operationId);
    if (action === "interaction-response-status") return await controller.interactionResponseStatus(args.operationId);
    if (action === "input") {
      const snap = await controller.inspect();
      if (snap.held || snap.goal?.status === "paused" || !["idle", "running"].includes(snap.state) || !snap.capabilities.input || !snap.capabilities.durableReceipts) throw new DeliveryDeferred("OMP is held or not ready for durable input");
      try {
        const { receipt } = await controller.input(args.text, args.operationId);
        if (!validReceipt(receipt, target, args.operationId, payloadHash(args.text))) throw new Error("Invalid OMP delivery receipt");
        return { turnId: receipt.receiptId, receiptKind: "omp-session-entry", receipt } satisfies RuntimeInputReceipt;
      } catch (error) { if (error instanceof OmpError && error.attempted === false) throw new DeliveryDeferred(error.message); throw error; }
    }
    if (action === "operation") return await controller.operation(args.operationId, args.text);
    throw new Error("Borrowed OMP lead supports inspect/input only; detach never aborts or stops its TUI");
  } finally { controller.close(); }
};
