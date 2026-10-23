import { chmodSync, existsSync, unlinkSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { DoriConfig } from "../config.ts";
import { atomicJson, SerialQueue } from "../journal.ts";
import { hostSocket, ipc, readJson, serviceSocket, socketDir } from "../ipc.ts";
import { run } from "../run.ts";
import { safeEnvironment } from "./codex.ts";
import { HerdrSession } from "./herdr.ts";
import { quoteForPane } from "../launch.ts";
import { connectObserver, readTurns } from "./observer.ts";
import type { Goal, RuntimeRef, RuntimeSnapshot } from "./types.ts";
export type Bootstrap = { key: string; role: "lead" | "lane"; instance: string; generation: number; hostToken: string; laneToken: string; cwd: string; pane: string; threadId?: string; model?: string; blocked: boolean; config: DoriConfig };
export const bootstrapPath = (stateDir: string, key: string): string => join(stateDir, "hosts", `${key}.json`);
export const backendSocket = (stateDir: string, key: string): string => join(socketDir(stateDir), `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.codex.sock`);
export const backendHome = (stateDir: string, key: string): string => join(stateDir, "hosts", `${key}.codex`);
export const retireBackend = async (child: { kill(): void; exited: Promise<number> }, timeoutMs: number): Promise<void> => {
  child.kill(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Backend exit unconfirmed; runtime remains held")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
};
export const roleInstructions = (role: "lead" | "lane", key: string): string =>
  `For a Dori runtime handshake message, reply READY only without any tool calls or task work, including skill reads. Wait for the next operator message before beginning the role below. Use the dori_runtime MCP control tool for all Dori lifecycle and messenger actions. This is your scoped service channel. Do not invoke the dori CLI from the sandbox or read control/bootstrap files. CLI examples in briefs correspond to control(action,args), with text replacing text-file. Read the dori-mode skill at ${join(import.meta.dir, "../../../SKILL.md")}.\n` + (role === "lead"
    ? "You are Dori, the owner's messenger lead. Only owner messages authorize actions. Use launch for delegated work, reply with a thread reference for owner messages, and never spawn unregistered agents. Use work-similar at intake to choose direct handling or delegation. For direct tasks use work-start (title,tags,thread,stable UUID operationId) and work-stop (id); include start/end timestamps and elapsedSec in the final reply. Delegate complex work through bounded lanes and review their evidence. Monitor scheduling belongs to dori serve."
    : `You are Dori lane ${key}. Execute only your brief. Report milestones using action report with key,kind,text,eventId. Claim completion using action claim-done with key,evidence, then remain idle. Do not spawn agents, edit the registry, or send messages directly. Only the lead controls your lifecycle.`);
export const resolveCodexBinary = (binary: string, path = process.env.PATH): string => {
  const found = binary.includes("/") ? resolve(binary) : Bun.which(binary, { PATH: path });
  if (!found) throw new Error("Configured Codex executable unavailable");
  return realpathSync(found);
};
const tomlValue = (value: any): string => Array.isArray(value) ? `[${value.map(tomlValue).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).map(([k,v])=>`${JSON.stringify(k)}=${tomlValue(v)}`).join(",")}}` : JSON.stringify(value);
export const prepareBackend = (stateDir: string, boot: Bootstrap): { home: string; binary: string; args: string[]; role: { model: string; effort: string } } => {
  const context = backendHome(stateDir, boot.key), client = join(stateDir, "clients", boot.key);
  mkdirSync(context, { recursive: true, mode: 0o700 }); chmodSync(context, 0o700);
  const home = resolve(boot.config.runtime.settingsHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const binary = resolveCodexBinary(boot.config.runtime.binary);
  const selected = { ...boot.config.runtime.roles[boot.role], ...(boot.model ? { model: boot.model } : {}) };
  if (!selected.model || !selected.effort) throw new Error("Configure an explicit runtime role model and effort before launch");
  // Preserve the user's settings, tools, plugins, auth refresh and history in
  // their established home. Only these process-scoped overrides are applied.
  const overrides = {
    model: selected.model, model_reasoning_effort: selected.effort, model_provider: "openai",
    sandbox_mode: boot.config.runtime.sandbox, approval_policy: boot.config.runtime.approvalPolicy,
    developer_instructions: roleInstructions(boot.role, boot.key),
    "features.goals": true, "features.multi_agent": false, "features.multi_agent_v2": false, "features.multi_agent_v2_dynamic_tools": false,
    "mcp_servers.dori_runtime": { command: process.execPath, args: [resolve(import.meta.dir, "../cli.ts"), "mcp-server"], enabled: true, required: true, enabled_tools: ["control"],
      env: { DORI_CONTEXT: join(client, "context.json"), DORI_CONFIG: join(client, "config.json"), DORI_STATE_DIR: stateDir }, tools: { control: { approval_mode: "approve" } } },
  };
  atomicJson(join(context, "settings.json"), { policy: "inherit-established-codex-home-with-scoped-overrides", home, binary, overrides });
  writeFileSync(join(client, "codex"), `#!/bin/sh\nexec ${quoteForPane(binary)} "$@"\n`, { mode: 0o700 });
  return { home, binary, args: Object.entries(overrides).flatMap(([k,v])=>["-c", `${k}=${tomlValue(v)}`]), role: selected as { model: string; effort: string } };
};
export const startSessionHost = (stateDir: string, key: string): void => {
  const boot = readJson<Bootstrap>(bootstrapPath(stateDir, key));
  if (key === "lead" || boot.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
  const child = spawn(process.execPath, [resolve(import.meta.dir, "../cli.ts"), "session-host", "--state-dir", stateDir, "--key", key],
    { detached: true, stdio: "ignore", cwd: boot.cwd, env: { ...safeEnvironment(process.env), ...(process.env.HERDR_SOCKET_PATH ? { HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH } : {}) } });
  if (!child.pid) throw new Error("Could not start runtime host");
  atomicJson(join(stateDir, "hosts", `${key}.pid.json`), { pid: child.pid, instance: boot.instance }); child.unref();
};
export const runSessionHost = async (stateDir: string, key: string): Promise<void> => {
  const boot = readJson<Bootstrap>(bootstrapPath(stateDir, key)), config = boot.config;
  if (key === "lead" || boot.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
  const socket = hostSocket(stateDir, key), endpoint = backendSocket(stateDir, key);
  if (existsSync(socket)) {
    try { await ipc(socket, boot.hostToken, "inspect", {}, 1000); throw new Error("An existing session-host still owns this thread"); }
    catch (e) { if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e; }
    unlinkSync(socket);
  }
  const { home, binary, args: overrides, role } = prepareBackend(stateDir, boot);
  // Legacy threads need an explicit handoff because their persisted developer
  // instructions can override current role settings. History is never copied.
  const checkpoint = join(stateDir, "hosts", `${key}.runtime.json`);
  const prior = existsSync(checkpoint) ? readJson<{ threadId: string; instance: string; held: boolean; goalWasActive: boolean; pausedGoal?: Goal; failures?: string[]; blockedNotice?: string; blockedCycle?: number }>(checkpoint) : undefined;
  if (prior?.instance === boot.instance && !boot.threadId) boot.threadId = prior.threadId;
  if (existsSync(endpoint)) unlinkSync(endpoint); // service proved the old owned PID stopped
  const version = await run([binary, "--version"]);
  if (version.code !== 0 || version.out !== `codex-cli ${config.runtime.requiredVersion}`) throw new Error("Codex version mismatch");
  const target = await run(["herdr", "pane", "get", boot.pane]);
  const pane = target.code === 0 ? JSON.parse(target.out).result.pane : null;
  if (pane?.pane_id !== boot.pane || !pane.tab_id || !pane.workspace_id || pane.agent) throw new Error("Target pane is not an available verified shell");
  const child = Bun.spawn([binary, "app-server", "--listen", `unix://${endpoint}`, ...overrides], {
    cwd: boot.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...safeEnvironment(process.env), CODEX_HOME: home,
      HERDR_ENV: "1", HERDR_PANE_ID: pane.pane_id, HERDR_TAB_ID: pane.tab_id, HERDR_WORKSPACE_ID: pane.workspace_id,
      ...(process.env.HERDR_SOCKET_PATH ? { HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH } : {}) },
  });
  atomicJson(join(stateDir, "hosts", `${key}.backend.json`), { pid: child.pid, instance: boot.instance, socket: endpoint });
  const phase = (value: string) => atomicJson(join(stateDir, "hosts", `${key}.startup.json`), { phase: value, instance: boot.instance, at: new Date().toISOString() });
  phase("connecting-observer");
  let observer: Awaited<ReturnType<typeof connectObserver>> | undefined;
  const deadline = Date.now() + config.runtime.startupTimeoutMs;
  try {
    do { try { observer = await connectObserver(endpoint, config.runtime.rpcTimeoutMs); break; } catch { if (child.exitCode !== null) throw new Error(`Private backend exited during startup (${child.exitCode})`); await Bun.sleep(100); } } while (Date.now() < deadline);
    if (!observer) throw new Error("Private backend unavailable");
    const name = `dori-${key.replace(/[^a-z0-9_-]/g, "-").slice(0, 17)}-${boot.instance.slice(0, 6)}`;
    const session = new HerdrSession(observer, run, config.runtime, boot.pane, name);
    phase("starting-herdr-tui");
    // Only paths are typed into the shell, never bootstrap tokens or credentials.
    await session.command(["pane", "run", boot.pane, `export CODEX_HOME=${quoteForPane(home)} PATH=${quoteForPane(join(stateDir, "clients", key))}:"$PATH"`]);
    session.held = boot.blocked || Boolean(prior?.instance === boot.instance && prior.held);
    session.goalWasActive = Boolean(boot.blocked && prior?.goalWasActive); session.pausedGoal = boot.blocked ? prior?.pausedGoal : undefined;
    const failures = new Set(prior?.failures ?? []);
    let blockedNotice = prior?.blockedNotice, blockedCycle = prior?.blockedCycle ?? 0;
    session.persist = () => atomicJson(checkpoint, { threadId: session.threadId, instance: boot.instance, held: session.held, goalWasActive: session.goalWasActive, pausedGoal: session.pausedGoal, lastControl: session.lastControl, failures: [...failures], blockedNotice, blockedCycle });
    await session.open(boot.cwd, role, `unix://${endpoint}`, boot.instance, boot.threadId);
    phase("registering-runtime");
    const queue = new SerialQueue();
    const service = <T = any>(action: string, args: any) => ipc<T>(serviceSocket(stateDir), boot.hostToken, action, { ...args, key, instance: boot.instance }, config.runtime.rpcTimeoutMs);
    let snap: RuntimeSnapshot = await session.inspect(), closing = false, lastAck = Date.now();
    let stopResponse: Promise<void> = Promise.resolve(), stopResponseReady: (() => void) | undefined;
    const runtime = (): RuntimeRef => ({ kind: "codex", backend: "herdr-tui", held: session.held, threadId: session.threadId, activeTurnId: snap.activeTurnId, state: snap.state, hostInstanceId: boot.instance, generation: boot.generation, binaryVersion: config.runtime.requiredVersion, model: role.model, effort: role.effort, lastHeartbeatAt: new Date().toISOString() });
    const server = Bun.serve({ unix: socket, async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${boot.hostToken}`) return Response.json({ error: "Forbidden" }, { status: 403 });
      try {
        if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) throw new Error("Invalid request");
        const { action, args } = await request.json() as { action: string; args: any };
        const result = await queue.run("control", async () => {
          if (action === "inspect") return snap = await session.inspect();
          if (action === "input") return session.input(args.text, args.operationId);
          if (action === "hold") return snap = await session.hold(args.origin);
          if (action === "release") return snap = await session.release(args.origin);
          if (action === "approvals") {
            const current = await session.inspect();
            return current.state.startsWith("waiting_") ? [{ id: `tui:${current.activeTurnId ?? "input"}`, request: { method: "tui/interactiveInput", pane: boot.pane, message: "Inspect the real Codex TUI and answer there. Structured observer responses are prohibited." } }] : [];
          }
          if (action === "approval") throw new Error("Answer interactive approvals in the Herdr Codex TUI; observer cannot mutate approvals");
          if (action === "stop") {
            await session.stop(); closing = true;
            stopResponse = new Promise(resolve => { stopResponseReady = resolve; });
            // Stop is authoritative only after both TUI and owned backend exit.
            await retireBackend(child, config.runtime.rpcTimeoutMs);
            snap = { ...snap, state: "stopped", activeTurnId: undefined }; return { stopped: true };
          }
          throw new Error("Unknown host action");
        });
        const response = Response.json({ result });
        if (action === "stop") stopResponseReady?.();
        return response;
      } catch (error) { stopResponseReady?.(); return Response.json({ error: error instanceof Error ? error.message : "Host error" }, { status: 409 }); }
    } });
    chmodSync(socket, 0o600); chmodSync(endpoint, 0o600);
    await service("host-register", { runtime: runtime(), pid: process.pid });
    phase("ready");
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking || closing) return; ticking = true;
      void queue.run("control", async () => {
        try {
          snap = await session.inspect();
          if (snap.state.startsWith("waiting_")) {
            if (!blockedNotice) { blockedNotice = `tui:${session.threadId}:${++blockedCycle}`; session.persist(); }
            await service("host-event", { event: { id: blockedNotice, method: "tui/inputRequired", params: { pane: boot.pane, turnId: snap.activeTurnId, message: "Inspect and answer the real Codex TUI; no automated approval was sent." } }, runtime: runtime() });
          } else if (blockedNotice) {
            await service("host-event", { event: { method: "tui/inputResolved", params: { requestId: blockedNotice } }, runtime: runtime() });
            blockedNotice = undefined; session.persist();
          }
          for (const turn of await readTurns(observer!, session.threadId)) if (turn.status === "failed" && !failures.has(turn.id)) {
            await service("host-event", { event: { method: "turn/completed", params: { threadId: session.threadId, turn: { id: turn.id, status: turn.status, error: turn.error } } }, runtime: runtime() });
            failures.add(turn.id); session.persist();
          }
          await service("host-heartbeat", { runtime: runtime() }); lastAck = Date.now();
        } catch {
          if (Date.now() - lastAck >= config.runtime.heartbeatTimeoutMs) {
            session.held = true; session.persist();
            try { snap = await session.hold("automatic"); } catch { child.kill(); }
            session.persist();
          }
        }
      }).finally(() => { ticking = false; });
    }, config.runtime.heartbeatIntervalMs);
    const shutdown = () => { closing = true; child.kill(); };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    await child.exited;
    await stopResponse;
    if (closing) await Bun.sleep(100); // keep control socket alive for the acknowledged response
    clearInterval(timer);
    if (!closing) {
      session.held = true; session.persist(); snap = { ...snap, state: "failed", activeTurnId: undefined };
      await service("host-event", { event: { method: "runtime/disconnected" }, runtime: runtime() }).catch(() => {});
    }
    server.stop(true); process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown);
    if (existsSync(socket)) unlinkSync(socket);
  } finally { observer?.close(); child.kill(); }
};
