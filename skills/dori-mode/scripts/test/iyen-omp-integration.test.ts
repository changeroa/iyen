import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, parseConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { DoriService } from "../src/service.ts";
import { ompProfileEnvironment, ompVersionMatches, verifyOmpHerdr, discoverOmpSafe } from "../src/runtime/omp-integration.ts";
import { payloadHash, type NativeUserInteraction, type NativeInteractionStatus } from "../src/runtime/omp/contract.ts";
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
test("OMP watchdog attempts once after durable unknown and never uses Codex observer", async () => {
  let inputs = 0; const x = await setup(method => { if (method === "operation") return { status: "absent" }; inputs++; throw new Error("unknown"); });
  try { await x.s.handle("lead-activate", x.args, { role: "admin" }); let now = 1000;
    const w = new DeliveryWatchdog(x.config, { now: () => now, graceMs: 0, timeoutMs: 100, runner: x.runner, health: async () => { throw new Error("down"); }, observe: async () => { throw new Error("Codex observer prohibited"); } });
    expect((await w.poll()).incidents[0]?.notification).toBe("unknown"); now++; expect((await w.poll()).incidents[0]?.notification).toBe("unknown"); expect(inputs).toBe(1);
  } finally { x.f.cleanup(); }
});

 test("OMP arbitrary adoption is refused before creating a Codex-shaped runtime", async () => {
  const f = ompFixture(), s = new DoriService(profile(f.directory), association(f));
  try {
    const { adoptLane } = await import("../src/launch.ts");
    await expect(adoptLane(s.deps, { key: "adopted", title: "outside bootstrap", brief: "/b", done: "closed a/b#1", pane: "w:p", threadId: f.identity.sessionId })).rejects.toThrow("OMP lanes were removed");
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

test("current lead resolves native ask from a naturally delivered authenticated owner source, never an arbitrary source ID", async () => {
  let request!: NativeUserInteraction, submissions = 0, applied: NativeInteractionStatus | undefined;
  const x = await setup(async (method, params) => {
    if (method === "input") return { receipt: receipt(x.f, params.operationId, params.text) };
    if (method === "interactions") return [request];
    if (method === "interaction-respond") {
      submissions++;
      applied = { status: "applied", operationId: params.operationId, requestId: request.id, responseHash: payloadHash(JSON.stringify(params.response)) };
      return applied;
    }
    if (method === "interaction-response-status") return applied ?? { status: "missing", operationId: params.operationId };
    throw new Error("Unexpected native mutation");
  });
  try {
    x.config.ingress.push({ id: "owner", command: ["fixture"], owners: ["victor"] });
    const attached = await x.s.handle("lead-activate", x.args, { role: "admin" });
    const caller = { role: "lead" as const, key: "lead", instance: attached.lead.runtime.hostInstanceId };
    const deliver = async (id: string, text: string, thread = "chat:original") => {
      const event = { id, text, thread, user: "victor", metadata: { sourceMessage: id } };
      await x.s.receive("owner", event);
      const mail = x.s.inbox.get(`inbound:owner:${thread}:${id}`)!;
      await x.s.deps.runtime.input("lead", mail.text, mail.id);
      return mail.id;
    };
    const initiating = await deliver("owner-task", "질문해줘");
    request = { id: "native-question", sessionId: x.f.identity.sessionId, kind: "ask", title: "Choice", createdAt: new Date(Date.now() - 1000).toISOString(),
      sourceOperationHash: payloadHash(initiating), questions: [{ id: "choice", question: "Which one?", options: [{ label: "first" }, { label: "second" }] }] };
    await x.s.nativeInteractions.poll();
    const token = x.s.nativeInteractions.list()[0]!.token;
    const response = { kind: "submit", answers: [{ id: "choice", selectedOptions: ["first"] }] };
    await expect(x.s.handle("approval-respond", { id: token, response }, caller)).rejects.toThrow();
    await expect(x.s.handle("approval-respond", { id: token, response, sourceMessageId: "invented-source" }, caller)).rejects.toThrow();
    await deliver("other-thread", "1", "chat:other");
    await expect(x.s.handle("approval-respond", { id: token, response, sourceMessageId: "other-thread" }, caller)).rejects.toThrow();
    expect(submissions).toBe(0);
    await deliver("natural-answer", "1");
    const args = { id: token, response, sourceMessageId: "natural-answer" };
    await expect(x.s.handle("approval-respond", args, { ...caller, instance: "revoked-instance" })).rejects.toThrow();
    const result = await x.s.handle("approval-respond", args, caller);
    expect(result).toMatchObject({ status: "applied", requestId: request.id, responseHash: payloadHash(JSON.stringify(response)) });
    expect(await x.s.handle("approval-respond", args, caller)).toEqual(result);
    await expect(x.s.handle("approval-respond", { ...args, response: { kind: "submit", answers: [{ id: "choice", selectedOptions: ["second"] }] } }, caller)).rejects.toThrow();
    expect(submissions).toBe(1);
    expect(x.s.inbox.get("inbound:owner:chat:original:natural-answer")).toMatchObject({ target: "lead", state: "sent", sourceMessageId: "natural-answer", ownerUser: "victor", metadata: { sourceMessage: "natural-answer" } });
  } finally { x.f.cleanup(); }
});
