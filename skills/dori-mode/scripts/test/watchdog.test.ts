import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { socketDir } from "../src/ipc.ts";
import { DoriService } from "../src/service.ts";
import { DeliveryWatchdog, acquireWatchdog, readWatchTarget, watchdogStatus } from "../src/watchdog.ts";
import { acquireFileFence, withBindingFence } from "../src/binding-fence.ts";
import { withState } from "./fakes.ts";
import type { Runner } from "../src/run.ts";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
async function fixture() {
  const state = withState(), socketPath = join(socketDir(state.dir), "watch-test.sock");
  let now = Date.now(), available = true, accept = true, queueThrow = false, threadReads = 0;
  let onRead: (() => void) | undefined, onQueue: (() => Promise<void>) | undefined;
  const commands: string[][] = [], turns: any[] = [];
  const thread: any = { id, cwd: state.dir, status: { type: "idle" } }, agent: any = { agent: "codex", pane_id: "w:p1", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: id } };
  let goal: any = null, loaded = true, daemonSocket = socketPath;
  const server = Bun.serve({ unix: socketPath, fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
    const m = JSON.parse(String(raw)); if (m.id === undefined) return;
    if (m.method === "thread/read") { threadReads++; onRead?.(); }
    const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread } : m.method === "thread/loaded/list" ? { data: loaded ? [id] : [], nextCursor: null } : m.method === "thread/goal/get" ? { goal } : m.method === "thread/turns/list" ? { data: turns, nextCursor: null } : null;
    ws.send(JSON.stringify({ id: m.id, result }));
  } } });
  const runner: Runner = async argv => {
    commands.push([...argv]);
    if (argv[0] === "herdr" && argv[2] === "get") return { code: 0, out: JSON.stringify({ result: { agent } }), err: "" };
    if (argv[1] === "app-server") return { code: 0, out: JSON.stringify({ status: "running", cliVersion: "0.166.0", appServerVersion: "0.166.0", socketPath: daemonSocket }), err: "" };
    if (argv[1] === "queue" && argv[2] === "--help") return { code: 0, out: "queue --thread UUID --message TEXT", err: "" };
    if (argv[1] === "queue") {
      expect(watchdogStatus(state.dir).incidents.at(-1)?.notification).toBe("unknown");
      await onQueue?.();
      if (accept) turns.push({ id: `receipt-${turns.length}`, status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: argv[5] }] }] });
      if (queueThrow) throw new Error("Bearer secret token private DM");
      return { code: 0, out: "queued", err: "" };
    }
    throw new Error("Forbidden command");
  };
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, runtime: { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 100 } };
  const service = new DoriService(config, runner);
  await service.handle("lead-attach", { threadId: id, pane: "w:p1", cwd: state.dir }, { role: "admin" });
  const opts = { timeoutMs: 100, graceMs: 0, recoveryGraceMs: 0, overdueMs: 1000, now: () => now, runner, health: async () => { if (!available) throw new Error("secret"); return service.health(); } };
  const watchdog = () => new DeliveryWatchdog(config, opts);
  const queues = () => commands.filter(c => c[1] === "queue" && c[2] !== "--help");
  cleanups.push(() => { service.stop(); server.stop(true); state.done(); });
  return { state, config, service, watchdog, opts, commands, queues, thread, agent, turns,
    advance: (ms: number) => now += ms, unavailable: () => available = false, available: () => available = true,
    noReceipt: () => accept = false, uncertain: () => queueThrow = true,
    socket: (s: string) => daemonSocket = s, loaded: (b: boolean) => loaded = b, goal: (g: any) => goal = g,
    onRead: (fn?: () => void) => { onRead = fn; threadReads = 0; }, reads: () => threadReads,
    onQueue: (fn: () => Promise<void>) => onQueue = fn,
    hold: () => service.registry.update("lead", l => ({ ...l, dispatchBlocked: true, holdReason: "recovery", runtime: { ...l.runtime!, held: true, state: "recovering", external: { ...l.runtime!.external!, latestHoldReason: { code: "identity-unverified", message: "safe", at: new Date().toISOString(), evidence: { check: "herdr-association", expected: { threadId: id, pane: "w:p1" }, observed: { threadId: other, pane: "w:p1", token: "private" } } } } } })),
    mail: (mailId: string, patch: Record<string, any> = {}) => { const a = readWatchTarget(state.dir)!.attachment; service.inbox.put({ id: mailId, target: "lead", text: "private DM Bearer secret", state: "queued", at: new Date(now - 5000).toISOString(), attachmentInstance: a.instance, ...patch }); },
  };
}

test("dead service records sanitized evidence and independently queues exact bound UUID once despite wrong Herdr mapping", async () => {
  const h = await fixture(); await h.hold(); h.agent.agent_session.value = other; h.unavailable();
  const result = await h.watchdog().poll();
  expect(result.incidents[0]).toMatchObject({ notification: "sent", reasons: ["service-unavailable", "attachment-held"], firstEvidence: { identity: { observed: { threadId: other } } } });
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(1);
  expect(h.queues()[0]!.slice(1, 5)).toEqual(["queue", "--thread", id, "--message"]);
  expect(h.commands.some(c => c.includes("--resume") || c[2] === "prompt")).toBe(false);
  expect(readFileSync(join(h.state.dir, "watchdog/state.json"), "utf8")).not.toMatch(/private DM|Bearer|secret|"token"/);
});

test("failed observer identity retains incident; resolved incident notifies once original identity returns", async () => {
  const h = await fixture(); await h.hold(); h.thread.id = other;
  expect((await h.watchdog().poll()).incidents[0]?.notification).toBe("pending"); expect(h.queues()).toHaveLength(0);
  h.thread.id = id; await h.service.registry.update("lead", l => ({ ...l, dispatchBlocked: false, holdReason: undefined, runtime: { ...l.runtime!, held: false, state: "idle" } }));
  const recovered = await h.watchdog().poll();
  expect(recovered.incidents[0]).toMatchObject({ notification: "sent", resolvedAt: expect.any(Number), firstEvidence: { deliveryHeld: true } });
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(1);
});

test("second observer preflight rejection stays pending then retries once", async () => {
  const h = await fixture(); h.unavailable();
  h.onRead(() => { if (h.reads() === 2) h.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] }; });
  expect((await h.watchdog().poll()).incidents[0]?.notification).toBe("pending"); expect(h.queues()).toHaveLength(0);
  h.onRead(); h.thread.status = { type: "idle" }; await h.watchdog().poll(); expect(h.queues()).toHaveLength(1);
});

test("uncertain send never replays across restart/recovery and late receipt reconciles original marker", async () => {
  const h = await fixture(); h.unavailable(); h.noReceipt(); h.uncertain();
  const first = await h.watchdog().poll(); expect(first.incidents[0]?.notification).toBe("unknown");
  await h.watchdog().poll(); h.available(); await h.watchdog().poll(); expect(h.queues()).toHaveLength(1);
  h.turns.push({ id: "late", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: h.queues()[0]![5] }] }] });
  expect((await h.watchdog().poll()).incidents[0]?.notification).toBe("sent"); expect(h.queues()).toHaveLength(1);
});

for (const gate of ["pause", "done", "approval", "input", "handoff", "rebind", "unloaded", "socket", "goal"] as const) test(`notification respects ${gate} gate`, async () => {
  const h = await fixture(); h.unavailable();
  if (gate === "pause" || gate === "done") await h.service.registry.update("lead", l => ({ ...l, status: gate === "pause" ? "paused" : "done-claimed", holdReason: gate === "pause" ? "owner-pause" : "done-review" }));
  if (gate === "approval" || gate === "input") h.thread.status = { type: "active", activeFlags: [gate === "approval" ? "waitingOnApproval" : "waitingOnUserInput"] };
  if (gate === "handoff") atomicJson(join(h.state.dir, "attachments/handoff.json"), { operationId: "pending" });
  if (gate === "rebind") await h.service.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, external: { ...l.runtime!.external!, rebind: { binary: "x", binaryVersion: "0.166.0" } } } }));
  if (gate === "unloaded") h.loaded(false);
  if (gate === "socket") h.socket("/wrong/socket");
  if (gate === "goal") h.goal({ status: "paused", objective: "private", tokenBudget: null });
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(0); expect(watchdogStatus(h.state.dir).incidents[0]?.notification).toBe("pending");
});

test("long running session alone is healthy but eligible overdue mail is detected; historical/excluded mail ignored", async () => {
  const h = await fixture(); h.thread.status = { type: "active", activeFlags: [] }; h.turns.push({ id: "busy", status: "inProgress", items: [] });
  await h.service.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, state: "running", activeTurnId: "busy" } }));
  h.mail("old-generation", { attachmentInstance: "old" }); h.mail("historical", { attachmentInstance: undefined });
  h.mail("excluded"); const path = join(h.state.dir, "attachments/lead.json"), a = JSON.parse(readFileSync(path, "utf8")); atomicJson(path, { ...a, excludedInboxIds: ["excluded"] });
  expect((await h.watchdog().poll()).incidents).toHaveLength(0);
  h.mail("eligible"); const result = await h.watchdog().poll(); expect(result.incidents[0]).toMatchObject({ reasons: ["mail-overdue"], evidence: { overdue: { queued: 1 } }, notification: "sent" });
});

test("new generation gets a distinct incident without replaying an uncertain old notification", async () => {
  const h = await fixture(); h.unavailable(); h.noReceipt(); await h.watchdog().poll();
  const path = join(h.state.dir, "attachments/lead.json"), a = JSON.parse(readFileSync(path, "utf8")), instance = crypto.randomUUID(); atomicJson(path, { ...a, generation: 2, instance });
  await h.service.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, hostInstanceId: instance, generation: 2 } }));
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(2);
  const incidents = watchdogStatus(h.state.dir).incidents;
  expect(incidents).toHaveLength(2);
  expect(incidents[0]).toMatchObject({ notification: "unknown", supersededAt: expect.any(Number), binding: { instance: a.instance, generation: 1 } });
  expect(incidents[1]).toMatchObject({ notification: "unknown", binding: { instance, generation: 2 } });
  expect(incidents[1]!.id).not.toBe(incidents[0]!.id);
  expect(h.queues()[1]![5]).not.toBe(h.queues()[0]![5]);
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(2);
});

test("authoritative newer WAL pause beats stale lane snapshot; partial WAL fails closed without mutation", async () => {
  const h = await fixture(); const lanePath = join(h.state.dir, "lanes/lead.json"), old = readFileSync(lanePath, "utf8");
  await h.service.registry.update("lead", l => ({ ...l, status: "paused", holdReason: "owner-pause" })); writeFileSync(lanePath, old);
  expect(readWatchTarget(h.state.dir)?.deliberateHold).toBe(true);
  const log = join(h.state.dir, "journal/events.jsonl"), before = readFileSync(log, "utf8") + "{"; writeFileSync(log, before);
  expect(readWatchTarget(h.state.dir)).toBeNull(); expect(readFileSync(log, "utf8")).toBe(before);
});

test("health deadline bounded; ingress failure detected with empty inbox", async () => {
  const h = await fixture(); const started = Date.now();
  await new DeliveryWatchdog(h.config, { ...h.opts, timeoutMs: 20, health: () => new Promise(() => {}), observe: async () => { throw new Error(); } }).poll();
  expect(Date.now() - started).toBeLessThan(200);
  const h2 = await fixture(); h2.opts.health = async () => ({ serviceReachable: true, phase: "ready", ingress: [{ process: "failed" }] });
  expect((await h2.watchdog().poll()).incidents[0]?.reasons).toEqual(["ingress-failed"]);
});

test("shared fence serializes service detach with queue submission and releases before receipt wait", async () => {
  const h = await fixture(); h.unavailable(); h.noReceipt();
  let detached = false, detach: Promise<unknown> | undefined;
  h.onQueue(async () => {
    detach = h.service.handle("lead-detach", { threadId: id }, { role: "admin" }).then(() => { detached = true; });
    await Bun.sleep(30); expect(detached).toBe(false);
  });
  await h.watchdog().poll(); await detach;
  expect(detached).toBe(true); expect(h.queues()).toHaveLength(1); expect(readWatchTarget(h.state.dir)).toBeNull();
});

test("kernel singleton, nested fence, cancellation and owner crash are recoverable", async () => {
  const state = withState(); cleanups.push(state.done);
  const release = await acquireWatchdog(state.dir); await expect(acquireWatchdog(state.dir)).rejects.toThrow(); await release();
  const next = await acquireWatchdog(state.dir); await next();
  await withBindingFence(state.dir, () => withBindingFence(state.dir, async () => {}));
  const path = join(state.dir, "crash.lock");
  const helper = Bun.spawn(["python3", join(import.meta.dir, "../src/binding-lock.py"), path, "1000"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await helper.stdout.getReader().read(); helper.kill("SIGKILL"); await helper.exited;
  const afterCrash = await acquireFileFence(path, 100); await afterCrash();
  const controller = new AbortController(); const held = await acquireFileFence(path, 100, controller.signal); controller.abort(); await held();
  const afterCancel = await acquireFileFence(path, 100); await afterCancel();
});

test("abort during submission retains fence until subprocess action terminates", async () => {
  const h = await fixture(); h.unavailable(); const controller = new AbortController();
  let competing = false, competitor: Promise<unknown> | undefined;
  h.onQueue(async () => {
    controller.abort();
    competitor = withBindingFence(h.state.dir, async () => { competing = true; });
    await Bun.sleep(40); expect(competing).toBe(false);
  });
  await new DeliveryWatchdog(h.config, { ...h.opts, signal: controller.signal }).poll();
  await competitor; expect(competing).toBe(true); expect(h.queues()).toHaveLength(1);
});

test("owner death while protected child runs keeps kernel fence until child termination", async () => {
  const state = withState(); cleanups.push(state.done); const path = join(state.dir, "binding-fence.lock");
  const helper = Bun.spawn(["python3", join(import.meta.dir, "../src/binding-lock.py"), path, "1000"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = helper.stdout.getReader(); await reader.read();
  helper.stdin.write(JSON.stringify({ argv: ["python3", "-c", "import time; time.sleep(0.2)"], timeoutMs: 1000 }) + "\n"); helper.stdin.end();
  await expect(acquireFileFence(path, 20)).rejects.toThrow();
  await helper.exited; reader.releaseLock(); const release = await acquireFileFence(path, 200); await release();
});

test("death before acquisition announcement and timeout while another owner holds leave no stale ownership", async () => {
  const state = withState(); cleanups.push(state.done); const path = join(state.dir, "unannounced.lock");
  const release = await acquireFileFence(path, 100);
  const waiting = Bun.spawn(["python3", join(import.meta.dir, "../src/binding-lock.py"), path, "1000"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  waiting.kill("SIGKILL"); await waiting.exited;
  await expect(acquireFileFence(path, 10)).rejects.toThrow(); await release();
  const next = await acquireFileFence(path, 100); await next();
});

test("retention bounded and status read has no writes", async () => {
  const h = await fixture(); const path = join(h.state.dir, "watchdog/state.json");
  atomicJson(path, { version: 1, incidents: Array.from({ length: 105 }, (_, n) => ({ id: String(n), firstSeenAt: n, lastSeenAt: n, resolvedAt: n + 1, notification: "sent", reasons: [], binding: null })) });
  expect((await h.watchdog().poll()).incidents).toHaveLength(100);
  const before = readFileSync(path, "utf8"); watchdogStatus(h.state.dir); expect(readFileSync(path, "utf8")).toBe(before);
});

test("daemon affinity changes during final observer preflight stay pending", async () => {
  const h = await fixture(); h.unavailable();
  h.onRead(() => { if (h.reads() === 2) h.socket("/different/socket"); });
  expect((await h.watchdog().poll()).incidents[0]?.notification).toBe("pending"); expect(h.queues()).toHaveLength(0);
});

test("recovery needs stable delivery readiness with no pending eligible mail", async () => {
  const h = await fixture(); h.opts.recoveryGraceMs = 10000; h.unavailable(); await h.watchdog().poll();
  h.available(); await h.watchdog().poll(); expect(watchdogStatus(h.state.dir).incidents[0]?.resolvedAt).toBeUndefined();
  h.advance(11000); h.mail("recent", { at: new Date(h.opts.now()).toISOString() });
  await h.watchdog().poll(); expect(watchdogStatus(h.state.dir).incidents[0]?.resolvedAt).toBeUndefined();
  h.service.inbox.mark("recent", { state: "sent", turnId: "done" }); await h.watchdog().poll(); h.advance(11000);
  expect((await h.watchdog().poll()).incidents[0]?.resolvedAt).toBeDefined(); expect(h.queues()).toHaveLength(1);
});

test("killed lock helper cannot release fence while its queue child still owns inherited lock fd", async () => {
  const state = withState(); cleanups.push(state.done); const path = join(state.dir, "binding-fence.lock"), marker = join(state.dir, "started");
  const helper = Bun.spawn(["python3", join(import.meta.dir, "../src/binding-lock.py"), path, "1000"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = helper.stdout.getReader(); await reader.read();
  helper.stdin.write(JSON.stringify({ argv: ["python3", "-c", "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('started'); time.sleep(0.3)", marker], timeoutMs: 1000 }) + "\n"); helper.stdin.flush();
  for (let n = 0; n < 100 && !await Bun.file(marker).exists(); n++) await Bun.sleep(5);
  expect(await Bun.file(marker).exists()).toBe(true); helper.kill("SIGKILL"); await helper.exited; reader.releaseLock();
  await expect(acquireFileFence(path, 20)).rejects.toThrow(); const release = await acquireFileFence(path, 1000); await release();
});


test("live held delivery with invalid attachment records a record-only binding incident", async () => {
  const h = await fixture(); await h.hold();
  const path = join(h.state.dir, "attachments/lead.json"), a = JSON.parse(readFileSync(path, "utf8"));
  atomicJson(path, { ...a, generation: a.generation + 1 }); expect(readWatchTarget(h.state.dir)).toBeNull();
  const result = await h.watchdog().poll();
  expect(result.incidents[0]).toMatchObject({ notification: "pending", binding: null, reasons: ["attachment-held", "binding-unverified"] });
  await h.watchdog().poll(); expect(watchdogStatus(h.state.dir).incidents).toHaveLength(1); expect(h.queues()).toHaveLength(0);
});

for (const hold of ["owner-pause", "done-review", "detached"] as const) test(`invalid binding preserves authoritative deliberate ${hold}`, async () => {
  const h = await fixture();
  if (hold === "detached") await h.service.handle("lead-detach", { threadId: id }, { role: "admin" });
  else await h.service.registry.update("lead", l => ({ ...l, dispatchBlocked: true, holdReason: hold, status: hold === "owner-pause" ? "paused" : "done-claimed" }));
  const path = join(h.state.dir, "attachments/lead.json"), a = JSON.parse(readFileSync(path, "utf8")); atomicJson(path, { ...a, generation: a.generation + 1 });
  expect((await h.watchdog().poll()).incidents).toHaveLength(0); expect(h.queues()).toHaveLength(0);
});

test("fresh generation fault observes its own grace interval without replaying old unknown marker", async () => {
  const h = await fixture(); h.unavailable(); h.noReceipt(); await h.watchdog().poll();
  const old = structuredClone(watchdogStatus(h.state.dir).incidents[0]!);
  h.opts.graceMs = 1000;
  const path = join(h.state.dir, "attachments/lead.json"), a = JSON.parse(readFileSync(path, "utf8")), instance = crypto.randomUUID(); atomicJson(path, { ...a, generation: 2, instance });
  await h.service.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, hostInstanceId: instance, generation: 2 } }));
  await h.watchdog().poll(); expect(h.queues()).toHaveLength(1);
  h.advance(1001); await h.watchdog().poll(); expect(h.queues()).toHaveLength(2);
  const current = watchdogStatus(h.state.dir).incidents;
  expect(current[0]).toMatchObject({ id: old.id, text: old.text, binding: old.binding, notification: "unknown", supersededAt: expect.any(Number) });
  expect(current[1]!.id).not.toBe(old.id);
});
