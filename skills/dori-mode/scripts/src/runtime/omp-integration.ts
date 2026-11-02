import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { acquireFileFence } from "../binding-fence.ts";
import { dirname, join, resolve } from "node:path";
import type { DoriConfig } from "../config.ts";
import { atomicJson } from "../journal.ts";
import { hostSocket, ipc, readJson, serviceSocket } from "../ipc.ts";
import { DeliveryDeferred } from "../mailbox.ts";
import { quoteForPane } from "../launch.ts";
import { run, type Runner } from "../run.ts";
import { connectOmp } from "./omp/client.ts";
import { discoverOmp, prepareOmpLaunch } from "./omp/launcher.ts";
import { OmpError, sameIdentity, validReceipt, payloadHash, type OmpTarget, type OmpSnapshot, type OmpExtensionBootstrap } from "./omp/contract.ts";
import type { Bootstrap } from "./session-host.ts";
import type { RuntimeInputReceipt, RuntimeRef, RuntimeSnapshot } from "./types.ts";

/** Establish the same narrow process boundary as managed Codex, without inherited service/admin context. */
export const ompManagedEnvironment = (settingsHome: string, pane: { pane_id: string; tab_id: string; workspace_id: string }, env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "OPENAI_API_KEY"]) if (env[key]) safe[key] = env[key]!;
  return { ...safe, PATH: `${dirname(process.execPath)}:${env.PATH ?? "/usr/bin:/bin"}`, PI_CODING_AGENT_DIR: settingsHome,
    HERDR_ENV: "1", HERDR_PANE_ID: pane.pane_id, HERDR_TAB_ID: pane.tab_id, HERDR_WORKSPACE_ID: pane.workspace_id,
    ...(env.HERDR_SOCKET_PATH ? { HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH } : {}) };
};
export const ompPaneCommand = (spec: { cwd: string; argv: string[]; env: Record<string, string> }): string => {
  if (Object.keys(spec.env).some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid managed environment variable");
  return `cd ${quoteForPane(spec.cwd)} && env -i ${Object.entries(spec.env).map(([k,v]) => `${k}=${quoteForPane(v)}`).join(" ")} ${spec.argv.map(quoteForPane).join(" ")}`;
};
export const sameOmpTarget = (a: OmpTarget, b: OmpTarget): boolean => sameIdentity(a, b) && a.socketPath === b.socketPath && a.tokenFile === b.tokenFile;
export const ompHostOwnerPath = (stateDir: string, key: string) => join(stateDir, "hosts", `${key}.socket-owner.json`);
/** Capture the legacy host's ownership before the launcher rotates its PID file. */
export const preserveOmpSocketOwner = (stateDir: string, key: string): void => {
  if (!existsSync(hostSocket(stateDir, key)) || existsSync(ompHostOwnerPath(stateDir, key))) return;
  const prior = readJson<{ pid: number; instance: string }>(join(stateDir, "hosts", `${key}.pid.json`));
  if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || !prior.instance || processAlive(prior.pid)) throw new Error("Prior OMP host death unverified; socket retained");
  atomicJson(ompHostOwnerPath(stateDir, key), prior);
};
/** Called only while owning the per-lane host lifetime fence. */
export const prepareOmpHostSocket = async (stateDir: string, boot: Pick<Bootstrap, "key" | "instance" | "generation">): Promise<void> => {
  const socket = hostSocket(stateDir, boot.key), ownerPath = ompHostOwnerPath(stateDir, boot.key);
  if (existsSync(socket)) {
    preserveOmpSocketOwner(stateDir, boot.key);
    const owner = readJson<{ pid: number; instance: string }>(ownerPath);
    const before = lstatSync(socket);
    if (!before.isSocket() || before.isSymbolicLink() || before.uid !== process.getuid?.() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.instance || processAlive(owner.pid)) throw new Error("OMP host endpoint ownership or prior death unverified");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection({ path: socket });
      const timer = setTimeout(() => { probe.destroy(); reject(new Error("OMP host socket liveness unknown; retained")); }, 1000);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); reject(new Error("An existing OMP host still owns this socket")); });
      probe.once("error", error => { clearTimeout(timer); probe.destroy(); if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(); else reject(new Error("OMP host socket liveness unknown; retained")); });
    });
    const after = lstatSync(socket), latestOwner = readJson<{ pid: number; instance: string }>(ownerPath);
    if (after.dev !== before.dev || after.ino !== before.ino || latestOwner.pid !== owner.pid || latestOwner.instance !== owner.instance || processAlive(owner.pid)) throw new Error("OMP host endpoint changed during stale-socket probe");
    unlinkSync(socket);
  }
  atomicJson(ownerPath, { pid: process.pid, instance: boot.instance, generation: boot.generation });
};
export const ompSnapshot = (snap: OmpSnapshot): RuntimeSnapshot => ({ threadId: snap.identity.sessionId, state: snap.state, activeTurnId: snap.activeRunId, goal: snap.goal,
  held: snap.held, inputReady: !snap.held && snap.goal?.status !== "paused" && snap.state === "idle" && snap.capabilities.input && snap.capabilities.durableReceipts });
export const ompVersionMatches = (output: string, version: string): boolean => output.trim() === version || output.trim() === `omp ${version}`;
export const discoverOmpSafe = async (dir: string): Promise<OmpTarget[]> => {
  try { return await discoverOmp(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

/** Herdr may publish native process exit after the OS has already reaped it. */
export const waitForOmpDetach = async (sessionFile: string, deadline: number, runner: Runner = run): Promise<void> => {
  while (Date.now() < deadline) {
    const result = await runner(["herdr", "agent", "list"], { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (result.code !== 0) throw new Error("OMP Herdr process association unverified; stop unconfirmed");
    const agents = JSON.parse(result.out).result?.agents;
    if (!Array.isArray(agents)) throw new Error("OMP Herdr process association unverified; stop unconfirmed");
    if (agents.some(a => !a || typeof a !== "object" || typeof a.agent !== "string" || !a.agent ||
      (a.agent === "omp" && (typeof a.agent_session?.value !== "string" || !a.agent_session.value)))) {
      throw new Error("OMP Herdr process association unverified; stop unconfirmed");
    }
    if (!agents.some(a => a.agent === "omp" && a.agent_session?.value === sessionFile)) return;
    await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new Error("OMP Herdr process association still present; stop unconfirmed");
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
    if (target.role === "attached-lead") throw new Error("Borrowed OMP lead supports inspect/input only; detach never aborts or stops its TUI");
    if (action === "hold") return ompSnapshot(await controller.hold(args.origin, args.operationId ?? crypto.randomUUID()));
    if (action === "release") return ompSnapshot(await controller.release(args.origin, args.operationId ?? crypto.randomUUID()));
    if (action === "stop") return await controller.stop(args.operationId ?? crypto.randomUUID());
    throw new Error("Unsupported OMP action");
  } finally { controller.close(); }
};

/** OMP host owns the service bridge; the native TUI owns the control extension. */
export const runOmpSessionHost = async (stateDir: string, boot: Bootstrap): Promise<void> => {
  const release = await acquireFileFence(join(stateDir, "hosts", `${boot.key}.host.lock`), Math.min(5000, boot.config.runtime.rpcTimeoutMs));
  try { await prepareOmpHostSocket(stateDir, boot); await runOmpOwnedSessionHost(stateDir, boot); }
  finally { await release(); }
};
const runOmpOwnedSessionHost = async (stateDir: string, boot: Bootstrap): Promise<void> => {
  const config = boot.config, omp = config.runtime.omp;
  if (!omp || boot.role !== "lane" || boot.key === "lead") throw new Error("Invalid managed OMP host");
  const role = { ...config.runtime.roles.lane, ...(boot.model ? { model: boot.model } : {}) };
  if (!role.model || !role.effort) throw new Error("OMP requires explicit provider/model/effort");
  const version = await run([config.runtime.binary, "--version"]);
  if (version.code !== 0 || !ompVersionMatches(version.out, config.runtime.requiredVersion)) throw new Error("OMP version mismatch");
  const checkpoint = join(stateDir, "hosts", `${boot.key}.runtime.json`);
  const prior = existsSync(checkpoint) ? readJson<{ threadId: string; target: OmpTarget; held: boolean; pid?: number }>(checkpoint) : undefined;
  if (boot.threadId && (!prior?.target || prior.threadId !== boot.threadId)) throw new Error("OMP resume requires the exact saved native session file; no ID/history conversion");
  const result = await run(["herdr", "pane", "get", boot.pane]);
  const pane = result.code === 0 ? JSON.parse(result.out).result.pane : null;
  if (pane?.pane_id !== boot.pane || !pane.terminal_id || !pane.tab_id) throw new Error("OMP target pane metadata unavailable");
  let target: OmpTarget | undefined, snap: OmpSnapshot | undefined;
  const existing = await discoverOmpSafe(omp.registryDir);
  if (prior?.target && boot.threadId) {
    const exact = existing.filter(t => sameIdentity(t, prior.target));
    if (existing.filter(t => t.sessionFile === prior.target.sessionFile).length > 1) throw new Error("OMP controller ambiguity");
    if (exact.length === 1) {
      target = exact[0]!;
      await verifyOmpHerdr(target);
      const c = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
      try { snap = await c.inspect(); } finally { c.close(); }
    } else if (existing.some(t => t.sessionFile === prior.target.sessionFile)) throw new Error("OMP native controller changed; explicit reattachment required");
  }
  if (!target) {
    if (pane.agent) throw new Error("OMP target pane is not an available verified shell");
    if (boot.threadId) {
      const oldPid = controllerPid(omp.registryDir, prior!.target) ?? prior?.pid;
      if (!oldPid || processAlive(oldPid)) throw new Error("Prior OMP process exit unverified; refuse resume");
    }
    const clientDir = join(stateDir, "clients", boot.key), bootstrapFile = join(stateDir, "hosts", `${boot.key}.omp-bootstrap.json`);
    const bootstrap: OmpExtensionBootstrap = { protocol: 1, registryDir: omp.registryDir, role: "managed-lane", laneKey: boot.key,
      expectedCwd: realpathSync(boot.cwd), expectedPaneId: boot.pane, expectedTerminalId: pane.terminal_id,
      ...(boot.threadId ? { expectedSessionId: boot.threadId, expectedSessionFile: prior!.target.sessionFile } : {}),
      service: { contextFile: join(clientDir, "context.json"), configFile: join(clientDir, "config.json"), stateDir, cliPath: resolve(import.meta.dir, "../cli.ts"), bunBinary: process.execPath } };
    atomicJson(bootstrapFile, bootstrap);
    const spec = prepareOmpLaunch({ binary: config.runtime.binary, registryDir: omp.registryDir, bootstrapFile, extensionPath: omp.extensionPath,
      cwd: boot.cwd, provider: omp.provider, model: role.model, effort: role.effort, approvalMode: omp.approvalMode,
      ...(boot.threadId ? { resumeSessionFile: prior!.target.sessionFile } : {}),
      env: ompManagedEnvironment(config.runtime.settingsHome!, pane) });
    const command = ompPaneCommand(spec);
    const launched = await run(["herdr", "pane", "run", boot.pane, command]);
    if (launched.code !== 0) throw new Error("OMP launch outcome unknown; inspect pane before recovery");
    const deadline = Date.now() + config.runtime.startupTimeoutMs;
    while (Date.now() < deadline) {
      const candidates = (await discoverOmpSafe(omp.registryDir)).filter(t => t.paneId === boot.pane && t.terminalId === pane.terminal_id && t.cwd === bootstrap.expectedCwd && t.laneKey === boot.key && t.role === "managed-lane");
      if (candidates.length > 1) throw new Error("Ambiguous OMP native controllers");
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        if (boot.threadId && (candidate.sessionId !== boot.threadId || candidate.sessionFile !== prior!.target.sessionFile)) throw new Error("OMP resume identity mismatch");
        await verifyOmpHerdr(candidate);
        const controller = await connectOmp(candidate, { timeoutMs: config.runtime.rpcTimeoutMs });
        try { snap = await controller.inspect(); } finally { controller.close(); }
        target = candidate; break;
      }
      await Bun.sleep(100);
    }
  }
  if (!target || !snap) throw new Error("OMP controller startup unconfirmed; no handshake input sent");
  if (snap.provider !== omp.provider || snap.model !== role.model || snap.effort !== role.effort || target.runtimeVersion !== config.runtime.requiredVersion || !snap.capabilities.durableReceipts || !snap.capabilities.hold || !snap.capabilities.release || !snap.capabilities.stop) throw new Error("OMP managed capabilities/model/effort mismatch");
  const pinned = target;
  let held = Boolean(boot.blocked || boot.threadId), closing = false, nativeStopped = false, lastAck = Date.now();
  if (held) snap = await callOmp(pinned, "hold", { origin: "automatic" }, config).then(async () => {
    const c = await connectOmp(pinned); try { return await c.inspect(); } finally { c.close(); }
  });
  if (held && (!snap!.held || snap!.activeRunId || snap!.goal?.status === "active" || snap!.state !== "idle")) throw new Error("OMP managed hold unconfirmed; do not register ready");
  const attachedAt = new Date().toISOString(), nativePid = controllerPid(omp.registryDir, pinned) ?? prior?.pid;
  const persist = () => atomicJson(checkpoint, { threadId: pinned.sessionId, target: pinned, instance: boot.instance, held, pid: nativePid });
  const runtime = (): RuntimeRef => ({ kind: "omp", backend: "herdr-tui", threadId: pinned.sessionId, state: snap!.state, activeTurnId: snap!.activeRunId,
    hostInstanceId: boot.instance, generation: boot.generation, binaryVersion: pinned.runtimeVersion, held,
    model: snap!.model, effort: snap!.effort, lastHeartbeatAt: new Date().toISOString(),
    omp: { kind: "omp", target: pinned, attachmentInstanceId: boot.instance, attachmentGeneration: boot.generation, attachedAt, excludedInboxIds: [] } });
  const service = (action: string, args: any) => ipc(serviceSocket(stateDir), boot.hostToken, action, { ...args, key: boot.key, instance: boot.instance }, config.runtime.rpcTimeoutMs);
  const inspect = async () => { const c = await connectOmp(pinned, { timeoutMs: config.runtime.rpcTimeoutMs }); try { snap = await c.inspect(); held = held || snap.held; return ompSnapshot(snap); } finally { c.close(); } };
  const pid = nativePid;
  const server = Bun.serve({ unix: hostSocket(stateDir, boot.key), async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${boot.hostToken}`) return Response.json({ error: "Forbidden" }, { status: 403 });
    try {
      if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) throw new Error("Invalid request");
      const { action, args } = await request.json() as { action: string; args: any };
      let result: unknown;
      // No shared queue: native reservation queue serializes mutation starts, receipt waits remain independent.
      if (action === "inspect") result = await inspect();
      else if (action === "input") { if (held) throw new Error("OMP lane held before input"); result = await callOmp(pinned, action, args, config); }
      else if (action === "hold" || action === "release") { if (action === "hold") { held = true; persist(); } result = await callOmp(pinned, action, args, config); await inspect();
        if (action === "hold" && (!snap!.held || snap!.activeRunId || snap!.goal?.status === "active" || snap!.state !== "idle")) throw new Error("OMP hold unconfirmed");
        if (action === "release" && snap!.held) throw new Error("OMP release unconfirmed");
        held = action === "hold"; persist(); }
      else if (action === "operation") result = await callOmp(pinned, action, args, config);
      else if (action === "approvals") { const s = await inspect(); result = s.state.startsWith("waiting_") ? [{ id: `omp:${pinned.sessionId}`, request: { pane: boot.pane, message: "Inspect and answer the actual OMP TUI" } }] : []; }
      else if (action === "stop") {
        held = true; persist(); await callOmp(pinned, "stop", args, config);
        if (!pid) throw new Error("OMP process exit cannot be verified; host remains held");
        const until = Date.now() + config.runtime.rpcTimeoutMs;
        while (processAlive(pid) && Date.now() < until) await Bun.sleep(50);
        if (processAlive(pid)) throw new Error("OMP stop intent acknowledged but process exit unconfirmed");
        await waitForOmpDetach(pinned.sessionFile, until);
        nativeStopped = true; closing = true; result = { stopped: true };
      } else throw new Error("Unsupported OMP host action; approvals stay in the real TUI");
      return Response.json({ result });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "OMP host failed" }, { status: 409 }); }
  } });
  chmodSync(hostSocket(stateDir, boot.key), 0o600);
  const boundSocket = lstatSync(hostSocket(stateDir, boot.key)); persist();
  await service("host-register", { runtime: runtime(), pid: process.pid });
  const shutdown = () => { held = true; closing = true; persist(); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  let blockedNotice: string | undefined;
  try {
    while (!closing) {
      try {
        await inspect();
        if (snap!.state.startsWith("waiting_")) {
          blockedNotice ??= `omp-wait:${pinned.sessionId}:${snap!.eventSequence}`;
          await service("host-event", { event: { id: blockedNotice, method: "tui/inputRequired", params: { pane: boot.pane, message: "Inspect and answer the actual OMP TUI; no automated approval was sent" } }, runtime: runtime() });
        } else if (blockedNotice) {
          await service("host-event", { event: { method: "tui/inputResolved", params: { requestId: blockedNotice } }, runtime: runtime() }); blockedNotice = undefined;
        }
        await service("host-heartbeat", { runtime: runtime() }); lastAck = Date.now(); }
      catch { if (Date.now() - lastAck >= config.runtime.heartbeatTimeoutMs) { held = true; persist(); await callOmp(pinned, "hold", { origin: "automatic" }, config).catch(() => {}); } }
      await Bun.sleep(config.runtime.heartbeatIntervalMs);
    }
  } finally { if (!nativeStopped) { held = true; persist(); await callOmp(pinned, "hold", { origin: "automatic" }, config).catch(() => {}); } await Bun.sleep(100); server.stop(true); process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); if (existsSync(hostSocket(stateDir, boot.key))) {
      const current = lstatSync(hostSocket(stateDir, boot.key)), owner = readJson<{ pid: number; instance: string }>(ompHostOwnerPath(stateDir, boot.key));
      if (current.dev === boundSocket.dev && current.ino === boundSocket.ino && owner.pid === process.pid && owner.instance === boot.instance) unlinkSync(hostSocket(stateDir, boot.key));
    } }
};
const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
const controllerPid = (dir: string, target: OmpTarget): number | undefined => {
  if (!existsSync(dir)) return undefined;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try { const value = readJson<any>(join(dir, file)); if (sameIdentity(value, target) && Number.isSafeInteger(value.pid) && value.pid > 0) return value.pid; } catch { /* unrelated descriptor */ }
  }
};
