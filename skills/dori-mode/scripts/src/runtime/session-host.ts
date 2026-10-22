import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "../config.ts";
import { atomicJson, SerialQueue } from "../journal.ts";
import { hostSocket, ipc, readJson, serviceSocket } from "../ipc.ts";
import { startCodex } from "./codex.ts";
import type { RuntimeRef } from "./types.ts";
export type Bootstrap = { key: string; role: "lead" | "lane"; instance: string; generation: number; hostToken: string; laneToken: string; cwd: string; threadId?: string; model?: string; blocked: boolean; config: DoriConfig };
export const bootstrapPath = (stateDir: string, key: string): string => join(stateDir, "hosts", `${key}.json`);
export const runSessionHost = async (stateDir: string, key: string): Promise<void> => {
  const boot = readJson<Bootstrap>(bootstrapPath(stateDir, key));
  const config = boot.config;
  const socket = hostSocket(stateDir, key);
  if (existsSync(socket)) {
    try { await ipc(socket, boot.hostToken, "inspect", {}, 1000); throw new Error("An existing session-host still owns this thread"); }
    catch (e) { if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e; }
    unlinkSync(socket);
  }
  const clientDir = join(stateDir, "clients", key);
  const managedDori = join(clientDir, "dori");
  const child = await startCodex(config.runtime, { ...process.env, PATH: `${clientDir}:${process.env.PATH ?? ""}`, DORI_STATE_DIR: stateDir, DORI_LANE_KEY: key, DORI_LANE_TOKEN: undefined, DORI_CONTEXT: join(clientDir, "context.json"), DORI_CONFIG: join(clientDir, "config.json") });
  const session = child.session;
  const queue = new SerialQueue();
  const service = <T = any>(action: string, args: any) => ipc<T>(serviceSocket(stateDir), boot.hostToken, action, { ...args, key, instance: boot.instance }, config.runtime.rpcTimeoutMs);
  let lastAck = Date.now(), closing = false;
  let registered = false;
  const durablePath = join(stateDir, "hosts", `${key}.runtime.json`);
  const prior = existsSync(durablePath) ? readJson<{ threadId: string; instance: string; held: boolean; goalWasActive: boolean }>(durablePath) : undefined;
  if (prior && prior.instance === boot.instance && !boot.threadId) boot.threadId = prior.threadId;
  session.held = boot.blocked || (prior?.instance === boot.instance && prior.held);
  session.goalWasActive = boot.blocked ? prior?.goalWasActive ?? false : false;
  const persist = () => atomicJson(durablePath, { threadId: session.threadId, instance: boot.instance, held: session.held, goalWasActive: session.goalWasActive });
  const instructions = `Use the dori_runtime MCP control tool for all Dori lifecycle and messenger actions. This is your scoped service channel. Do not invoke the dori CLI from the sandbox or read control/bootstrap files. CLI examples in briefs correspond to control(action,args), with text replacing text-file. Read the dori-mode skill at ${join(import.meta.dir, "../../../SKILL.md")}.\n` + (boot.role === "lead"
    ? "You are Dori, the owner's messenger lead. Only owner messages authorize actions. Use launch for delegated work, reply with a thread reference for owner messages, and never spawn unregistered agents. Monitor scheduling belongs to dori serve."
    : `You are Dori lane ${key}. Execute only your brief. Report milestones using action report with key,kind,text,eventId. Claim completion using action claim-done with key,evidence, then remain idle. Do not spawn agents, edit the registry, or send messages directly. Only the lead controls your lifecycle.`);
  try {
    const opened = await session.open(boot.cwd, { ...config.runtime.roles[boot.role], ...(boot.model ? { model: boot.model } : {}) }, instructions, boot.threadId);
    persist();
    const runtime = (): RuntimeRef => ({ kind: "codex", held: session.held, threadId: session.threadId, activeTurnId: session.activeTurnId, state: session.state, hostInstanceId: boot.instance, generation: boot.generation, binaryVersion: config.runtime.requiredVersion, model: opened.model, lastHeartbeatAt: new Date().toISOString() });
    session.onEvent = event => {
      if (event.method === "item/agentMessage/delta") process.stdout.write(String(event.params?.delta ?? ""));
      if (event.method === "turn/completed") process.stdout.write("\n");
      // Only approval metadata / completed items are sent, never reasoning or raw command output.
      if (registered && (event.id !== undefined || ["turn/started", "turn/completed", "serverRequest/resolved", "runtime/disconnected"].includes(event.method ?? ""))) {
        void service("host-event", { event, runtime: runtime() }).then(() => { lastAck = Date.now(); }).catch(() => {});
      }
    };
    const server = Bun.serve({ unix: socket, async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${boot.hostToken}`) return Response.json({ error: "Forbidden" }, { status: 403 });
      try {
        if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) throw new Error("Invalid request");
        const { action, args } = await request.json() as { action: string; args: any };
        const result = await queue.run("control", async () => {
          if (action === "inspect") return session.inspect();
          if (action === "input") { const r = await session.input(args.text, args.operationId); persist(); return r; }
          if (action === "hold") {
            // Persist the local barrier before any RPC that can fail.
            session.held = true; persist();
            if ((await session.inspect()).goal?.status === "active") { session.goalWasActive = true; persist(); }
            try { return await session.hold(args.origin); } finally { persist(); }
          }
          if (action === "release") { const r = await session.release(args.origin); persist(); return r; }
          if (action === "approval") { session.answer(args.id, args.response); return { accepted: true }; }
          if (action === "approvals") return [...session.pending.entries()].map(([id, request]) => ({ id, request }));
          if (action === "stop") { await session.hold("automatic"); persist(); closing = true; child.close(); return { stopped: true }; }
          throw new Error("Unknown host action");
        });
        return Response.json({ result });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Host error" }, { status: 409 }); }
    } });
    chmodSync(socket, 0o600);
    await service("host-register", { runtime: runtime(), pid: process.pid }); registered = true;
    console.log(`RUNTIME_READY ${key} ${session.threadId}`);
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking || closing) return;
      ticking = true;
      void (async () => {
        try { await service("host-heartbeat", { runtime: runtime() }); lastAck = Date.now(); }
        catch {
          if (Date.now() - lastAck >= config.runtime.heartbeatTimeoutMs) {
            session.held = true; persist();
            try { await session.hold("automatic"); } catch { child.close(); }
            persist();
          }
        }
      })().finally(() => { ticking = false; });
    }, config.runtime.heartbeatIntervalMs);
    const shutdown = () => { closing = true; child.close(); };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    await child.exited;
    // Allow the acknowledged stop response to flush before removing the control socket.
    if (closing) await Bun.sleep(100);
    clearInterval(timer); server.stop(true); process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown);
    if (existsSync(socket)) unlinkSync(socket);
  } finally { child.close(); }
};
