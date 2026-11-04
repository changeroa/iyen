import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { readJson, serviceSocket } from "../src/ipc.ts";
import { assertOperator, parseRegistry, registryPath, selectProfile, overlaps, type Selection } from "../src/launcher/profiles.ts";
import { agentName, selectPane, nativeLead, type LaunchRecord } from "../src/launcher/native.ts";
import { assertLeadResumable, effectiveRole, launch, launchLocked, type Dependencies } from "../src/launcher/index.ts";
import { assertServiceReady, descendants, ensureService, stopService } from "../src/launcher/service.ts";
import type { Runner } from "../src/run.ts";
const roots: string[] = [];
const root = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), "iyen-launch-test-"))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const ok = (value: any = {}) => ({ code: 0, out: JSON.stringify({ result: value }), err: "" });
const uuid = "11111111-1111-4111-8111-111111111111";
function selection(kind: "codex" | "omp" = "codex"): Selection {
  const path = root(), config = defaultConfig(path);
  config.stateDir = join(path, "state"); config.defaultCwd = path; config.personaDir = join(path, "persona");
  config.runtime.kind = kind; config.runtime.roles.lead = { model: "lead-model", effort: "high" }; config.runtime.roles.lane = { model: "worker-model", effort: "low" };
  config.runtime.startupTimeoutMs = 1000; config.runtime.rpcTimeoutMs = 100;
  return { kind, registryPath: join(path, "launchers.json"), config, profile: { configPath: join(path, "config.json") }, registered: [] };
}
function record(s: Selection): LaunchRecord { return { version: 1, configPath: s.profile.configPath, operationId: "12345678-1234-1234-1234-123456789012", phase: "prepared", cwd: s.config.defaultCwd, model: "lead-model", effort: "high" }; }
function lead(s: Selection, extras: any = {}) { return { key: "lead", status: "working", revision: 4, pane: "p1", cwd: s.config.defaultCwd, bridge: join(s.config.stateDir, "bridge"), identityVerified: true, inputReady: true, runtime: { kind: s.kind, backend: "external-current-session", threadId: uuid, model: "lead-model", effort: "high", hostInstanceId: "instance", generation: 1 }, ...extras }; }
function harness(s: Selection, initial?: any) {
  let current = initial; const calls: string[] = [], prompts: string[][] = [];
  const deps: Dependencies = {
    runner: async args => { prompts.push([...args]); return { code: 0, out: JSON.stringify({ turnId: "receipt" }), err: "" }; },
    preflight: async () => { calls.push("preflight"); }, checkTarget: async () => { calls.push("checkTarget"); },
    ensureService: async () => { calls.push("ensureService"); }, ready: async () => {},
    selectPane: async (_c, _saved, row, _run, persist) => { row.pane = current?.pane ?? "p1"; row.terminalId = "t1"; persist(); return { pane: { pane_id: row.pane }, occupied: Boolean(current?.identityVerified) }; },
    nativeLead: async (_c, saved, row) => { calls.push(`native:${saved?.threadId ?? "fresh"}`); return { threadId: saved?.threadId ?? uuid, pane: row.pane!, cwd: row.cwd }; },
    call: async (_selection, action, args) => {
      calls.push(action);
      if (action === "status") return args?.key ? current : current ? [current] : [];
      if (action === "lead-activate" || action === "lead-reconnect") { current = lead(s, { pane: args.pane }); return { attached: true, lead: current, bridge: current.bridge }; }
      throw new Error(`unexpected ${action}`);
    },
  };
  return { deps, calls, prompts, get current() { return current; }, set current(value) { current = value; } };
}
describe("launcher profile boundary", () => {
  test("XDG registry and strict profile hooks", () => {
    expect(registryPath({ XDG_CONFIG_HOME: "/config" }, "/home")).toBe("/config/iyen/launchers.json");
    expect(parseRegistry({ version: 1, profiles: { codex: { configPath: "codex.json", leadInstructionsPath: "LEAD.md", service: { start: ["supervisor", "start"], stop: ["supervisor", "stop"], stopped: ["supervisor", "is-stopped"] } } } }, "/config/launchers.json").profiles.codex?.leadInstructionsPath).toBe("/config/LEAD.md");
    expect(() => parseRegistry({ version: 1, profiles: { codex: { configPath: "x", service: { start: "shell command", stop: [] } } } }, "/tmp/x")).toThrow("argv");
  });
  test("existing config mandatory and explicit config takes precedence", async () => {
    const s = selection(); atomicJson(s.profile.configPath, s.config);
    atomicJson(s.registryPath, { version: 1, profiles: { codex: { configPath: s.profile.configPath } } });
    const other = join(s.config.defaultCwd, "other.json"); atomicJson(other, { ...s.config, stateDir: join(s.config.defaultCwd, "other") });
    expect((await selectProfile("codex", { registry: s.registryPath, config: other })).profile.configPath).toBe(other);
    await expect(selectProfile("omp", { registry: s.registryPath, config: other })).rejects.toThrow("runtime.kind");
    await expect(selectProfile("omp", { registry: s.registryPath })).rejects.toThrow("No omp");
    await expect(selectProfile("codex", { registry: join(root(), "missing") })).rejects.toThrow("register");
  });
  test("registered profiles cannot share state", async () => {
    const s = selection(), omp = join(s.config.defaultCwd, "omp.json"); atomicJson(s.profile.configPath, s.config);
    atomicJson(omp, { ...s.config, runtime: { ...s.config.runtime, kind: "omp", binary: "/bin/omp", settingsHome: "/isolated/omp", requiredVersion: "18.15.0", sandbox: "danger-full-access", omp: { registryDir: "/isolated/registry", extensionPath: "/isolated/extension.ts", provider: "provider", approvalMode: "yolo" } } });
    atomicJson(s.registryPath, { version: 1, profiles: { codex: { configPath: s.profile.configPath }, omp: { configPath: omp } } });
    await expect(selectProfile("codex", { registry: s.registryPath })).rejects.toThrow("isolated state");
  });
  test.each(["DORI_CONTEXT", "DORI_LANE_KEY", "DORI_LANE_TOKEN"])("rejects scoped %s even empty", key => { expect(() => assertOperator({ [key]: "" })).toThrow("operator"); });
  test("lead effective precedence never falls back to lane", () => {
    const s = selection(); expect(effectiveRole(s.config, { runtime: { model: "saved", effort: "medium" } }, {})).toEqual({ model: "saved", effort: "medium" });
    expect(effectiveRole(s.config, { runtime: { model: "saved", effort: "medium" } }, { model: "override", effort: "low" })).toEqual({ model: "override", effort: "low" });
    s.config.runtime.roles.lead = { model: null, effort: null }; expect(() => effectiveRole(s.config, undefined, {})).toThrow("lead model");
  });
});
describe("exact native ownership", () => {
  test("agent names satisfy installed Herdr limit", () => { expect(agentName(record(selection()).operationId)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/); });
  test("gone pane creates no-focus target only after full inventory, ignores unrelated missing association", async () => {
    const s = selection(), row = record(s); row.pane = "old";
    const seen: string[][] = [];
    const runner: Runner = async args => { seen.push([...args]); return ok(args[1] === "agent" ? { agents: [{ agent: "codex", pane_id: "unrelated" }] } : args[2] === "list" ? { panes: [{ pane_id: "unrelated", terminal_id: "other", cwd: row.cwd }] } : { root_pane: { pane_id: "new", terminal_id: "term" } }); };
    await selectPane(s.config, { threadId: uuid, pane: "old", cwd: row.cwd }, row, runner, () => {});
    expect(row.pane).toBe("new"); expect(seen.at(-1)).toContain("--no-focus");
  });
  test("occupied saved pane refuses instead of choosing idle agent", async () => {
    const s = selection(), row = record(s); row.pane = "p1";
    const runner: Runner = async args => ok(args[1] === "agent" ? { agents: [{ agent: "codex", pane_id: "p1", agent_session: { value: "different" } }] } : { panes: [{ pane_id: "p1", terminal_id: "t1", cwd: row.cwd, agent: "codex" }] });
    await expect(selectPane(s.config, { threadId: uuid, pane: "p1", cwd: row.cwd }, row, runner, () => {})).rejects.toThrow("occupied");
  });
  test("duplicate native owner refuses", async () => {
    const s = selection(), row = record(s); row.pane = "p1";
    const runner: Runner = async args => ok(args[1] === "agent" ? { agents: ["p1", "p2"].map(pane_id => ({ agent: "codex", pane_id, agent_session: { value: uuid } })) } : { panes: [] });
    await expect(selectPane(s.config, { threadId: uuid, pane: "p1", cwd: row.cwd }, row, runner, () => {})).rejects.toThrow("ambiguous");
  });
  test("unknown fresh launch can reconcile only its named pane", async () => {
    const s = selection(), row = record(s); row.pane = "p1"; row.phase = "native-starting"; row.terminalId = "t1";
    const runner: Runner = async args => ok(args[1] === "agent" ? { agents: [{ agent: "codex", pane_id: "p1", name: agentName(row.operationId) }] } : { panes: [{ pane_id: "p1", terminal_id: "t1", cwd: row.cwd, agent: "codex" }] });
    expect((await selectPane(s.config, undefined, row, runner, () => {})).occupied).toBe(true);
  });
});
describe("launcher transaction", () => {
  test("live attached busy lead repeats without activate, bootstrap or restart", async () => {
    const s = selection(), h = harness(s, lead(s, { inputReady: false }));
    for (let n = 0; n < 2; n++) expect((await launchLocked(s, {}, h.deps)).reused).toBe(true);
    expect(h.prompts).toHaveLength(0); expect(h.calls).not.toContain("lead-activate"); expect(h.calls).not.toContain("lead-reconnect");
  });
  test("fresh native lead receives exactly one generation-scoped bootstrap", async () => {
    const s = selection(), h = harness(s);
    const result = await launchLocked(s, {}, h.deps); expect(result.bootstrap).toBe("received");
    await launchLocked(s, {}, h.deps);
    expect(h.calls.filter(x => x === "lead-activate")).toHaveLength(1); expect(h.prompts).toHaveLength(1);
    const instructions = await Bun.file(h.prompts[0]![4]!).text();
    expect(instructions).toContain("Do not send an unsolicited activation"); expect(instructions).not.toContain("control.json");
    expect(existsSync(resolve(import.meta.dir, "../../../iyen/SKILL.md"))).toBe(true);
  });
  test("recovery service held flag permits verified native reconnect", async () => {
    const s = selection(), broken = lead(s, { identityVerified: false, dispatchBlocked: true, holdReason: "recovery" }); broken.runtime.held = true;
    const h = harness(s, broken); expect((await launchLocked(s, {}, h.deps)).ready).toBe(true); expect(h.calls).toContain("lead-reconnect");
  });
  test.each(["paused", "done-claimed", "verified-done", "closed"])("protected %s target refuses before source switch", async status => {
    const s = selection(), protectedLead = lead(s, { status }); atomicJson(join(s.config.stateDir, "lanes", "lead.json"), protectedLead);
    const h = harness(s, protectedLead); await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("paused"); expect(h.calls).not.toContain("ensureService");
  });
  test("owner hold stays protected while recovery hold is allowed", () => {
    expect(() => assertLeadResumable({ status: "working", holdReason: "owner-pause", runtime: { held: true } })).toThrow();
    expect(() => assertLeadResumable({ status: "working", holdReason: "recovery", runtime: { held: true } })).not.toThrow();
  });
  test("occupied preflight refuses before stopping receiver", async () => {
    const s = selection(), h = harness(s); h.deps.checkTarget = async () => { throw new Error("occupied"); };
    await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("occupied"); expect(h.calls).not.toContain("ensureService");
  });
  test("concurrent invocations serialize through durable registry lock", async () => {
    const s = selection(), h = harness(s); atomicJson(s.profile.configPath, s.config); atomicJson(s.registryPath, { version: 1, profiles: { codex: { configPath: s.profile.configPath } } });
    let active = 0, max = 0; h.deps.preflight = async () => { max = Math.max(max, ++active); await Bun.sleep(30); active--; };
    const results = await Promise.all([launch("codex", { registry: s.registryPath }, h.deps), launch("codex", { registry: s.registryPath }, h.deps)]);
    expect(results.every(x => x.ready)).toBe(true); expect(max).toBe(1); expect(h.prompts).toHaveLength(1);
  });
});
describe("service isolation and readiness", () => {
  test("overlap compares ingress id and owners, not wrapper argv", () => {
    const a = selection().config, b = selection().config; a.ingress = [{ id: "slack", owners: ["owner"], command: ["first"] }]; b.ingress = [{ id: "slack", owners: ["owner"], command: ["different"] }];
    expect(overlaps(a,b)).toBe(true); b.ingress[0]!.owners = ["other"]; expect(overlaps(a,b)).toBe(false);
  });
  test("ready requires authenticated ready phase, exact PID and running configured receiver", () => {
    const s = selection(); atomicJson(join(s.config.stateDir, "service.lock"), { pid: process.pid, instance: "test" }); s.config.ingress = [{ id: "slack", owners: ["owner"], command: ["receiver"] }];
    const health = { serviceReachable: true, phase: "ready", pid: process.pid, ingress: [{ id: "slack", process: "running", connection: "unverified" }] };
    expect(() => assertServiceReady(s.config, health)).not.toThrow(); expect(() => assertServiceReady(s.config, { ...health, phase: "reconciling" })).toThrow(); expect(() => assertServiceReady(s.config, { ...health, ingress: [] })).toThrow(); expect(() => assertServiceReady(s.config, { ...health, pid: process.pid + 1 })).toThrow();
  });
  test("process snapshot captures wrapper descendants", async () => {
    expect(await descendants(123, async () => ({ code: 0, out: "123 1\n124 123\n125 124\n126 1", err: "" }))).toEqual([123,124,125]);
  });
  test("failed supervisor stop never starts requested receiver", async () => {
    const s = selection(), other = selection(); s.config.ingress = other.config.ingress = [{ id: "same", command: ["receiver"], owners: ["owner"] }];
    atomicJson(join(other.config.stateDir, "service.lock"), { pid: process.pid, instance: "test" }); atomicJson(join(other.config.stateDir, "control.json"), { token: "test-token" });
    other.profile.service = { start: ["start-other"], stop: ["stop-other"] }; s.profile.service = { start: ["start-target"], stop: ["stop-target"] };
    s.registered = [{ kind: "codex", profile: other.profile, config: other.config }];
    const server = Bun.serve({ unix: serviceSocket(other.config.stateDir), fetch: request => request.headers.get("authorization") === "Bearer test-token" ? Response.json({ result: { serviceReachable: true } }) : new Response("unauthorized", { status: 403 }) });
    const calls: string[] = []; const runner: Runner = async args => { calls.push(args[0]!); return args[0] === "ps" ? { code: 0, out: `${process.pid} 1`, err: "" } : { code: 1, out: "", err: "stop failed" }; };
    try {
      await expect(ensureService(s, true, runner)).rejects.toThrow("Conflicting"); expect(calls).toHaveLength(0);
      await expect(ensureService(s, false, runner)).rejects.toThrow("stop failed"); expect(calls).not.toContain("start-target");
    } finally { await server.stop(true); }
  });
});

test("OMP uncertain bootstrap is receipt-reconciled without replay", async () => {
  const s = selection("omp"), h = harness(s); let received = false, submitted = 0;
  h.deps.runner = async args => {
    if (args[1] === "input") { submitted++; return { code: 124, out: "", err: "uncertain" }; }
    if (args[1] === "input-status") return { code: 0, out: JSON.stringify({ status: received ? "received" : "unknown" }), err: "" };
    throw new Error("unexpected runner command");
  };
  await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("outcome unknown");
  const first = readJson<LaunchRecord>(join(s.config.stateDir, "launcher", "launch.json"));
  expect(first.bootstrap?.phase).toBe("sending"); received = true;
  expect((await launchLocked(s, {}, h.deps)).bootstrap).toBe("received");
  const second = readJson<LaunchRecord>(join(s.config.stateDir, "launcher", "launch.json"));
  expect(second.bootstrap?.operationId).toBe(first.bootstrap?.operationId); expect(second.bootstrap?.text).toBe(first.bootstrap?.text); expect(submitted).toBe(1);
});

test("target pending restart refuses before receiver switch", async () => {
  const s = selection(), h = harness(s); atomicJson(join(s.config.stateDir, "service-health.json"), { restart: { operationId: "pending" } });
  await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("unresolved restart"); expect(h.calls).not.toContain("ensureService");
});

test("successful supervisor stop waits for pinned service process death and explicit stopped check", async () => {
  const s = selection(); s.config.runtime.startupTimeoutMs = 2000;
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  atomicJson(join(s.config.stateDir, "service.lock"), { pid: child.pid, instance: "owned" });
  s.profile.service = { start: ["start"], stop: ["stop"], stopped: ["verify-unloaded"] };
  const calls: string[] = [];
  const runner: Runner = async args => {
    calls.push(args[0]!);
    if (args[0] === "ps") return { code: 0, out: `${child.pid} 1`, err: "" };
    if (args[0] === "stop") { child.kill(); await child.exited; }
    return { code: 0, out: "", err: "" };
  };
  try { await stopService(s.config, s.profile, runner); expect(calls).toEqual(["ps", "stop", "verify-unloaded"]); }
  finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
});

async function codexProtocolFixture() {
  const s = selection(); s.config.runtime.binary = process.execPath; s.config.runtime.startupTimeoutMs = 50;
  const socketPath = serviceSocket(s.config.stateDir).replace("service.sock", "codex.sock");
  const row = record(s); row.pane = "p1"; row.terminalId = "t1";
  const calls: string[][] = [], reads: string[] = []; let submittedText = "", publish = true, resumed: string | undefined;
  const agent: any = { agent: "codex", pane_id: "p1", name: agentName(row.operationId), agent_status: "idle" };
  const thread = { id: uuid, cwd: row.cwd, model: row.model, reasoningEffort: row.effort, status: { type: "idle" } };
  const server = Bun.serve({ unix: socketPath, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
    const m = JSON.parse(String(raw)); reads.push(m.method); if (m.id === undefined) return;
    const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread } : m.method === "thread/loaded/list" ? { data: [uuid], nextCursor: null } : m.method === "thread/turns/list" ? { data: publish && submittedText ? [{ id: "handshake-turn", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: submittedText }] }] }] : [], nextCursor: null } : undefined;
    ws.send(JSON.stringify(result === undefined ? { id: m.id, error: { code: -1, message: "write refused" } } : { id: m.id, result }));
  } } });
  const runner: Runner = async args => {
    calls.push([...args]);
    if (args[0] === process.execPath) return args[1] === "queue" ? { code: 0, out: "--thread ID --message TEXT", err: "" } : { code: 0, out: JSON.stringify({ status: "running", socketPath, cliVersion: "0.163.0", appServerVersion: "0.163.0" }), err: "" };
    if (args[1] === "agent" && args[2] === "start") { const native = args.slice(args.indexOf("--") + 1); if (native[0] === "resume") { resumed = native[1]; agent.agent_session = { agent: "codex", kind: "id", value: resumed }; } return ok({ agent }); }
    if (args[1] === "agent" && args[2] === "get") return ok({ agent });
    if (args[1] === "agent" && args[2] === "prompt") { submittedText = args[4]!; return { code: 124, out: "", err: "prompt receipt lost" }; }
    if (args[1] === "pane" && args[2] === "report-agent-session") { agent.agent_session = { agent: "codex", kind: "id", value: args.at(-1) }; return ok(); }
    throw new Error(`unexpected command ${args.slice(0,3)}`);
  };
  return { s, row, runner, calls, reads, agent, thread, set publish(value: boolean) { publish = value; }, get resumed() { return resumed; }, close: async () => { await server.stop(true); rmSync(socketPath, { force: true }); } };
}
test("native Codex lost prompt response reconciles exact observer receipt once", async () => {
  const h = await codexProtocolFixture();
  try {
    const identity = await nativeLead(h.s.config, undefined, h.row, false, h.runner, () => {});
    expect(identity.threadId).toBe(uuid); expect(h.calls.filter(a => a[2] === "prompt")).toHaveLength(1);
    expect(h.calls.find(a => a[2] === "start")![3]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(h.calls.some(a => a.includes("--last"))).toBe(false);
    expect(h.reads.every(method => ["initialize", "initialized", "thread/loaded/list", "thread/read", "thread/turns/list"].includes(method))).toBe(true);
  } finally { await h.close(); }
});
test("native Codex unknown handshake retry never relaunches or reprompts", async () => {
  const h = await codexProtocolFixture(); h.publish = false;
  try {
    await expect(nativeLead(h.s.config, undefined, h.row, false, h.runner, () => {})).rejects.toThrow("unknown");
    expect(h.row.handshakeAttempted).toBe(true); h.publish = true;
    expect((await nativeLead(h.s.config, undefined, h.row, true, h.runner, () => {})).threadId).toBe(uuid);
    expect(h.calls.filter(a => a[2] === "start")).toHaveLength(1); expect(h.calls.filter(a => a[2] === "prompt")).toHaveLength(1);
  } finally { await h.close(); }
});
test("native Codex saved UUID resumes exactly without handshake", async () => {
  const h = await codexProtocolFixture();
  try {
    expect((await nativeLead(h.s.config, { threadId: uuid, pane: "old-gone", cwd: h.row.cwd }, h.row, false, h.runner, () => {})).threadId).toBe(uuid);
    expect(h.resumed).toBe(uuid); expect(h.calls.filter(a => a[2] === "prompt")).toHaveLength(0);
    const start = h.calls.find(a => a[2] === "start")!; expect(start).toContain("resume"); expect(start).toContain(uuid); expect(start).not.toContain("--sandbox");
  } finally { await h.close(); }
});

test("unrelated worker unknown backlog does not block healthy lead reuse", async () => {
  const s = selection(), h = harness(s, lead(s)); atomicJson(join(s.config.stateDir, "service-health.json"), { queue: { unknown: 4, sending: 1 }, delivery: { state: "ready" } });
  expect((await launchLocked(s, {}, h.deps)).reused).toBe(true); expect(h.prompts).toHaveLength(0);
});
test("Codex reconnect request excludes OMP-only identity fields and persists exact args across changed revision", async () => {
  const s = selection(), h = harness(s, lead(s, { identityVerified: false, holdReason: "recovery", dispatchBlocked: true }));
  const original = h.deps.call; const requests: any[] = []; let interrupted = true;
  h.deps.call = async (selection, action, args) => {
    if (action === "lead-reconnect") {
      expect(args).not.toHaveProperty("terminalId"); expect(args).not.toHaveProperty("sessionFile"); requests.push(structuredClone(args));
      const durable = readJson<LaunchRecord>(join(s.config.stateDir, "launcher", "launch.json")); expect(durable.attachmentRequest?.args).toEqual(args);
      if (interrupted) { interrupted = false; h.current = { ...h.current, revision: 15 }; throw new Error("interrupted after service intent"); }
      expect(args.expectedRevision).toBe(4);
    }
    return original(selection, action, args);
  };
  await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("interrupted");
  expect((await launchLocked(s, {}, h.deps)).ready).toBe(true); expect(requests[1]).toEqual(requests[0]);
});
test("post-attachment response loss retains initialization obligation", async () => {
  const s = selection(), h = harness(s), original = h.deps.call; let interrupted = true;
  h.deps.call = async (selection, action, args) => {
    const result = await original(selection, action, args);
    if (action === "lead-activate" && interrupted) { interrupted = false; throw new Error("crash after committed attachment"); }
    return result;
  };
  await expect(launchLocked(s, {}, h.deps)).rejects.toThrow("crash");
  const pending = readJson<LaunchRecord>(join(s.config.stateDir, "launcher", "launch.json")); expect(pending.initialize).toBe(true); expect(pending.bootstrap).toBeUndefined();
  expect((await launchLocked(s, {}, h.deps)).bootstrap).toBe("received"); expect(h.prompts).toHaveLength(1);
});
test("attached journal without bootstrap cannot become ready without initialization", async () => {
  const s = selection(), h = harness(s, lead(s));
  const pending: LaunchRecord = { ...record(s), phase: "attached", initialize: true, identity: { threadId: uuid, pane: "p1", cwd: s.config.defaultCwd }, pane: "p1", attachment: { instance: "instance", generation: 1 } };
  atomicJson(join(s.config.stateDir, "launcher", "launch.json"), pending);
  expect((await launchLocked(s, {}, h.deps)).bootstrap).toBe("received"); expect(h.prompts).toHaveLength(1);
});
test("same profile through alternate registries shares state launch fence", async () => {
  const s = selection(), h = harness(s); atomicJson(s.profile.configPath, s.config);
  const otherRegistry = join(root(), "launchers.json"), registry = { version: 1, profiles: { codex: { configPath: s.profile.configPath } } };
  atomicJson(s.registryPath, registry); atomicJson(otherRegistry, registry);
  let active = 0, max = 0; h.deps.preflight = async () => { max = Math.max(max, ++active); await Bun.sleep(30); active--; };
  await Promise.all([launch("codex", { registry: s.registryPath }, h.deps), launch("codex", { registry: otherRegistry }, h.deps)]);
  expect(max).toBe(1); expect(h.prompts).toHaveLength(1);
});
