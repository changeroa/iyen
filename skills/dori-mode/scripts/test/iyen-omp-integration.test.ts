import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, parseConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { DoriService } from "../src/service.ts";
import { hostSocket } from "../src/ipc.ts";
import { bootstrapPath } from "../src/runtime/session-host.ts";
import { ompManagedEnvironment, ompPaneCommand, verifyOmpHerdr, discoverOmpSafe } from "../src/runtime/omp-integration.ts";
import { payloadHash } from "../src/runtime/omp/contract.ts";
import { readWatchTarget, DeliveryWatchdog } from "../src/watchdog.ts";
import { ompFixture } from "./fixtures/omp.ts";
import type { Runner } from "../src/run.ts";
const profile = (dir: string): DoriConfig => ({ ...defaultConfig(dir), stateDir: join(dir, "state"), runtime: { ...defaultConfig(dir).runtime,
  kind: "omp", binary: "/fixture/omp", requiredVersion: "18.15.0", rpcTimeoutMs: 200, sandbox: "danger-full-access", settingsHome: join(dir, "profile"),
  roles: { lead: { model: null, effort: null }, lane: { model: "test", effort: "medium" } },
  omp: { registryDir: dir, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "always-ask" } } });
const receipt = (f: ReturnType<typeof ompFixture>, operationId: string, text: string) => ({ operationId, payloadHash: payloadHash(text), sessionId: f.identity.sessionId, sessionFile: f.identity.sessionFile, entryId: operationId, receiptId: `omp-entry:${f.identity.sessionId}:${operationId}` });
const association = (f: ReturnType<typeof ompFixture>): Runner => async argv => {
  if (argv.join(" ") !== "herdr agent list") throw new Error(`Unexpected runtime command: ${argv[0]}`);
  return { code: 0, err: "", out: JSON.stringify({ result: { agents: [{ agent: "omp", cwd: f.identity.cwd, pane_id: f.identity.paneId, terminal_id: f.identity.terminalId,
    agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: f.identity.sessionFile } }] } }) };
};
async function setup(handler?: (method: string, params: any) => any) {
  const f = ompFixture(); f.transcript([]);
  Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity);
  await f.serve(async r => ({ protocol: 1, id: r.id, identity: f.identity, result: r.method === "inspect" ? f.snapshot : handler ? await handler(r.method, r.params) : { receipt: receipt(f, r.params.operationId, r.params.text) } }));
  atomicJson(join(f.directory, `${createHash("sha256").update("instance:1").digest("hex")}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
  const config = profile(f.directory), runner = association(f), s = new DoriService(config, runner);
  return { f, config, runner, s, args: { threadId: f.identity.sessionId, sessionFile: f.identity.sessionFile, pane: f.identity.paneId, terminalId: f.identity.terminalId, cwd: f.directory } };
}
test("OMP profile rejects Codex sandbox/effort, implicit profile and effective production state override", () => {
  const cfg = profile("/tmp/iyen-profile"); expect(parseConfig(cfg).runtime.kind).toBe("omp");
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]) expect(parseConfig({ ...cfg, runtime: { ...cfg.runtime, roles: { lane: { model: "test", effort } } } }).runtime.roles.lane.effort).toBe(effort);
  for (const effort of ["none", "ultra"]) expect(() => parseConfig({ ...cfg, runtime: { ...cfg.runtime, roles: { lane: { model: "test", effort } } } })).toThrow("effort");
  for (const sandbox of ["read-only", "workspace-write"]) expect(() => parseConfig({ ...cfg, runtime: { ...cfg.runtime, sandbox } })).toThrow("OS sandbox");
  expect(() => parseConfig({ ...cfg, runtime: { ...cfg.runtime, settingsHome: undefined } })).toThrow("settingsHome");
  const old = process.env.DORI_STATE_DIR;
  try { process.env.DORI_STATE_DIR = defaultConfig().stateDir; expect(() => parseConfig(cfg)).toThrow("isolated stateDir"); }
  finally { if (old === undefined) delete process.env.DORI_STATE_DIR; else process.env.DORI_STATE_DIR = old; }
  expect(defaultConfig().runtime.kind).toBe("codex");
});
test("managed OMP clears pane environment, filters messenger/admin credentials, preserves isolated settings", () => {
  const env = ompManagedEnvironment("/isolated", { pane_id: "w:p", tab_id: "w:t", workspace_id: "w" }, { PATH: "/usr/bin", HOME: "/home/test", OPENAI_API_KEY: "provider", SLACK_BOT_TOKEN: "messenger", DORI_CONTEXT: "/admin", CODEX_HOME: "/real", HERDR_PANE_ID: "wrong", BASH_ENV: "/inject" });
  expect(env).toMatchObject({ PI_CODING_AGENT_DIR: "/isolated", HERDR_PANE_ID: "w:p", OPENAI_API_KEY: "provider" });
  for (const key of ["SLACK_BOT_TOKEN", "DORI_CONTEXT", "CODEX_HOME", "BASH_ENV"]) expect(env[key]).toBeUndefined();
  const cmd = ompPaneCommand({ cwd: "/some path", env, argv: ["/bin/omp", "literal `x` $(x)"] });
  expect(cmd).toContain("env -i "); expect(cmd).toContain("'literal `x` $(x)'"); expect(cmd).not.toContain("messenger");
});
test("missing new registry is empty; wrong terminal association rejects", async () => {
  const f = ompFixture(); try { expect(await discoverOmpSafe(join(f.directory, "missing"))).toEqual([]); await expect(verifyOmpHerdr({ ...f.target, terminalId: "wrong" }, association(f))).rejects.toThrow("association mismatch"); } finally { f.cleanup(); }
});
test("borrowed exact attachment is idempotent, excludes historical mail, stores structured receipt and never stops TUI", async () => {
  let inputs = 0; const x = await setup((method, p) => { if (method !== "input") throw new Error("unexpected mutation"); inputs++; return { receipt: receipt(x.f, p.operationId, p.text) }; });
  try {
    x.s.inbox.put({ id: "history", target: "lead", text: "old", state: "queued", at: new Date().toISOString() });
    const attached = await x.s.handle("lead-activate", x.args, { role: "admin" }), instance = attached.lead.runtime.hostInstanceId;
    expect(attached.lead.runtime.omp.target.terminalId).toBe(x.args.terminalId);
    expect((await x.s.handle("lead-activate", x.args, { role: "admin" })).lead.runtime.hostInstanceId).toBe(instance);
    await expect(x.s.deps.runtime.input("lead", "old", "history")).rejects.toThrow("Historical");
    expect(await x.s.handle("input", { key: "lead", text: "work", operationId: "one" }, { role: "admin" })).toMatchObject({ receiptKind: "omp-session-entry", receipt: { entryId: "one" } });
    expect(x.s.inbox.get("one")).toMatchObject({ state: "sent", attachmentInstance: instance });
    expect(readWatchTarget(x.config.stateDir)?.binding.native?.terminalId).toBe(x.args.terminalId);
    await x.s.handle("lead-detach", { threadId: x.args.threadId }, { role: "admin" }); expect(inputs).toBe(1);
    await expect(x.s.handle("status", { key: "lead" }, { role: "lead", key: "lead", instance })).rejects.toThrow();
  } finally { x.f.cleanup(); }
});
test("wrong native target metadata cannot attach or launch", async () => {
  const x = await setup(); try { await expect(x.s.handle("lead-activate", { ...x.args, terminalId: "wrong" }, { role: "admin" })).rejects.toThrow("target mismatch"); expect(await x.s.registry.read("lead")).toBeNull(); } finally { x.f.cleanup(); }
});
test("unknown OMP mail survives restart and only exact read-only operation receipt reconciles", async () => {
  let inputs = 0, received = false;
  const x = await setup((method, p) => { if (method === "input") { inputs++; throw new Error("lost ACK"); } if (method === "operation") return received ? { status: "received", receipt: receipt(x.f, p.operationId, "work") } : { status: "absent" }; throw new Error("unexpected"); });
  try {
    await x.s.handle("lead-activate", x.args, { role: "admin" });
    await expect(x.s.handle("input", { key: "lead", text: "work", operationId: "lost" }, { role: "admin" })).rejects.toThrow(); expect(x.s.inbox.get("lost")?.state).toBe("unknown");
    const s = new DoriService(x.config, x.runner);
    await expect(s.handle("input", { key: "lead", text: "work", operationId: "lost" }, { role: "admin" })).rejects.toThrow("unknown");
    for (const state of ["queued", "sent"]) await expect(s.handle("mail-resolve", { box: "inbox", id: "lost", state, evidence: "operator" }, { role: "admin" })).rejects.toThrow();
    received = true; expect(await s.handle("mail-resolve", { box: "inbox", id: "lost", state: "sent", evidence: "receipt" }, { role: "admin" })).toMatchObject({ state: "sent", receiptKind: "omp-session-entry" }); expect(inputs).toBe(1);
  } finally { x.f.cleanup(); }
});
test("managed service pause is not blocked behind pending input receipt", async () => {
  const f = ompFixture(), config = profile(f.directory), s = new DoriService(config, association(f));
  let done!: (v: unknown) => void, started!: () => void, held = false; const inputStarted = new Promise<void>(r => { started = r; }); const instance = "host-instance";
  await s.registry.write({ key: "worker", title: "worker", thread: "none", brief: "/b", done: "closed a/b#1", cwd: f.directory, pane: f.identity.paneId, openedAt: new Date().toISOString(), runtime: {
    kind: "omp", backend: "herdr-tui", threadId: f.identity.sessionId, state: "idle", hostInstanceId: instance, generation: 1, binaryVersion: "18.15.0", omp: { kind: "omp", target: f.target, attachmentInstanceId: instance, attachmentGeneration: 1, attachedAt: new Date().toISOString(), excludedInboxIds: [] } } });
  atomicJson(bootstrapPath(config.stateDir, "worker"), { hostToken: "host", laneToken: "lane", instance, role: "lane" });
  const server = Bun.serve({ unix: hostSocket(config.stateDir, "worker"), async fetch(req) { const { action } = await req.json() as any;
    if (action === "input") { started(); return Response.json({ result: await new Promise(r => { done = r; }) }); } if (action === "hold") held = true;
    return Response.json({ result: { threadId: f.identity.sessionId, state: "idle", goal: null } }); } });
  try { const sending = s.handle("input", { key: "worker", text: "work", operationId: "pending" }, { role: "admin" }); await inputStarted;
    const result = await Promise.race([s.handle("pause", { key: "worker" }, { role: "admin" }), Bun.sleep(500).then(() => { throw new Error("Pause blocked behind receipt"); })]);
    expect(result.code).toBe(0); expect(held).toBe(true); expect(s.inbox.get("pending")?.state).toBe("sending");
    done({ turnId: receipt(f, "pending", "work").receiptId, receiptKind: "omp-session-entry", receipt: receipt(f, "pending", "work") }); await sending;
    for (const action of ["launch", "pause", "report"]) await expect(s.handle(action, { key: "other" }, { role: "lane", key: "worker" })).rejects.toThrow("capability");
  } finally { server.stop(true); f.cleanup(); }
});
test("OMP watchdog attempts once after durable unknown and never uses Codex observer", async () => {
  let inputs = 0; const x = await setup(method => { if (method === "operation") return { status: "absent" }; inputs++; throw new Error("unknown"); });
  try { await x.s.handle("lead-activate", x.args, { role: "admin" }); let now = 1000;
    const w = new DeliveryWatchdog(x.config, { now: () => now, graceMs: 0, timeoutMs: 100, runner: x.runner, health: async () => { throw new Error("down"); }, observe: async () => { throw new Error("Codex observer prohibited"); } });
    expect((await w.poll()).incidents[0]?.notification).toBe("unknown"); now++; expect((await w.poll()).incidents[0]?.notification).toBe("unknown"); expect(inputs).toBe(1);
  } finally { x.f.cleanup(); }
});

test("actual MCP CLI subprocess uses OMP lane context and rejects admin/other-lane controls", async () => {
  const f = ompFixture(), config = profile(f.directory), s = new DoriService(config, association(f));
  const instance = "mcp-host";
  await s.registry.write({ key: "worker", role: "lane", title: "worker", thread: "none", brief: "/b", done: "closed a/b#1", openedAt: new Date().toISOString(),
    runtime: { kind: "omp", backend: "herdr-tui", threadId: f.identity.sessionId, state: "idle", hostInstanceId: instance, generation: 1, binaryVersion: "18.15.0" } });
  atomicJson(join(config.stateDir, "control.json"), { token: "operator-not-forwarded" });
  atomicJson(bootstrapPath(config.stateDir, "worker"), { hostToken: "host", laneToken: "lane-scoped", role: "lane", instance });
  const contextFile = join(f.directory, "context.json"), configFile = join(f.directory, "config.json");
  atomicJson(contextFile, { token: "lane-scoped", key: "worker", stateDir: config.stateDir }); atomicJson(configFile, config);
  const { serviceSocket } = await import("../src/ipc.ts");
  const server = Bun.serve({ unix: serviceSocket(config.stateDir), async fetch(request) {
    try {
      const caller = await s.authorize(request.headers.get("authorization")!.replace("Bearer ", ""));
      const { action, args } = await request.json() as any;
      return Response.json({ result: await s.handle(action, args, caller) });
    } catch (e) { return Response.json({ error: (e as Error).message }, { status: 403 }); }
  } });
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp-server"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME, DORI_CONTEXT: contextFile, DORI_CONFIG: configFile, DORI_STATE_DIR: config.stateDir } });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ...[{ action: "status", args: { key: "worker" } }, { action: "report", args: { key: "worker", kind: "milestone", text: "scoped", eventId: "mcp" } },
        { action: "launch", args: { key: "other" } }, { action: "report", args: { key: "other", kind: "milestone", text: "bad", eventId: "bad" } }]
        .map((arguments_, i) => ({ jsonrpc: "2.0", id: i + 3, method: "tools/call", params: { name: "control", arguments: arguments_ } })),
    ];
    child.stdin.write(messages.map(x => JSON.stringify(x)).join("\n") + "\n"); child.stdin.end();
    const stdout = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    const responses = stdout.trim().split("\n").map(line => JSON.parse(line));
    const byId = (id: number) => responses.find(x => x.id === id).result;
    expect(byId(1).protocolVersion).toBe("2024-11-05"); expect(byId(2).tools[0].name).toBe("control");
    expect(byId(3).isError).toBe(false); expect(byId(4).isError).toBe(false);
    expect(byId(5).isError).toBe(true); expect(byId(6).isError).toBe(true);
    expect((await s.registry.read("worker"))?.report?.text).toBe("scoped");
  } finally { server.stop(true); f.cleanup(); }
});
