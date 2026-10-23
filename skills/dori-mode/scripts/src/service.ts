import { chmodSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { workspaceForRole, type DoriConfig } from "./config.ts";
import { atomicJson, SerialQueue } from "./journal.ts";
import { ipc, serviceSocket, hostSocket, readJson } from "./ipc.ts";
import { Registry, statusOf, withStatus, type Lane, LANE_KEY } from "./registry.ts";
import { claimDone, closeLane, objectDone, watchTick, type FlowDeps } from "./done-flow.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { launchLane, quoteForPane, validateLaunch, LaunchError, type LaunchInput } from "./launch.ts";
import { freshnessTick } from "./freshness.ts";
import { deadPaneTick } from "./dead-panes.ts";
import { syncRegistry } from "./sync.ts";
import { sampleHost, guardTick } from "./host-guard.ts";
import { canLaunch } from "./routing.ts";
import { run, realClock, type Runner } from "./run.ts";
import { backendSocket, bootstrapPath, resolveCodexBinary, type Bootstrap } from "./runtime/session-host.ts";
import type { RuntimeControl, RuntimeRef, RuntimeSnapshot } from "./runtime/types.ts";
import { WorkTimers } from "./work.ts";
import { turnFailure } from "./turn-failure.ts";
import { DeliveryDeferred, Mailbox, postHook } from "./mailbox.ts";
import { ExternalCurrentSession, observeExternal, sharedDaemon, THREAD_UUID, type Attachment } from "./runtime/external-current-session.ts";
import { connectObserver } from "./runtime/observer.ts";

export type Caller = { role: "admin" | "lead" | "lane" | "host"; key?: string; instance?: string };
export class DoriService {
  readonly registry: Registry;
  readonly inbox: Mailbox;
  readonly outbox: Mailbox;
  readonly operations: Mailbox;
  readonly failures: Mailbox;
  readonly deps: FlowDeps;
  private workQueue = new SerialQueue();
  private launchQueue = new SerialQueue();
  private dispatchQueue = new SerialQueue();
  private failureQueue = new SerialQueue();
  private stopping = false;
  private ticks = new Set<string>();
  private lastTick = new Map<string, number>();
  constructor(readonly config: DoriConfig, readonly runner: Runner = run) {
    this.registry = new Registry(config.stateDir); this.registry.enableJournal(config.stateDir);
    this.inbox = new Mailbox(config.stateDir, "inbox"); this.outbox = new Mailbox(config.stateDir, "outbox"); this.operations = new Mailbox(config.stateDir, "operations");
    this.failures = new Mailbox(config.stateDir, "failures");
    const call = async <T>(key: string, action: string, args: any = {}): Promise<T> => {
      const lane = await this.registry.read(key);
      if (!lane?.runtime?.threadId) throw new Error("Runtime is not registered");
      if (lane.runtime.backend === "external-current-session") return this.externalCall(lane, action, args) as Promise<T>;
      if (action === "stop" && lane.runtime.state === "stopped") return undefined as T;
      const boot = readJson<Bootstrap>(bootstrapPath(config.stateDir, key));
      const result = await ipc<T>(hostSocket(config.stateDir, key), boot.hostToken, action, args, config.runtime.rpcTimeoutMs * 3);
      if (action === "stop") await this.registry.update(key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, state: "stopped", activeTurnId: undefined } }));
      return result;
    };
    const runtime: RuntimeControl = {
      inspect: key => call(key, "inspect"),
      input: (key, text, operationId) => this.dispatchQueue.run(key, async () => {
        const lane = await this.registry.read(key);
        if (!lane || lane.dispatchBlocked || statusOf(lane) === "closed") throw new Error("Lane dispatch is blocked");
        const mail = this.inbox.put({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString() });
        if (lane.runtime?.backend === "external-current-session") {
          if (mail.attachmentInstance && mail.attachmentInstance !== lane.runtime.hostInstanceId) throw new DeliveryDeferred("Mail belongs to a previous lead attachment");
          if (this.attachment(lane).excludedInboxIds.includes(mail.id)) throw new DeliveryDeferred("Historical mail is held for explicit reconciliation");
          if (mail.state === "queued" && (await call<RuntimeSnapshot>(key, "inspect")).state !== "idle") throw new DeliveryDeferred("Attached session busy; input remains queued");
        }
        const delivered = await this.inbox.deliver(mail.id, async row => {
          const result = await call<{ turnId: string }>(key, "input", { text: row.text, operationId: row.id });
          if (typeof result?.turnId !== "string" || !result.turnId.trim()) throw new Error("Missing turn receipt");
          return result;
        });
        if (!delivered.turnId) throw new Error("Missing turn receipt");
        return { turnId: delivered.turnId };
      }),
      hold: (key, origin) => call(key, "hold", { origin }), release: (key, origin) => call(key, "release", { origin }), stop: key => call(key, "stop"),
    };
    this.deps = { config, registry: this.registry, clock: realClock, run: runner, runtime, post: (id, hook, values) => postHook(this.outbox, runner, id, hook, values),
      queueInput: async (key, text, operationId) => {
        const lane = await this.lane(key);
        this.inbox.put({ id: operationId, target: key, text, thread: lane.thread, state: "queued", at: new Date().toISOString() });
      } };
  }
  private attachmentPath(): string { return join(this.config.stateDir, "attachments", "lead.json"); }
  private attachment(lane: Lane): Attachment {
    const saved = readJson<Attachment>(this.attachmentPath());
    if (lane.key !== "lead" || lane.runtime?.backend !== "external-current-session" || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped" ||
        saved.instance !== lane.runtime.hostInstanceId || saved.generation !== lane.runtime.generation || saved.threadId !== lane.runtime.threadId || saved.pane !== lane.pane || saved.cwd !== lane.cwd ||
        saved.socketPath !== lane.runtime.external?.socketPath || saved.binary !== lane.runtime.external.binary || saved.bridge !== lane.runtime.external.bridge) throw new Error("Stale or detached lead attachment");
    return saved;
  }
  private async holdExternal(instance: string): Promise<void> {
    await this.registry.update("lead", lane => lane.runtime?.hostInstanceId !== instance || lane.runtime.external?.detachedAt || lane.runtime.state === "stopped" ? lane : ({ ...lane, dispatchBlocked: true, holdReason: "recovery", runtime: { ...lane.runtime, held: true, state: "recovering", activeTurnId: undefined } }));
  }
  private async externalCall(lane: Lane, action: string, args: any): Promise<unknown> {
    if (!["inspect", "input"].includes(action)) throw new Error(`External current-session ${action} is unsupported; use lead-detach`);
    let saved: Attachment;
    try { saved = this.attachment(lane); }
    catch (error) { await this.holdExternal(lane.runtime!.hostInstanceId); throw error; }
    if (action === "input" && lane.dispatchBlocked) throw new DeliveryDeferred("Attached lead dispatch is held");
    let connected = false;
    try {
      return await observeExternal(this.runner, this.config.runtime, saved, async observer => {
        connected = true;
        const session = new ExternalCurrentSession(observer, this.runner, this.config.runtime, saved, saved.binary);
        if (action === "input") return session.input(args.text, args.operationId, () => this.holdExternal(saved.instance));
        const snap = await session.inspect();
        if (snap.state === "failed") await this.holdExternal(saved.instance);
        await this.registry.update(lane.key, current => current.runtime?.hostInstanceId !== saved.instance || current.runtime.external?.detachedAt ? current : ({ ...current,
          model: snap.model, runtime: { ...current.runtime, model: snap.model, effort: snap.effort, state: current.dispatchBlocked ? "recovering" : snap.state, activeTurnId: snap.activeTurnId } }));
        return snap;
      });
    } catch (error) {
      if (!(error instanceof DeliveryDeferred)) await this.holdExternal(saved.instance);
      if (action === "input" && !connected) throw new DeliveryDeferred("Attached observer unavailable before submission; input remains queued");
      throw error;
    }
  }
  private async publicLane(lane: Lane): Promise<any> {
    if (lane.runtime?.backend !== "external-current-session") return lane;
    const attached = !lane.runtime.external?.detachedAt && lane.runtime.state !== "stopped";
    const snap = attached ? await this.externalCall(lane, "inspect", {}).catch(() => null) as RuntimeSnapshot | null : null;
    const current = await this.lane(lane.key);
    const stillAttached = !current.runtime?.external?.detachedAt && current.runtime?.state !== "stopped";
    const identityVerified = Boolean(snap) && stillAttached && current.runtime?.hostInstanceId === lane.runtime.hostInstanceId;
    return { ...current, mode: "external-current-session", bridge: current.runtime?.external?.bridge, identityVerified,
      verifiedIdentity: identityVerified ? { threadId: current.runtime?.threadId, pane: current.pane, cwd: current.cwd, model: current.runtime?.model, effort: current.runtime?.effort } : null,
      readiness: !stillAttached ? "detached" : !identityVerified || current.dispatchBlocked ? "held" : snap?.state === "idle" ? "ready" : "busy" };
  }
  private async attachLead(args: any): Promise<any> {
    if (typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId) || typeof args.pane !== "string" || !args.pane.trim() || typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new Error("lead-attach requires UUID thread-id, pane and absolute cwd");
    const cwd = realpathSync(args.cwd), previous = await this.registry.read("lead");
    const same = previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && previous.runtime.threadId === args.threadId && previous.pane === args.pane && previous.cwd === cwd;
    if (previous?.runtime?.backend === "external-current-session" && !previous.runtime.external?.detachedAt && previous.runtime.state !== "stopped" && !same) throw new Error("A different lead is attached; explicitly detach it first");
    const binary = resolveCodexBinary(this.config.runtime.binary);
    const daemon = await sharedDaemon(this.runner, binary, this.config.runtime);
    const observer = await connectObserver(daemon.socketPath, this.config.runtime.rpcTimeoutMs);
    let snap: Awaited<ReturnType<ExternalCurrentSession["inspect"]>>;
    try {
      snap = await new ExternalCurrentSession(observer, this.runner, this.config.runtime, { threadId: args.threadId, pane: args.pane, cwd }, binary).inspect();
    } finally { observer.close(); }
    if (snap.state === "failed") throw new Error("Current Codex session reports a runtime failure; resolve it before attaching");
    if (same) {
      const saved = this.attachment(previous);
      if (saved.socketPath !== daemon.socketPath || saved.binary !== binary) throw new Error("Attached daemon affinity changed; detach before reattaching");
      await this.registry.update("lead", lane => ({ ...lane, dispatchBlocked: false, holdReason: undefined, runtime: { ...lane.runtime!, held: false, state: snap.state, activeTurnId: snap.activeTurnId } }));
      return { attached: true, bridge: saved.bridge, lead: await this.publicLane(await this.lane("lead")), reused: true };
    }
    if (previous && previous.runtime?.backend !== "external-current-session") {
      await this.assertHostStopped(previous);
      if (existsSync(backendSocket(this.config.stateDir, "lead"))) {
        let oldObserver;
        try { oldObserver = await connectObserver(backendSocket(this.config.stateDir, "lead"), this.config.runtime.rpcTimeoutMs); } catch { /* stale socket; PID and TUI checks above still apply */ }
        if (oldObserver) { oldObserver.close(); throw new Error("Prior lead backend still live; attachment refused"); }
      }
    }
    // Preserve all failed managed intent and credentials as history. Authentication
    // below never considers these old credentials for an external attachment.
    if (previous) {
      const history = join(this.config.stateDir, "attachments", "history", crypto.randomUUID());
      atomicJson(join(history, "lane.json"), previous);
      for (const suffix of [".json", ".runtime.json", ".pid.json", ".backend.json"]) {
        const file = join(this.config.stateDir, "hosts", `lead${suffix}`);
        if (existsSync(file)) writeFileSync(join(history, `lead${suffix}`), readFileSync(file), { mode: 0o600 });
      }
      if (existsSync(this.attachmentPath())) writeFileSync(join(history, "attachment.json"), readFileSync(this.attachmentPath()), { mode: 0o600 });
    }
    const instance = crypto.randomUUID(), generation = (previous?.runtime?.generation ?? 0) + 1;
    const clientDir = resolve(this.config.stateDir, "clients", "attached-lead", instance), bridge = join(clientDir, "iyen");
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    const saved: Attachment = { threadId: args.threadId, pane: args.pane, cwd, model: snap.model, effort: snap.effort, instance, generation, token: crypto.randomUUID(), ...daemon, binary, bridge,
      excludedInboxIds: this.inbox.list().filter(row => row.target === "lead").map(row => row.id) };
    atomicJson(join(clientDir, "context.json"), { token: saved.token, key: "lead", stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    writeFileSync(bridge, `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=lead exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`, { mode: 0o700 });
    const lead: Lane = { key: "lead", title: "Iyen current-session lead", role: "lead", thread: "none", brief: "", done: "", pane: args.pane, cwd, model: snap.model,
      openedAt: new Date().toISOString(), status: "working", dispatchBlocked: false, revision: previous?.revision,
      runtimeHistory: [...(previous?.runtimeHistory ?? []), ...(previous?.runtime ? [previous.runtime] : [])],
      runtime: { kind: "codex", backend: "external-current-session", threadId: args.threadId, state: snap.state, activeTurnId: snap.activeTurnId,
        hostInstanceId: instance, generation, binaryVersion: this.config.runtime.requiredVersion, model: snap.model, effort: snap.effort, external: { ...daemon, binary, bridge } } };
    await this.registry.write(lead);
    // Publish the credential only after the registry commit succeeds. A revision
    // conflict must not revoke a previously valid attachment's capability.
    atomicJson(this.attachmentPath(), saved);
    return { attached: true, bridge, lead: await this.publicLane(await this.lane("lead")) };
  }
  private async lane(key: string): Promise<Lane> { if (!key || !LANE_KEY.test(key)) throw new Error("Invalid lane key"); const lane = await this.registry.read(key); if (!lane) throw new Error("Unknown lane"); return lane; }
  private async assertHostStopped(lane: Lane): Promise<void> {
    const path = bootstrapPath(this.config.stateDir, lane.key);
    if (existsSync(path)) {
      const prior = readJson<Bootstrap>(path);
      try { await ipc(hostSocket(this.config.stateDir, lane.key), prior.hostToken, "inspect", {}, 1000); throw new Error("Host already alive"); }
      catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
    }
    const pidFile = join(this.config.stateDir, "hosts", `${lane.key}.pid.json`);
    if (existsSync(pidFile)) { const { pid } = readJson<{ pid: number }>(pidFile); try { process.kill(pid, 0); throw new Error("Prior host process still exists; refuse second writer"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
    const backend = join(this.config.stateDir, "hosts", `${lane.key}.backend.json`);
    if (existsSync(backend)) {
      const { pid } = readJson<{ pid: number }>(backend);
      try { process.kill(pid, 0); throw new Error("Prior backend process still exists; refuse second writer"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    }
    const live = await this.runner(["herdr", "agent", "list"]);
    if (live.code !== 0) throw new Error("Cannot prove exclusive TUI ownership");
    const agents = JSON.parse(live.out).result.agents as { pane_id: string; agent_session?: { value: string } }[];
    if (agents.some(a => a.pane_id === lane.pane || (lane.runtime?.threadId && a.agent_session?.value === lane.runtime.threadId))) throw new Error("A live TUI already owns this pane or thread");
  }
  async boot(lane: Lane): Promise<void> {
    if (lane.key === "lead" || lane.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
    if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session boot is unsupported; use lead-attach");
    if (!lane.pane) throw new Error("A Herdr pane is required");
    const pane = lane.pane;
    await this.assertHostStopped(lane);
    if (lane.runtime?.threadId && lane.runtime.backend !== "herdr-tui") throw new Error("Legacy private-RPC thread requires explicit recover --new-session --handoff-file; preserve its history");
    const path = bootstrapPath(this.config.stateDir, lane.key);
    if (!lane.runtime?.threadId && existsSync(path)) {
      const prior = readJson<Bootstrap>(path);
      const checkpointPath = join(this.config.stateDir, "hosts", `${lane.key}.runtime.json`);
      const checkpoint = existsSync(checkpointPath) ? readJson<{ instance: string; threadId?: string }>(checkpointPath) : undefined;
      if (!checkpoint?.threadId || checkpoint.instance !== prior.instance) throw new Error("Thread creation outcome unknown; inspect Codex history and recover with --thread-id ID");
      lane = await this.registry.update(lane.key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, threadId: checkpoint.threadId } }));
    }
    const instance = crypto.randomUUID();
    const boot: Bootstrap = { key: lane.key, role: lane.role ?? "lane", pane, instance, generation: (lane.runtime?.generation ?? 0) + 1, hostToken: crypto.randomUUID(), laneToken: crypto.randomUUID(), cwd: lane.cwd ?? this.config.defaultCwd, threadId: lane.runtime?.threadId, model: lane.model, blocked: Boolean(lane.dispatchBlocked), config: this.config };
    atomicJson(path, boot);
    const clientDir = join(this.config.stateDir, "clients", lane.key);
    mkdirSync(clientDir, { recursive: true, mode: 0o700 });
    atomicJson(join(clientDir, "context.json"), { token: boot.laneToken, key: lane.key, stateDir: this.config.stateDir });
    atomicJson(join(clientDir, "config.json"), this.config);
    const wrapper = `#!/bin/sh\nDORI_CONTEXT=${quoteForPane(join(clientDir, "context.json"))} DORI_STATE_DIR=${quoteForPane(this.config.stateDir)} DORI_CONFIG=${quoteForPane(join(clientDir, "config.json"))} DORI_LANE_KEY=${quoteForPane(lane.key)} exec ${quoteForPane(process.execPath)} ${quoteForPane(resolve(import.meta.dir, "cli.ts"))} "$@"\n`;
    writeFileSync(join(clientDir, "dori"), wrapper, { mode: 0o700 });
    await this.registry.update(lane.key, current => ({ ...current, runtime: { kind: "codex", backend: "herdr-tui", threadId: boot.threadId, state: "starting", hostInstanceId: instance, generation: boot.generation, binaryVersion: this.config.runtime.requiredVersion, lastHeartbeatAt: new Date().toISOString() } }));
    const cli = resolve(import.meta.dir, "cli.ts");
    const launched = await this.runner([process.execPath, cli, "session-host-start", "--state-dir", this.config.stateDir, "--key", lane.key]);
    if (launched.code !== 0) throw new Error("Failed to start private backend host; intent retained");
  }
  async authorize(token: string): Promise<Caller> {
    const control = readJson<{ token: string }>(join(this.config.stateDir, "control.json"));
    if (token === control.token) return { role: "admin" };
    for (const lane of await this.registry.open()) {
      if (lane.runtime?.backend === "external-current-session") {
        if (!lane.runtime.external?.detachedAt && lane.runtime.state !== "stopped") {
          let saved: Attachment;
          try { saved = this.attachment(lane); } catch { continue; }
          if (token === saved.token) return { role: "lead", key: lane.key, instance: saved.instance };
        }
        continue;
      }
      if (lane.key === "lead" || lane.role === "lead") continue;
      const path = bootstrapPath(this.config.stateDir, lane.key);
      if (!existsSync(path)) continue;
      const boot = readJson<Bootstrap>(path);
      if (token === boot.hostToken) return { role: "host", key: lane.key };
      if (token === boot.laneToken) return { role: boot.role, key: lane.key };
    }
    throw new Error("Forbidden");
  }
  async handle(action: string, args: any, caller: Caller): Promise<any> {
    if (!args || typeof args !== "object") throw new Error("Expected args object");
    if (this.stopping) throw new Error("Service stopping");
    if (caller.instance) {
      const lead = await this.lane("lead");
      if (caller.role !== "lead" || caller.key !== "lead" || this.attachment(lead).instance !== caller.instance) throw new Error("Stale lead capability");
    }
    if (action === "lead-attach" || action === "lead") {
      if (caller.role !== "admin") throw new Error("lead-attach requires operator capability");
      if (action === "lead" && (!args.threadId || !args.pane || !args.cwd)) throw new Error("Start Iyen in this session with lead-attach --thread-id UUID --pane ID --cwd DIR");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", () => this.attachLead(args)));
    }
    if (action === "lead-detach") {
      if (caller.role !== "admin" && !(caller.role === "lead" && caller.key === "lead" && caller.instance)) throw new Error("lead-detach requires operator or current attached lead capability");
      if (typeof args.threadId !== "string" || !THREAD_UUID.test(args.threadId)) throw new Error("lead-detach requires expected UUID thread-id");
      return this.launchQueue.run("lead", () => this.dispatchQueue.run("lead", async () => {
        const lane = await this.lane("lead");
        if (lane.runtime?.backend !== "external-current-session" || lane.runtime.threadId !== args.threadId || (caller.instance && caller.instance !== lane.runtime.hostInstanceId)) throw new Error("lead-detach expected session mismatch");
        await this.registry.update("lead", current => ({ ...current, dispatchBlocked: true, runtime: { ...current.runtime!, held: true, state: "stopped", activeTurnId: undefined,
          external: { ...current.runtime!.external!, detachedAt: current.runtime!.external?.detachedAt ?? new Date().toISOString() } } }));
        return { detached: true, threadId: args.threadId };
      }));
    }
    if (action.startsWith("host-")) {
      if (caller.role !== "host" || caller.key !== args.key) throw new Error("Forbidden host identity");
      const lane = await this.lane(args.key);
      if (lane.runtime?.backend === "external-current-session") throw new Error("External current-session cannot register a managed host");
      if (!lane.runtime || lane.runtime.hostInstanceId !== args.instance || args.runtime?.hostInstanceId !== args.instance || args.runtime?.generation !== lane.runtime.generation) throw new Error("Stale host generation");
      if (lane.runtime.threadId && lane.runtime.threadId !== args.runtime.threadId) throw new Error("Thread identity mismatch");
      if (!args.runtime.threadId || args.runtime.kind !== "codex") throw new Error("Invalid runtime identity");
      if (action === "host-register") atomicJson(join(this.config.stateDir, "hosts", `${lane.key}.pid.json`), { pid: args.pid, instance: args.instance });
      await this.registry.update(lane.key, l => ({ ...l,
        ...(args.runtime.held && !l.dispatchBlocked ? { dispatchBlocked: true, holdReason: "recovery" as const } : {}),
        runtime: { ...args.runtime as RuntimeRef, lastHeartbeatAt: new Date().toISOString() } }));
      if (action === "host-event" && args.event?.id !== undefined) {
        const id = args.event.method === "tui/inputRequired" ? `${lane.key}:${args.event.id}` : `${args.instance}:${args.event.id}`;
        this.outbox.put({ id: `approval:${id}`, target: lane.thread, text: JSON.stringify({ lane: lane.key, id, method: args.event.method, params: args.event.params }), state: "queued", at: new Date().toISOString() });
        this.inbox.put({ id: `approval-notice:${id}`, target: "lead", text: `Approval or input required for ${lane.key}. Inspect dori approval list. ID: ${id}`, state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "runtime/disconnected" && lane.role !== "lead") {
        this.inbox.put({ id: `runtime-failed:${lane.key}:${args.instance}`, target: "lead", text: `Runtime failed for ${lane.key}. Inspect status and reconcile unknown operations before recover.`, state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "turn/completed" && args.event.params?.turn?.status === "failed") {
        const turnId = args.event.params.turn.id;
        if (typeof turnId !== "string" || !turnId || (args.event.params.threadId && args.event.params.threadId !== lane.runtime.threadId)) throw new Error("Invalid failed turn identity");
        this.failures.put({ id: `failed-turn:${lane.key}:${args.instance}:${turnId}`, target: lane.key, turnId, source: args.instance,
          text: JSON.stringify(turnFailure(args.event.params.turn.error)), state: "queued", at: new Date().toISOString() });
      }
      if (action === "host-event" && args.event?.method === "serverRequest/resolved") {
        const id = `approval:${args.instance}:${args.event.params.requestId}`;
        if (this.outbox.get(id)) this.outbox.mark(id, { state: "sent" });
      }
      if (action === "host-event" && args.event?.method === "tui/inputResolved") {
        const id = `approval:${lane.key}:${args.event.params.requestId}`;
        if (this.outbox.get(id)) this.outbox.mark(id, { state: "sent" });
      }
      return { accepted: true };
    }
    if (caller.role === "host") throw new Error("Host cannot issue user commands");
    const key = args.key ?? caller.key;
    if (caller.role === "lane" && (!(["report", "claim-done", "status"].includes(action)) || key !== caller.key)) throw new Error("Lane capability does not authorize this command");
    if (["pause", "resume", "close", "recover", "reopen", "claim-done", "object-done"].includes(action) && (await this.registry.read(key))?.runtime?.backend === "external-current-session") throw new Error(`External current-session ${action} is unsupported; use lead-detach`);
    if (["work-start", "work-stop", "work-similar"].includes(action)) {
      if (caller.role !== "lead" && caller.role !== "admin") throw new Error("Work timers require lead or operator");
      const timers = new WorkTimers(this.config.stateDir, this.deps.clock);
      const tags = args.tags ?? [];
      if (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== "string")) throw new Error("tags must be strings");
      if (args.title !== undefined && typeof args.title !== "string") throw new Error("title must be a string");
      if (args.thread !== undefined && typeof args.thread !== "string") throw new Error("thread must be a string");
      const workThresholdSec = this.config.workThresholdSec;
      if (action === "work-similar") return { workThresholdSec, matches: await timers.similar(args.title, tags) };
      if (action === "work-start") {
        if (typeof args.title !== "string" || typeof args.operationId !== "string") throw new Error("title and UUID operationId required");
        return this.workQueue.run(args.operationId, async () => ({ workThresholdSec, work: await timers.start(args.title, tags, args.thread, args.operationId) }));
      }
      if (typeof args.id !== "string") throw new Error("work id required");
      return this.workQueue.run(args.id, async () => ({ workThresholdSec, work: await timers.stop(args.id) }));
    }
    if (action === "status") return key ? this.publicLane(await this.lane(key)) : Promise.all((await this.registry.list()).map(lane => this.publicLane(lane)));
    if (action === "can-launch") return canLaunch(await sampleHost(this.runner), this.config.guard);
    if (action === "launch") {
      if (key === "lead" || args.role === "lead") throw new Error("Iyen lead must attach to the current session; use lead-attach");
      const id = args.operationId;
      if (!id || typeof id !== "string") throw new Error("operationId required");
      return this.launchQueue.run(key, async () => {
        if ((await this.registry.read(key))?.runtime?.backend === "external-current-session") throw new Error("Attached lead cannot be launched; use lead-attach");
        const mail = this.operations.put({ id, target: key, text: JSON.stringify(args), state: "queued", at: new Date().toISOString() });
        if (mail.state === "sent") return { lane: await this.lane(key), startup: `STARTUP_OK ${key} (recorded)` };
        if (mail.state !== "queued") throw new Error("Launch outcome unknown; inspect status, do not replay");
        this.operations.mark(id, { state: "sending" });
        try {
          const result = await launchLane(this.deps, args as LaunchInput, l => this.boot(l));
          this.operations.mark(id, { state: result.startup.startsWith("STARTUP_OK") ? "sent" : "unknown" }); return result;
        } catch (error) {
          if (error instanceof LaunchError && error.exitCode === 4) { this.operations.mark(id, { state: "queued" }); return { held: true, reasons: error.message, code: 4 }; }
          this.operations.mark(id, { state: "unknown" }); throw error;
        }
      });
    }
    if (action === "adopt") {
      if (!args.threadId || args.transferConfirmed !== true) throw new Error("adopt requires thread-id and confirmed exclusive ownership transfer");
      await validateLaunch(this.deps, args);
      const lane: Lane = { key, title: args.title, thread: args.thread ?? "none", brief: args.brief, done: args.done, pane: args.pane, cwd: args.cwd ?? this.config.defaultCwd, role: "lane", openedAt: new Date().toISOString(), status: "paused", pausedFrom: "working", dispatchBlocked: true, holdReason: "owner-pause", runtime: { kind: "codex", threadId: args.threadId, hostInstanceId: "", generation: 0, state: "stopped", binaryVersion: this.config.runtime.requiredVersion } };
      await this.registry.write(lane); await this.boot((await this.lane(key))); return this.lane(key);
    }
    if (action === "pause") return pauseLane(this.deps, await this.lane(key), args.note ?? "Owner requested pause");
    if (action === "resume") return resumeLane(this.deps, await this.lane(key), args.note ?? "Owner requested resume");
    if (action === "claim-done") {
      if (!args.evidence?.trim()) throw new Error("Evidence required");
      return claimDone(this.deps, await this.lane(key), args.evidence);
    }
    if (action === "object-done") {
      if (!Array.isArray(args.reasons) || !args.reasons.length) throw new Error("Reasons required");
      return objectDone(this.deps, await this.lane(key), args.reasons);
    }
    if (action === "close") return closeLane(this.deps, await this.lane(key), args.note ?? "Closed by lead");
    if (action === "input") {
      if (!args.text || !args.operationId) throw new Error("text and operationId required");
      const lane = await this.lane(key);
      const mail = this.inbox.put({ id: args.operationId, target: key, text: args.text, thread: args.thread ?? lane.thread, state: "queued", at: new Date().toISOString(),
        attachmentInstance: lane.runtime?.backend === "external-current-session" ? caller.instance ?? lane.runtime.hostInstanceId : undefined });
      if (mail.state === "unknown" || mail.state === "sending") throw new Error("Delivery unknown; reconcile before retry");
      if (mail.state === "sent") {
        if (!mail.turnId) throw new Error("Missing turn receipt");
        return { turnId: mail.turnId };
      }
      if (lane.dispatchBlocked) return { queued: true, operationId: mail.id };
      if (lane.runtime?.backend === "external-current-session") {
        try { return await this.deps.runtime.input(key, args.text, args.operationId); }
        catch (error) { if (error instanceof DeliveryDeferred) return { queued: true, operationId: mail.id }; throw error; }
      }
      return this.deps.runtime.input(key, args.text, args.operationId);
    }
    if (action === "report") {
      if (!["milestone", "blocker", "question", "done"].includes(args.kind) || !args.text || !args.eventId) throw new Error("Invalid report");
      const id = `report:${key}:${args.eventId}`;
      const report = this.inbox.put({ id, target: "lead", text: `[REPORT] ${key} | ${args.kind} | ${args.text}`, state: "queued", at: new Date().toISOString() });
      await this.registry.update(key, l => ({ ...l, report: { id: args.eventId, kind: args.kind, text: args.text, at: Date.parse(report.at) } }));
      const lane = await this.lane(key);
      if (this.config.hooks.threadReply && lane.thread !== "none") {
        await this.deps.post!(id, this.config.hooks.threadReply, { key, thread: lane.thread, text: args.text });
        await this.registry.update(key, l => ({ ...l, lastReplyAt: Date.now(), lastPostedReport: args.eventId }));
      }
      return { recorded: true };
    }
    if (action === "reply") {
      if (!args.thread || !args.text || !args.operationId || !this.config.hooks.threadReply) throw new Error("thread, text, operationId and threadReply hook required");
      await this.deps.post!(args.operationId, this.config.hooks.threadReply, { key: key ?? "lead", thread: args.thread, text: args.text }); return { sent: true };
    }
    if (action === "sync") return syncRegistry(this.deps, Boolean(args.write));
    if (action === "approval-list") return this.approvals();
    if (action === "approval-respond") {
      if (caller.role !== "admin") throw new Error("Approval requires the authenticated owner control channel");
      const approvals = await this.approvals(); const selected = approvals.find(a => a.id === args.id);
      if (!selected) throw new Error("Expired approval");
      const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, selected.key));
      return ipc(hostSocket(this.config.stateDir, selected.key), boot.hostToken, "approval", { id: selected.requestId, response: args.response });
    }
    if (action === "mail-list") return { inbox: this.inbox.list(), outbox: this.outbox.list(), operations: this.operations.list(), failures: this.failures.list() };
    if (action === "mail-resolve") {
      if (caller.role !== "admin" || !["sent", "queued"].includes(args.state) || !args.evidence) throw new Error("Explicit reconciliation evidence required");
      const box = args.box === "inbox" ? this.inbox : args.box === "outbox" ? this.outbox : undefined;
      if (!box || box.get(args.id)?.state !== "unknown") throw new Error("Only unknown mail can be reconciled");
      return box.mark(args.id, { state: args.state, source: `reconciled: ${args.evidence}` });
    }
    if (action === "reopen" || action === "recover") {
      if (key === "lead" || (await this.registry.read(key))?.role === "lead") throw new Error("Managed lead recovery is unsupported; use lead-attach for the current session");
      return this.launchQueue.run(key, async () => {
        let lane = await this.lane(key);
        if (action === "reopen" && statusOf(lane) !== "closed") throw new Error("Lane is not closed");
        if (action === "recover" && statusOf(lane) === "closed") throw new Error("Use reopen for closed lanes");
        await this.assertHostStopped(lane);
        if (args.newSession) {
          if (caller.role !== "admin" || typeof args.handoff !== "string" || !args.handoff.trim() || !lane.runtime?.threadId) throw new Error("New-session migration requires operator, known old thread and explicit handoff");
          const archive = join(this.config.stateDir, "hosts", "history", `${key}-${lane.runtime.generation}-${lane.runtime.threadId}`);
          mkdirSync(archive, { recursive: true, mode: 0o700 });
          for (const suffix of [".json", ".runtime.json", ".pid.json", ".backend.json"]) {
            const file = join(this.config.stateDir, "hosts", `${key}${suffix}`);
            if (existsSync(file)) { writeFileSync(join(archive, `${key}${suffix}`), readFileSync(file), { mode: 0o600 }); unlinkSync(file); }
          }
          writeFileSync(join(archive, "handoff.md"), args.handoff, { mode: 0o600 });
          lane = await this.registry.update(key, l => ({ ...l, runtimeHistory: [...(l.runtimeHistory ?? []), l.runtime!], runtime: { ...l.runtime!, backend: "herdr-tui", threadId: undefined, activeTurnId: undefined, state: "stopped" }, dispatchBlocked: true, holdReason: "recovery" }));
          args.text = `Runtime migration from preserved thread ${lane.runtimeHistory!.at(-1)!.threadId}. History and handoff: ${archive}.\n${args.handoff}\nReconcile uncertain side effects; do not replay old tasks.`;
        }
        if (args.threadId) {
          if (lane.runtime?.threadId && lane.runtime.threadId !== args.threadId) throw new Error("Refusing to replace a known thread identity");
          lane = await this.registry.update(key, l => ({ ...l, runtime: l.runtime && { ...l.runtime, threadId: args.threadId } }));
        }
        if (action === "recover") lane = await this.registry.update(key, l => ({ ...l, dispatchBlocked: true, holdReason: l.holdReason ?? "recovery" }));
        if (lane.cwd && !existsSync(lane.cwd)) {
          const saved = lane.resumeRefs?.[lane.cwd];
          if (!saved || !lane.repository || !lane.worktrees?.includes(lane.cwd)) throw new Error("Missing cwd has no owned resume point; restore it before reopening");
          const branchExists = saved.branch ? await this.runner(["git", "-C", lane.repository, "show-ref", "--verify", `refs/heads/${saved.branch}`]) : null;
          const argv = branchExists?.code === 0 ? ["git", "-C", lane.repository, "worktree", "add", lane.cwd, saved.branch!] : ["git", "-C", lane.repository, "worktree", "add", "-b", `dori/${key}-cycle-${(lane.cycle ?? 1) + 1}`, lane.cwd, saved.sha];
          if ((await this.runner(argv)).code !== 0) throw new Error("Cannot restore owned worktree; inspect repository");
        }
        if (action === "reopen") lane = await this.registry.update(key, l => withStatus(l, "working", "Reopened", new Date().toISOString(), { cycle: (l.cycle ?? 1) + 1, closedAt: undefined, claim: undefined, objection: undefined, cleanupFence: undefined, dispatchBlocked: false, holdReason: undefined }));
        const workspace = workspaceForRole(this.config, lane.role);
        const created = await this.runner(["herdr", "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", lane.cwd ?? this.config.defaultCwd, "--label", key, "--no-focus"]);
        if (created.code !== 0) throw new Error("Cannot create recovery tab");
        const made = JSON.parse(created.out).result;
        lane = await this.registry.update(key, l => ({ ...l, pane: made.root_pane.pane_id, tab: made.tab_id ?? made.root_pane.tab_id }));
        await this.boot(lane);
        const text = args.text ?? (!lane.runtime?.threadId ? await Bun.file(lane.brief).text() : undefined);
        if (text) this.inbox.put({ id: args.operationId ?? `handoff:${key}:${lane.cycle ?? 1}`, target: key, text, state: "queued", at: new Date().toISOString() });
        return { recovering: true, key };
      });
    }
    if (action === "tick") { await this.tick(); return { accepted: true }; }
    throw new Error(`Unknown service action: ${action}`);
  }
  async approvals(): Promise<{ id: string; key: string; requestId: string; request: unknown }[]> {
    const result: { id: string; key: string; requestId: string; request: unknown }[] = [];
    for (const lane of await this.registry.open()) {
      if (!lane.runtime?.threadId || lane.runtime.backend === "external-current-session") continue;
      try {
        const boot = readJson<Bootstrap>(bootstrapPath(this.config.stateDir, lane.key));
        const requests = await ipc<{ id: string; request: unknown }[]>(hostSocket(this.config.stateDir, lane.key), boot.hostToken, "approvals", {}, 1000);
        result.push(...requests.map(r => ({ id: `${boot.instance}:${r.id}`, key: lane.key, requestId: r.id, request: r.request })));
      } catch { /* disconnected requests cannot be answered */ }
    }
    return result;
  }
  async notifyFailures(): Promise<void> {
    for (const failure of this.failures.list().filter(row => row.state === "queued")) {
      await this.failureQueue.run(failure.id, async () => {
        if (this.failures.get(failure.id)?.state !== "queued") return;
        const lane = await this.lane(failure.target);
        const metadata = JSON.parse(failure.text) as ReturnType<typeof turnFailure>;
        const text = `Codex task failed (${metadata.category}). ${metadata.guidance} The task was not automatically retried.`;
        if (lane.role !== "lead") {
          this.inbox.put({ id: `notice:${failure.id}`, target: "lead", thread: lane.thread, text: `Lane ${lane.key}: ${text}`, state: "queued", at: failure.at });
        } else {
          // Completion notifications can precede the input RPC receipt. Keep the failure
          // pending until a sent receipt associates that turn with its owner thread.
          const threads = [...new Set(this.inbox.list().filter(row => row.target === lane.key && row.state === "sent" && row.turnId === failure.turnId).map(row => row.thread).filter((thread): thread is string => Boolean(thread && thread !== "none")))];
          if (!threads.length) return;
          for (const thread of threads) {
            const id = `notice:${failure.id}:${thread}`;
            this.outbox.put({ id, target: thread, text, state: "queued", at: failure.at });
            if (this.config.hooks.threadReply) {
              // postHook preserves unknown outcomes and never blindly replays them.
              try { await this.deps.post!(id, this.config.hooks.threadReply, { key: lane.key, thread, text }); } catch { /* visible in outbox */ }
            }
          }
        }
        this.failures.mark(failure.id, { state: "sent" });
      });
    }
  }
  async receive(source: string, event: any): Promise<void> {
    const ingress = this.config.ingress.find(i => i.id === source);
    if (!ingress || !ingress.owners.includes(event.user) || !event.id || !event.thread || typeof event.text !== "string") throw new Error("Untrusted or incomplete inbound event");
    const id = `inbound:${source}:${event.thread}:${event.id}`;
    const known = (await this.registry.list()).find(l => l.thread === event.thread && l.role !== "lead");
    if (event.control) {
      const allowed = ["pause", "resume", "object-done", "approval-respond"];
      if (!allowed.includes(event.control.action)) throw new Error("Unsupported inbound control");
      if (event.control.action === "approval-respond") {
        const request = (await this.approvals()).find(a => a.id === event.control.args?.id);
        if (!request || (await this.lane(request.key)).thread !== event.thread) throw new Error("Approval belongs to another thread");
      } else if (!known || event.control.args?.key !== known.key) throw new Error("Control belongs to another lane");
      this.inbox.put({ id, target: "owner-control", text: JSON.stringify(event.control), source, thread: event.thread, state: "queued", at: new Date().toISOString() });
      await this.inbox.deliver(id, async () => { await this.handle(event.control.action, event.control.args, { role: "admin" }); return {}; });
      return;
    }
    const target = known && statusOf(known) !== "closed" ? known.key : "lead";
    this.inbox.put({ id, target, thread: event.thread, text: `Owner message in ${event.thread}${known && statusOf(known) === "closed" ? ` (closed lane ${known.key}; reopen if appropriate)` : ""}:\n${event.text}`, source, state: "queued", at: new Date().toISOString() });
    if (this.config.hooks.threadReply) await this.deps.post!(`ack:${id}`, this.config.hooks.threadReply, { key: target, thread: event.thread, text: "Received. I’ll check the request and continue here." }).catch(() => { /* inbox acceptance does not depend on outbound delivery */ });
  }
  async tick(): Promise<void> {
    const once = async (name: string, fn: () => Promise<unknown>) => {
      const interval = name === "inbox" || name === "failures" ? 1000 : name === "done" ? 30000 : name === "launch-queue" ? 10000 : 60000;
      if (this.ticks.has(name) || Date.now() - (this.lastTick.get(name) ?? 0) < interval) return;
      this.lastTick.set(name, Date.now()); this.ticks.add(name);
      try { await fn(); } catch { console.error(`MONITOR_ERROR ${name}`); } finally { this.ticks.delete(name); }
    };
    await Promise.all([
      once("failures", () => this.notifyFailures()),
      once("done", () => watchTick(this.deps).then(lines => lines.forEach(l => console.log(l)))),
      once("freshness", () => freshnessTick(this.deps, process.env.HOME ?? "")),
      once("runtime-health", async () => {
        for (const lane of await this.registry.open()) {
          if (!lane.runtime || lane.runtime.state === "stopped" || lane.cleanupFence) continue;
          if (lane.runtime.backend === "external-current-session") { await this.externalCall(lane, "inspect", {}).catch(() => {}); continue; }
          const age = Date.now() - Date.parse(lane.runtime.lastHeartbeatAt ?? lane.openedAt);
          if (age <= this.config.runtime.heartbeatTimeoutMs || lane.holdReason === "recovery") continue;
          await this.registry.update(lane.key, l => ({ ...l, dispatchBlocked: true, holdReason: l.holdReason ?? "recovery", runtime: l.runtime && { ...l.runtime, state: "recovering" } }));
          if (lane.role !== "lead") this.inbox.put({ id: `host-unreachable:${lane.key}:${lane.runtime.hostInstanceId}`, target: "lead", text: `Host unreachable for ${lane.key}; dispatch held. Reconcile before recovery.`, state: "queued", at: new Date().toISOString() });
        }
      }),
      once("launch-queue", async () => {
        for (const row of this.operations.list().filter(r => r.state === "queued")) {
          const args = JSON.parse(row.text);
          if (row.target === "lead" || args.role === "lead") continue;
          if ((await this.registry.read(row.target))?.runtime?.backend === "external-current-session") continue;
          if (args.operationId) await this.handle("launch", args, { role: "admin" }).catch(() => {});
        }
      }),
      once("inbox", async () => {
        for (const row of this.inbox.list().filter(r => r.state === "queued")) {
          const lane = await this.registry.read(row.target);
          if (!lane || lane.dispatchBlocked || statusOf(lane) === "closed") continue;
          if (lane.runtime?.backend === "external-current-session" && row.attachmentInstance && row.attachmentInstance !== lane.runtime.hostInstanceId) continue;
          if (lane.runtime?.backend === "external-current-session" && this.attachment(lane).excludedInboxIds.includes(row.id)) continue;
          const snapshot = await this.deps.runtime.inspect(lane.key).catch(() => null);
          if (!snapshot || !["idle", "running"].includes(snapshot.state)) continue;
          if (lane.runtime?.backend === "external-current-session" && snapshot.state !== "idle") continue;
          await this.deps.runtime.input(lane.key, row.text, row.id).catch(() => {});
        }
      }),
    ]);
  }
  stop(): void { this.stopping = true; }
}

export const serve = async (config: DoriConfig): Promise<void> => {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); chmodSync(config.stateDir, 0o700);
  const socket = serviceSocket(config.stateDir), lockPath = join(config.stateDir, "service.lock");
  if (existsSync(lockPath)) {
    const old = readJson<{ pid: number }>(lockPath);
    try { process.kill(old.pid, 0); throw new Error("Dori service owner still exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    unlinkSync(lockPath);
  }
  const instance = crypto.randomUUID(); const fd = openSync(lockPath, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, instance })); closeSync(fd);
  const controlPath = join(config.stateDir, "control.json");
  if (!existsSync(controlPath)) atomicJson(controlPath, { token: crypto.randomUUID() });
  if (existsSync(socket)) unlinkSync(socket);
  const service = new DoriService(config);
  for (const lane of await service.registry.open()) if (lane.runtime?.backend === "external-current-session" && lane.runtime.state !== "stopped") await service.deps.runtime.inspect(lane.key).catch(() => {});
  const server = Bun.serve({ unix: socket, async fetch(request) {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) return new Response(null, { status: 413 });
      const caller = await service.authorize((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      const { action, args } = await request.json() as { action: string; args: any };
      return Response.json({ result: await service.handle(action, args, caller) });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Service request failed" }, { status: 409 }); }
  } });
  chmodSync(socket, 0o600);
  let stopping = false;
  const timer = setInterval(() => { void service.tick(); }, 1000);
  const guard = { alerting: false }; let guardBusy = false;
  const monitor = setInterval(() => {
    if (guardBusy) return; guardBusy = true;
    void Promise.all([sampleHost(run).then(s => guardTick(s, config.guard, guard).forEach(console.log)), deadPaneTick(run, config, service.registry).then(lines => lines.forEach(console.log))]).catch(() => console.error("MONITOR_ERROR host")).finally(() => { guardBusy = false; });
  }, 60000);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  for (const ingress of config.ingress) {
    void (async () => {
      for (let attempt = 0; !stopping && attempt < 5; attempt++) {
        let producer: ReturnType<typeof Bun.spawn> | undefined;
        try {
          const child = Bun.spawn(ingress.command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" }); children.push(child); producer = child;
          const reader = child.stdout as ReadableStream<Uint8Array>; const decoder = new TextDecoder(); let pending = "";
          for await (const chunk of reader) {
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > 1024 * 1024) throw new Error("Ingress frame too large");
            while (pending.includes("\n")) { const at = pending.indexOf("\n"), line = pending.slice(0, at); pending = pending.slice(at + 1); if (line.trim()) { const event = JSON.parse(line); await service.receive(ingress.id, event); (child.stdin as Bun.FileSink).write(JSON.stringify({ ack: event.id, thread: event.thread }) + "\n"); (child.stdin as Bun.FileSink).flush(); } }
          }
          await child.exited;
        } catch { console.error(`INGRESS_ERROR ${ingress.id}`); }
        finally { producer?.kill(); }
        if (!stopping) await Bun.sleep(1000 * 2 ** attempt);
      }
      if (!stopping) console.error(`INGRESS_STOPPED ${ingress.id}; restart service after fixing adapter`);
    })();
  }
  console.log("DORI_SERVICE_READY");
  await new Promise<void>(resolveStop => {
    const stop = () => { stopping = true; resolveStop(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  clearInterval(timer); clearInterval(monitor);
  for (const child of children) child.kill();
  for (const lane of await service.registry.open()) if (lane.runtime?.backend !== "external-current-session") await service.deps.runtime.hold(lane.key, "automatic").catch(() => {});
  service.stop(); server.stop(true);
  if (existsSync(socket)) unlinkSync(socket);
  if (readJson<{ instance: string }>(lockPath).instance === instance) unlinkSync(lockPath);
};
