import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, parseConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { DoriService } from "../src/service.ts";
import { hostSocket } from "../src/ipc.ts";
import { bootstrapPath } from "../src/runtime/session-host.ts";
import { ompManagedEnvironment, ompProfileEnvironment, ompPaneCommand, ompVersionMatches, verifyOmpHerdr, discoverOmpSafe, waitForOmpDetach, stopOmpManagedProcess } from "../src/runtime/omp/integration.ts";
import { payloadHash } from "../src/runtime/omp/contract.ts";
import { readWatchTarget, DeliveryWatchdog } from "../src/watchdog.ts";
import { ompFixture } from "./fixtures/omp.ts";
import type { Runner } from "../src/run.ts";
import { run } from "../src/run.ts";
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
test("OMP version preflight accepts native CLI version format but rejects another version or noisy output", () => {
  for (const output of ["18.15.0", "omp 18.15.0", "omp/18.15.0\n"]) expect(ompVersionMatches(output, "18.15.0")).toBe(true);
  for (const output of ["omp/18.15.1", "other/18.15.0", "omp/18.15.0\nunverified", "omp/118.15.0"]) expect(ompVersionMatches(output, "18.15.0")).toBe(false);
});
test("OMP stop waits for delayed Herdr detach and does not wait for unrelated sessions", async () => {
  let attached = true, finished = false, observed!: () => void;
  const queried = new Promise<void>(resolve => { observed = resolve; });
  const runner: Runner = async () => {
    observed();
    return { code: 0, err: "", out: JSON.stringify({ result: { agents: [
      { agent: "omp", agent_session: { value: attached ? "/exact.jsonl" : "/unrelated.jsonl" } }
    ] } }) };
  };
  const stopping = waitForOmpDetach("/exact.jsonl", Date.now() + 1000, runner).then(() => { finished = true; });
  await queried; await Bun.sleep(10); expect(finished).toBe(false);
  attached = false; await stopping; expect(finished).toBe(true);
});
test("OMP stop remains unconfirmed when Herdr still reports the native session or cannot verify it", async () => {
  const runner: Runner = async () => ({ code: 0, err: "", out: JSON.stringify({ result: { agents: [{ agent: "omp", agent_session: { value: "/exact.jsonl" } }] } }) });
  await expect(waitForOmpDetach("/exact.jsonl", Date.now() + 60, runner)).rejects.toThrow("still present");
  await expect(waitForOmpDetach("/exact.jsonl", Date.now() + 1000, async () => ({ code: 1, out: "", err: "unavailable" }))).rejects.toThrow("unverified");
  for (const agents of [[null], [{}], [{ agent: "omp" }], [{ agent: "omp", agent_session: { value: 42 } }]]) {
    await expect(waitForOmpDetach("/exact.jsonl", Date.now() + 1000, async () => ({ code: 0, err: "", out: JSON.stringify({ result: { agents } }) }))).rejects.toThrow("unverified");
  }
});
test("OMP stop retry reaps an exited native process without resending to its vanished controller", async () => {
  const f = ompFixture(), config = profile(f.directory);
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  let stops = 0, detached = false, invalid = true;
  await f.serve(async request => {
    if (request.method === "inspect") return { protocol: 1, id: request.id, identity: f.identity, result: f.snapshot };
    if (request.method !== "stop") throw new Error("Only one stop permitted");
    stops++; child.kill("SIGTERM"); await child.exited; detached = true;
    return { protocol: 1, id: request.id, identity: f.identity, result: { stopping: true } };
  });
  const runner: Runner = async argv => detached
    ? { code: 0, err: "", out: JSON.stringify({ result: { agents: invalid ? [{ agent: "omp" }] : [] } }) }
    : association(f)(argv);
  try {
    await expect(stopOmpManagedProcess(f.target, child.pid, config, runner)).rejects.toThrow("unverified");
    expect(stops).toBe(1);
    invalid = false;
    await stopOmpManagedProcess(f.target, child.pid, config, runner);
    expect(stops).toBe(1);
    await expect(stopOmpManagedProcess(f.target, undefined, config, runner)).rejects.toThrow("exit cannot be verified");
  } finally { child.kill(); await child.exited; f.cleanup(); }
});
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
test("OMP version preflight resolves the service Bun ahead of ambient PATH in the exact isolated profile", async () => {
  const f = ompFixture();
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const bin = join(f.directory, "ambient-bin"); mkdirSync(bin);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho WRONG_AMBIENT_BUN\nexit 41\n", { mode: 0o700 });
    const wrapper = join(f.directory, "omp-wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec bun -e \'console.log(JSON.stringify({bun:process.versions.bun,profile:process.env.PI_CODING_AGENT_DIR,leaked:!!process.env.DORI_CONTEXT}))\'\n', { mode: 0o700 });
    const env = ompProfileEnvironment(join(f.directory, "isolated-agent"), { PATH: `${bin}:/usr/bin:/bin`, DORI_CONTEXT: "must-not-inherit" });
    const result = await run([wrapper, "--version"], { env });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ bun: process.versions.bun, profile: join(f.directory, "isolated-agent"), leaked: false });
  } finally { f.cleanup(); }
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
    const input = { key: "lead", text: "work", operationId: "one" };
    const first = await x.s.handle("input", input, { role: "admin" });
    expect(first).toMatchObject({ receiptKind: "omp-session-entry", receipt: { entryId: "one" } });
    expect(await x.s.handle("input", input, { role: "admin" })).toEqual(first);
    expect(inputs).toBe(1);
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
test("scoped receipt lookup reconciles a lost native ACK while busy without submitting again", async () => {
  let inputs = 0, received = false;
  const x = await setup((method, p) => {
    if (method === "input") { inputs++; throw new Error("lost native ACK"); }
    if (method === "operation") return received ? { status: "received", receipt: receipt(x.f, p.operationId, "original") } : { status: "absent" };
    throw new Error("Unexpected mutation");
  });
  try {
    const attached = await x.s.handle("lead-activate", x.args, { role: "admin" });
    const caller = { role: "lead" as const, key: "lead", instance: attached.lead.runtime.hostInstanceId };
    const args = { key: "lead", text: "original", operationId: "lost-native" };
    expect(await x.s.handle("input-status", args, caller)).toEqual({ status: "missing", operationId: args.operationId });
    await expect(x.s.handle("input", args, caller)).rejects.toThrow();
    const restarted = new DoriService(x.config, x.runner);
    expect(await restarted.handle("input-status", args, caller)).toEqual({ status: "unknown", operationId: args.operationId });
    x.f.snapshot.state = "running"; received = true;
    expect(await restarted.handle("input-status", args, caller)).toMatchObject({ status: "received", receiptKind: "omp-session-entry", receipt: receipt(x.f, args.operationId, args.text) });
    expect(await restarted.handle("input-status", args, caller)).toMatchObject({ status: "received" });
    expect(inputs).toBe(1);
    await expect(restarted.handle("input-status", { ...args, text: "changed" }, caller)).rejects.toThrow("mismatch");
    await expect(restarted.handle("input-status", args, { role: "lane", key: "worker" })).rejects.toThrow("capability");
    await restarted.handle("lead-detach", { threadId: x.args.threadId }, caller);
    await expect(restarted.handle("input-status", args, caller)).rejects.toThrow();
  } finally { x.f.cleanup(); }
});
test("scoped queued receipt lookup does not start input and native held or unavailable input is not ready", async () => {
  let mutations = 0;
  const x = await setup(() => { mutations++; throw new Error("No native input permitted"); });
  try {
    const attached = await x.s.handle("lead-activate", x.args, { role: "admin" });
    const caller = { role: "lead" as const, key: "lead", instance: attached.lead.runtime.hostInstanceId };
    const args = { key: "lead", text: "queued", operationId: "queued-native" };
    expect((await x.s.handle("status", { key: "lead" }, caller)).inputReady).toBe(true);
    x.f.snapshot.held = true;
    expect(await x.s.handle("status", { key: "lead" }, caller)).toMatchObject({ inputReady: false, readiness: "busy" });
    x.f.snapshot.held = false; x.f.snapshot.capabilities.input = false;
    expect((await x.s.handle("status", { key: "lead" }, caller)).inputReady).toBe(false);
    x.f.snapshot.capabilities.input = true; x.f.snapshot.goal = { status: "paused", objective: "saved goal", tokenBudget: null };
    expect((await x.s.handle("status", { key: "lead" }, caller)).inputReady).toBe(false);
    await x.s.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true }));
    expect(await x.s.handle("input", args, caller)).toMatchObject({ queued: true });
    expect(await x.s.handle("input-status", args, caller)).toEqual({ status: "queued", operationId: args.operationId });
    expect(mutations).toBe(0);
  } finally { x.f.cleanup(); }
});
test("activated bridge exposes JSON receipt lookup through its real scoped CLI", async () => {
  let inputs = 0;
  const x = await setup((method, p) => {
    if (method === "input") { inputs++; return { receipt: receipt(x.f, p.operationId, p.text) }; }
    if (method === "operation") return { status: "received", receipt: receipt(x.f, p.operationId, "bridge message") };
    throw new Error("Unexpected mutation");
  });
  const { serviceSocket } = await import("../src/ipc.ts");
  atomicJson(join(x.config.stateDir, "control.json"), { token: "fixture-admin" });
  const server = Bun.serve({ unix: serviceSocket(x.config.stateDir), async fetch(request) {
    try {
      const caller = await x.s.authorize(request.headers.get("authorization")!.replace("Bearer ", ""));
      const { action, args } = await request.json() as any;
      return Response.json({ result: await x.s.handle(action, args, caller) });
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }); }
  } });
  try {
    const attached = await x.s.handle("lead-activate", x.args, { role: "admin" });
    const textFile = join(x.f.directory, "message.txt"); await Bun.write(textFile, "bridge message");
    const call = async (...args: string[]) => {
      const child = Bun.spawn([attached.bridge, ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code) throw new Error(err);
      return JSON.parse(out);
    };
    expect(await call("status", "lead")).toMatchObject({ identityVerified: true, inputReady: true, bridge: attached.bridge });
    const args = ["lead", "--text-file", textFile, "--operation-id", "bridge-receipt"];
    expect(await call("input-status", ...args)).toMatchObject({ status: "missing" });
    expect(await call("input", ...args)).toMatchObject({ receiptKind: "omp-session-entry" });
    expect(await call("input-status", ...args)).toMatchObject({ status: "received", receiptKind: "omp-session-entry" });
    expect(inputs).toBe(1);
  } finally { server.stop(true); x.f.cleanup(); }
});
for (const change of ["generation", "row"] as const) {
  test(`scoped delayed receipt lookup refuses ${change} mutation before commit`, async () => {
    let started!: () => void, finish!: () => void;
    const queried = new Promise<void>(resolve => { started = resolve; }), response = new Promise<void>(resolve => { finish = resolve; });
    const x = await setup(async (method, params) => {
      if (method !== "operation") throw new Error("No input allowed");
      started(); await response; return { status: "received", receipt: receipt(x.f, params.operationId, "work") };
    });
    try {
      const attached = await x.s.handle("lead-activate", x.args, { role: "admin" }), runtime = attached.lead.runtime;
      const caller = { role: "lead" as const, key: "lead", instance: runtime.hostInstanceId };
      x.s.inbox.put({ id: "scoped-delayed", target: "lead", text: "work", state: "unknown", at: new Date().toISOString(), attachmentInstance: runtime.hostInstanceId,
        ompProvenance: { target: runtime.omp.target, attachmentInstanceId: runtime.hostInstanceId, attachmentGeneration: runtime.generation } });
      const rejected = expect(x.s.handle("input-status", { key: "lead", text: "work", operationId: "scoped-delayed" }, caller)).rejects.toThrow();
      await queried;
      if (change === "generation") await x.s.registry.update("lead", lane => ({ ...lane, runtime: { ...lane.runtime!, generation: lane.runtime!.generation + 1 } }));
      else x.s.inbox.mark("scoped-delayed", { source: "concurrent-reconciliation" });
      finish(); await rejected;
      expect(x.s.inbox.get("scoped-delayed")?.state).toBe("unknown");
    } finally { finish?.(); x.f.cleanup(); }
  });
}
test("OMP terminal notices survive host restart and do not rebind or become approval messages", async () => {
  const f = ompFixture(), config = profile(f.directory), runner = association(f);
  let service = new DoriService(config, runner);
  const streamId = crypto.randomUUID();
  const runtime = (instance: string, generation: number) => ({ kind: "omp" as const, backend: "herdr-tui" as const, threadId: f.identity.sessionId,
    state: "idle" as const, hostInstanceId: instance, generation, binaryVersion: f.identity.runtimeVersion,
    omp: { kind: "omp" as const, target: f.target, attachmentInstanceId: instance, attachmentGeneration: generation, attachedAt: new Date().toISOString(), excludedInboxIds: [] } });
  const event = (sequence: number) => ({ method: "runtime/failure", params: { runtime: "omp", streamId, sessionId: f.identity.sessionId, sessionFile: f.identity.sessionFile, laneKey: "worker",
    failure: { sequence, failureId: `omp-failure:${streamId}:${sequence}`, sourceInstanceId: f.identity.instanceId, sourceGeneration: 1,
      executionId: `run:${sequence}`, phase: "model", category: "authentication", observedAt: "2026-11-02T00:00:00.000Z" } } });
  const send = (sequence: number, instance = "host1", generation = 1, payload = event(sequence)) => service.handle("host-event",
    { key: "worker", instance, runtime: runtime(instance, generation), event: payload }, { role: "host", key: "worker" });
  try {
    await service.registry.write({ key: "worker", role: "lane", title: "Worker", thread: "slack:root", brief: "", done: "", cwd: f.directory, pane: f.identity.paneId,
      openedAt: new Date().toISOString(), runtime: runtime("host1", 1) });
    atomicJson(join(config.stateDir, "attachments/lead.json"), { instance: "lead-before" });
    await send(1); await send(2);
    expect(service.failures.list()).toHaveLength(2);
    expect(service.outbox.list()).toHaveLength(0);
    expect(service.inbox.list()).toHaveLength(0);
    // Simulate crash after durable service ACK but before the host cursor fsync.
    service = new DoriService(config, runner);
    await service.registry.update("worker", lane => ({ ...lane, runtime: runtime("host2", 2) }));
    atomicJson(join(config.stateDir, "attachments/lead.json"), { instance: "lead-after" });
    await send(1, "host2", 2); await send(2, "host2", 2); await service.notifyFailures();
    expect(service.failures.list()).toHaveLength(2); expect(service.inbox.list()).toHaveLength(2);
    for (const notice of service.inbox.list()) {
      expect(notice).toMatchObject({ target: "lead", attachmentInstance: "lead-before", thread: "slack:root" });
      expect(notice.text).toContain("OMP model failed (authentication)");
      expect(notice.text).not.toContain("Codex");
    }
    const changed = event(1); changed.params.failure.category = "runtime";
    await expect(send(1, "host2", 2, changed)).rejects.toThrow("different content");
    const crossSession = event(3); crossSession.params.sessionId = crypto.randomUUID();
    await expect(send(3, "host2", 2, crossSession)).rejects.toThrow("identity");
    const raw = event(3) as any; raw.params.failure.error = "Authorization: sk-never-store";
    await expect(send(3, "host2", 2, raw)).rejects.toThrow("identity");
    expect(JSON.stringify(service.failures.list())).not.toContain("sk-never-store");
  } finally { f.cleanup(); }
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

 test("OMP arbitrary adoption is refused before creating a Codex-shaped runtime", async () => {
  const f = ompFixture(), s = new DoriService(profile(f.directory), association(f));
  try {
    const { adoptLane } = await import("../src/launch.ts");
    await expect(adoptLane(s.deps, { key: "adopted", title: "outside bootstrap", brief: "/b", done: "closed a/b#1", pane: "w:p", threadId: f.identity.sessionId })).rejects.toThrow("OMP adopt is unsupported");
    expect(await s.registry.read("adopted")).toBeNull();
  } finally { f.cleanup(); }
});

test("watchdog routing fence covers asynchronous native input through its bounded receipt", async () => {
  let started!: () => void, finish!: () => void;
  const submitting = new Promise<void>(r => { started = r; }), blocked = new Promise<void>(r => { finish = r; });
  let operationId = "", text = "";
  const x = await setup(async (method, p) => {
    if (method === "operation") return { status: "absent" };
    operationId = p.operationId; text = p.text; started(); await blocked;
    return { receipt: receipt(x.f, p.operationId, p.text) };
  });
  const { acquireFileFence } = await import("../src/binding-fence.ts");
  try {
    await x.s.handle("lead-activate", x.args, { role: "admin" });
    const w = new DeliveryWatchdog(x.config, { graceMs: 0, timeoutMs: 2000, runner: x.runner, health: async () => { throw new Error("service unavailable"); } });
    const poll = w.poll(); await submitting;
    // This is a separate kernel-lock claimant, not a timing assertion about JS
    // promise creation. The old implementation released before native input.
    await expect(acquireFileFence(join(x.config.stateDir, "binding-fence.lock"), 0)).rejects.toThrow();
    const state = JSON.parse(await Bun.file(join(x.config.stateDir, "watchdog/state.json")).text());
    expect(state.incidents[0]).toMatchObject({ id: operationId, notification: "unknown", text });
    const detach = x.s.handle("lead-detach", { threadId: x.args.threadId }, { role: "admin" });
    finish(); expect((await poll).incidents[0]?.notification).toBe("sent"); await detach;
    expect(x.s.inbox.list()).toHaveLength(0);
  } finally { finish?.(); x.f.cleanup(); }
});

test("current scoped lead reconciles a managed lost ACK before releasing the held original native session", async () => {
  const lead = await setup(), f = ompFixture(), config = lead.config;
  const runner: Runner = async argv => {
    const a = await association(lead.f)(argv), b = await association(f)(argv);
    return { code: 0, err: "", out: JSON.stringify({ result: { agents: [...JSON.parse(a.out).result.agents, ...JSON.parse(b.out).result.agents] } }) };
  };
  const s = new DoriService(config, runner);
  const attached = await s.handle("lead-activate", lead.args, { role: "admin" });
  const caller = { role: "lead" as const, key: "lead", instance: attached.lead.runtime.hostInstanceId };
  let inputs = 0, releases = 0, received = false;
  const receiptGate = Promise.withResolvers<void>(), receiptRequested = Promise.withResolvers<void>();
  await f.serve(async r => {
    if (r.method === "operation" && r.params.operationId === "revoked-scope") { receiptRequested.resolve(); await receiptGate.promise; }
    return { protocol: 1, id: r.id, identity: f.identity, result: r.method === "inspect" ? f.snapshot : received ? { status: "received", receipt: receipt(f, r.params.operationId, "work") } : { status: "absent" } };
  });
  const native = { kind: "omp" as const, target: f.target, attachmentInstanceId: "H1", attachmentGeneration: 1, attachedAt: new Date().toISOString(), excludedInboxIds: [] };
  await s.registry.write({ key: "worker", role: "lane", title: "worker", thread: "none", brief: "/b", done: "closed a/b#1", cwd: f.directory, pane: f.identity.paneId, openedAt: new Date().toISOString(), runtime: {
    kind: "omp", backend: "herdr-tui", threadId: f.identity.sessionId, state: "idle", hostInstanceId: "H1", generation: 1, binaryVersion: "18.15.0", omp: native } });
  atomicJson(bootstrapPath(config.stateDir, "worker"), { hostToken: "host", laneToken: "lane", instance: "H1", role: "lane" });
  const server = Bun.serve({ unix: hostSocket(config.stateDir, "worker"), async fetch(req) {
    const { action } = await req.json() as any;
    if (action === "input") { inputs++; return Response.json({ error: "lost receipt" }, { status: 409 }); }
    if (action === "release") releases++;
    return Response.json({ result: { threadId: f.identity.sessionId, state: "idle", goal: null } });
  } });
  try {
    await expect(s.handle("input", { key: "worker", text: "work", operationId: "lost-host" }, { role: "admin" })).rejects.toThrow();
    const original = structuredClone(s.inbox.get("lost-host")!);
    expect(original).toMatchObject({ state: "unknown", attachmentInstance: "H1", ompProvenance: { target: f.target, attachmentInstanceId: "H1", attachmentGeneration: 1 } });
    await s.registry.update("worker", lane => ({ ...lane, dispatchBlocked: true, holdReason: "recovery", runtime: { ...lane.runtime!, hostInstanceId: "H2", generation: 2, omp: { ...native, attachmentInstanceId: "H2", attachmentGeneration: 2 } } }));
    atomicJson(bootstrapPath(config.stateDir, "worker"), { hostToken: "host", laneToken: "lane", instance: "H2", role: "lane" });
    const restarted = new DoriService(config, runner);
    await expect(restarted.deps.runtime.release("worker", "user")).rejects.toThrow("unresolved operation fence"); expect(releases).toBe(0);
    const args = { box: "inbox", id: "lost-host", state: "sent", evidence: "exact native receipt" };
    await expect(restarted.handle("mail-resolve", { ...args, state: "queued" }, caller)).rejects.toThrow();
    await expect(restarted.handle("mail-resolve", { ...args, box: "outbox" }, caller)).rejects.toThrow();
    await expect(restarted.handle("mail-resolve", args, { role: "lane", key: "worker" })).rejects.toThrow("capability");
    await expect(restarted.handle("mail-resolve", args, caller)).rejects.toThrow("receipt unavailable");
    expect(restarted.inbox.get("lost-host")).toEqual(original);
    received = true;
    const result = await restarted.handle("mail-resolve", args, caller);
    expect(result).toMatchObject({ state: "sent", attachmentInstance: "H1", ompProvenance: original.ompProvenance });
    await restarted.deps.runtime.release("worker", "user"); expect(releases).toBe(1); expect(inputs).toBe(1);
    restarted.inbox.put({ id: "legacy-unknown", target: "worker", text: "no recorded native evidence", state: "unknown", attachmentInstance: "H1", at: new Date().toISOString() });
    await expect(restarted.deps.runtime.release("worker", "user")).rejects.toThrow("unresolved operation fence");
    await expect(restarted.handle("mail-resolve", { box: "inbox", id: "legacy-unknown", state: "sent", evidence: "operator" }, caller)).rejects.toThrow("provenance missing");
    restarted.inbox.put({ ...original, id: "revoked-scope" });
    const rejected = expect(restarted.handle("mail-resolve", { ...args, id: "revoked-scope" }, caller)).rejects.toThrow();
    await receiptRequested.promise;
    await restarted.handle("lead-detach", { threadId: lead.args.threadId }, caller);
    receiptGate.resolve(); await rejected;
    expect(restarted.inbox.get("revoked-scope")?.state).toBe("unknown");
  } finally { receiptGate.resolve(); server.stop(true); f.cleanup(); lead.f.cleanup(); }
});

for (const change of ["detach", "prepared-handoff", "committed-handoff", "stopped", "native-generation", "row"] as const) {
  test(`delayed OMP receipt reconciliation rejects ${change} before fenced finalization`, async () => {
    let queryStarted!: () => void, finish!: () => void;
    const queried = new Promise<void>(r => { queryStarted = r; }), response = new Promise<void>(r => { finish = r; });
    const x = await setup(async (method, p) => { if (method !== "operation") throw new Error("No input authorized"); queryStarted(); await response; return { status: "received", receipt: receipt(x.f, p.operationId, "work") }; });
    try {
      await x.s.handle("lead-activate", x.args, { role: "admin" });
      const lane = (await x.s.registry.read("lead"))!, runtime = lane.runtime!;
      x.s.inbox.put({ id: "delayed", target: "lead", text: "work", state: "unknown", at: new Date().toISOString(), attachmentInstance: runtime.hostInstanceId,
        ompProvenance: { target: runtime.omp!.target, attachmentInstanceId: runtime.hostInstanceId, attachmentGeneration: runtime.generation } });
      const resolving = x.s.handle("mail-resolve", { box: "inbox", id: "delayed", state: "sent", evidence: "receipt" }, { role: "admin" });
      // Attach rejection handler before opening the response gate.
      const rejected = expect(resolving).rejects.toThrow(); await queried;
      if (change === "detach") await x.s.handle("lead-detach", { threadId: x.args.threadId }, { role: "admin" });
      else if (change.endsWith("handoff")) {
        const id = `pending-${change}`;
        atomicJson(join(x.config.stateDir, "attachments/handoffs", `${createHash("sha256").update(id).digest("hex")}.json`), { status: change === "prepared-handoff" ? "prepared" : "committed", args: { operationId: id } });
        atomicJson(join(x.config.stateDir, "attachments/handoff.json"), { operationId: id });
        if (change === "committed-handoff") await x.s.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, hostInstanceId: "replacement", generation: l.runtime!.generation + 1 } }));
      } else if (change === "stopped") await x.s.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, state: "stopped" } }));
      else if (change === "native-generation") await x.s.registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, omp: { ...l.runtime!.omp!, target: { ...l.runtime!.omp!.target, generation: 2 } } } }));
      else x.s.inbox.mark("delayed", { source: "changed-during-query" });
      finish(); await rejected; expect(x.s.inbox.get("delayed")?.state).toBe("unknown");
    } finally { finish?.(); x.f.cleanup(); }
  });
}

test("SIGKILL OMP host recovery removes only its stale socket and reconnects the same native controller", async () => {
  const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
  const { ipc, serviceSocket } = await import("../src/ipc.ts");
  const f = ompFixture(), config = profile(f.directory), s = new DoriService(config, association(f));
  config.runtime.rpcTimeoutMs = 1000; config.runtime.heartbeatIntervalMs = 20; config.runtime.heartbeatTimeoutMs = 500;
  f.transcript([]); f.snapshot.effort = "medium";
  let inputs = 0;
  await f.serve(r => {
    if (r.method === "hold") f.snapshot.held = true;
    if (r.method === "input") inputs++;
    return { protocol: 1, id: r.id, identity: f.identity, result: f.snapshot };
  });
  atomicJson(join(f.directory, `${createHash("sha256").update("instance:1").digest("hex")}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
  const checkpoint = join(config.stateDir, "hosts/worker.runtime.json");
  atomicJson(checkpoint, { threadId: f.identity.sessionId, target: f.target, held: true, pid: process.pid });
  const fakeBin = join(f.directory, "bin"), log = join(f.directory, "herdr-calls"); mkdirSync(fakeBin);
  const agents = join(f.directory, "agents.json"), pane = join(f.directory, "pane.json");
  atomicJson(agents, JSON.parse((await association(f)(["herdr", "agent", "list"])).out));
  atomicJson(pane, { result: { pane: { pane_id: f.identity.paneId, terminal_id: f.identity.terminalId, tab_id: "w1:t1", workspace_id: "w1", agent: "omp" } } });
  writeFileSync(join(fakeBin, "herdr"), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2" = "agent list" ]; then exec /bin/cat '${agents}'; fi\nif [ "$1 $2" = "pane get" ]; then exec /bin/cat '${pane}'; fi\nexit 79\n`, { mode: 0o700 });
  config.runtime.binary = join(fakeBin, "omp"); writeFileSync(config.runtime.binary, "#!/bin/sh\necho 18.15.0\n", { mode: 0o700 });
  const registered = new Map<string, () => void>();
  const service = Bun.serve({ unix: serviceSocket(config.stateDir), async fetch(request) {
    try {
      const { action, args } = await request.json() as any;
      const result = await s.handle(action, args, { role: "host", key: "worker" });
      if (action === "host-register") registered.get(args.instance)?.();
      return Response.json({ result });
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }); }
  } });
  const spawnHost = async (instance: string, generation: number) => {
    const token = `host-${instance}`;
    const runtime = { kind: "omp" as const, backend: "herdr-tui" as const, threadId: f.identity.sessionId, state: "starting" as const, hostInstanceId: instance, generation, binaryVersion: "18.15.0" };
    const existing = await s.registry.read("worker");
    if (existing) await s.registry.update("worker", l => ({ ...l, runtime }));
    else await s.registry.write({ key: "worker", role: "lane", title: "worker", thread: "none", brief: "/b", done: "closed a/b#1", cwd: f.directory, pane: f.identity.paneId, openedAt: new Date().toISOString(), runtime });
    atomicJson(bootstrapPath(config.stateDir, "worker"), { key: "worker", role: "lane", instance, generation, hostToken: token, laneToken: "lane", cwd: f.directory, pane: f.identity.paneId, threadId: f.identity.sessionId, model: "test", blocked: true, config });
    const ready = new Promise<void>(resolve => registered.set(instance, resolve));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "session-host", "--state-dir", config.stateDir, "--key", "worker"], {
      cwd: f.directory, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { HOME: process.env.HOME, PATH: `${fakeBin}:${process.env.PATH}` } });
    try { await Promise.race([ready, child.exited.then(async code => { throw new Error(`Host exited ${code}: ${await new Response(child.stderr).text()}`); }), Bun.sleep(3000).then(() => { throw new Error("Host startup timed out"); })]); }
    catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
    return { child, token };
  };
  let second: Awaited<ReturnType<typeof spawnHost>> | undefined;
  try {
    const first = await spawnHost("H1", 1);
    expect(await ipc(hostSocket(config.stateDir, "worker"), first.token, "inspect")).toMatchObject({ threadId: f.identity.sessionId });
    first.child.kill("SIGKILL"); await first.child.exited;
    expect(existsSync(hostSocket(config.stateDir, "worker"))).toBe(true);
    second = await spawnHost("H2", 2);
    expect(await ipc(hostSocket(config.stateDir, "worker"), second.token, "inspect")).toMatchObject({ threadId: f.identity.sessionId });
    expect((await s.registry.read("worker"))?.runtime?.omp?.target).toEqual(f.target);
    expect(readFileSync(log, "utf8")).not.toContain("pane run"); expect(inputs).toBe(0);
  } finally {
    if (second) { second.child.kill("SIGTERM"); await second.child.exited; }
    service.stop(true); f.cleanup();
  }
}, 10000);

test("stale-host cleanup refuses a live foreign replacement even with dead old-owner metadata", async () => {
  const { lstatSync } = await import("node:fs");
  const { ompHostOwnerPath, prepareOmpHostSocket } = await import("../src/runtime/omp/integration.ts");
  const f = ompFixture(), config = profile(f.directory), socket = hostSocket(config.stateDir, "worker");
  const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }); await dead.exited;
  const replacement = Bun.serve({ unix: socket, fetch() { return Response.json({ error: "foreign owner" }, { status: 403 }); } });
  try {
    const before = lstatSync(socket);
    atomicJson(ompHostOwnerPath(config.stateDir, "worker"), { pid: dead.pid, instance: "old" });
    await expect(prepareOmpHostSocket(config.stateDir, { key: "worker", instance: "new", generation: 2 })).rejects.toThrow("existing OMP host");
    expect(lstatSync(socket).ino).toBe(before.ino);
    atomicJson(ompHostOwnerPath(config.stateDir, "worker"), { pid: process.pid, instance: "live" });
    await expect(prepareOmpHostSocket(config.stateDir, { key: "worker", instance: "new", generation: 2 })).rejects.toThrow("prior death unverified");
    expect(lstatSync(socket).ino).toBe(before.ino);
  } finally { replacement.stop(true); f.cleanup(); }
});

test("public host-only recover retains the exact live OMP pane without creating another tab", async () => {
  const f = ompFixture(), s = new DoriService(profile(f.directory), association(f));
  await f.serve(r => ({ protocol: 1, id: r.id, identity: f.identity, result: f.snapshot }));
  const native = { kind: "omp" as const, target: f.target, attachmentInstanceId: "H1", attachmentGeneration: 1, attachedAt: new Date().toISOString(), excludedInboxIds: [] };
  try {
    await s.registry.write({ key: "worker", role: "lane", title: "worker", thread: "none", brief: "/b", done: "closed a/b#1", cwd: f.directory, pane: f.identity.paneId, tab: "original-tab", openedAt: new Date().toISOString(), runtime: {
      kind: "omp", backend: "herdr-tui", threadId: f.identity.sessionId, state: "idle", hostInstanceId: "H1", generation: 1, binaryVersion: "18.15.0", omp: native } });
    let boots = 0;
    s.boot = async lane => { boots++; expect(lane.pane).toBe(f.identity.paneId); expect(lane.tab).toBe("original-tab"); expect(lane.runtime?.omp?.target).toEqual(f.target); };
    expect(await s.handle("recover", { key: "worker" }, { role: "admin" })).toMatchObject({ recovering: true }); expect(boots).toBe(1);
  } finally { f.cleanup(); }
});
