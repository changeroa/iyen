import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { identityOf, parseRequest, payloadHash, type OmpLaunchMetadata, type LeadRestartBootstrap, type LeadRestartIntent, type LeadRestartStatus, type OmpTarget } from "../src/runtime/omp/contract.ts";
import { OmpControlServer, type OmpContext, type OmpExecutionHoldState } from "../src/runtime/omp/server.ts";
import { prepareLeadRestart } from "../src/runtime/omp/lead-restart.ts";
import type { DoriConfig } from "../src/config.ts";
import { ompFixture } from "./fixtures/omp.ts";

const launchMetadata: OmpLaunchMetadata = { agentDir: "/fixture/borrowed-lead-agent", settingsHome: "/fixture/borrowed-lead-agent",
  approvalMode: "yolo", provider: "fixture", model: "gpt-fixture", effort: "medium" };
const intent: LeadRestartIntent = { operationId: "owner-restart", authorizationHash: "a".repeat(64), sourceMessageId: "slack:owner:123", launchMetadata };
function harness() {
  const f = ompFixture();
  f.target.role = "attached-lead"; f.target.laneKey = "lead";
  Object.assign(f.identity, identityOf(f.target));
  const entries: unknown[] = []; f.transcript(entries);
  let target = f.target, idle = true, leaf: string | null = null;
  let profile = { ...launchMetadata };
  let core: OmpExecutionHoldState = { sessionId: target.sessionId, generation: 0, status: "open" };
  let shutdowns = 0, aborts = 0, sends = 0, stages = 0, releases = 0;
  let latchCalls = 0;
  let stageFailure: "none" | "before" | "after" = "none", releaseFailure = false, holdFailure = false;
  const shutdown = Promise.withResolvers<void>();
  const append = (text: string) => {
    const id = `native-entry-${entries.length + 1}`;
    entries.push({ type: "message", id, parentId: leaf, message: { role: "user", content: [{ type: "text", text }] } });
    leaf = id; f.transcript(entries); return id;
  };
  const ctx: OmpContext = {
    agent: { kind: "main" }, mode: "tui", cwd: f.directory, model: { id: "gpt-fixture", provider: "fixture" },
    sessionManager: { getSessionId: () => target.sessionId, getSessionFile: () => target.sessionFile, getLeafId: () => leaf, ensureOnDisk: async () => {} },
    isIdle: () => idle, hasPendingMessages: () => false, getPendingPlanReview: () => undefined, getAsyncJobSnapshot: () => null,
    shutdown: () => { shutdowns++; shutdown.resolve(); }, abort: () => { aborts++; },
    userInteractions: { list: () => [], respond: async () => { throw new Error("No dialog"); }, responseStatus: operationId => ({ status: "missing", operationId }) },
    executionHold: {
      getState: () => ({ ...core }),
      getLaunchMetadata: () => ({ ...profile }),
      isRestartStartupHeld: () => false,
      hold: async () => { aborts++; core = { ...core, status: "held" }; return core; },
      release: async () => { throw new Error("Generic release must never implement owner restart"); },
      tryHoldForRestart: async () => {
        latchCalls++;
        if (!idle) return null;
        if (holdFailure) throw new Error("Native latch failed");
        if (core.status === "open") core = { ...core, generation: core.generation + 1, status: "held" };
        return { ...core };
      },
      stageRestartContinuation: async (_operationId, _hash, text) => {
        stages++;
        if (stageFailure === "before") throw new Error("Native append unknown");
        const entryId = append(text);
        if (stageFailure === "after") throw new Error("Native ACK lost after persistence");
        return { entryId, textHash: payloadHash(text) };
      },
      releaseRestartContinuation: async () => {
        releases++;
        if (releaseFailure) throw new Error("Native release outcome unknown");
        core = { ...core, status: "open" }; return core;
      },
    },
  };
  const api = { getThinkingLevel: () => profile.effort, sendUserMessage: (text: string) => { sends++; append(text); } };
  const journal = join(f.directory, "journal");
  let activeBootstrap: LeadRestartBootstrap | undefined;
  let server = new OmpControlServer(target, "fixture-bearer", journal, () => ctx, api);
  const dispatch = (method: string, params: Record<string, unknown> = intent) => server.dispatch(parseRequest({ protocol: 1, id: "rpc", token: "fixture-bearer", target: identityOf(target), method, params }));
  const held = async () => await dispatch("restart-prepare") as LeadRestartStatus;
  return { ...f, ctx, api, journal, dispatch, held, server: () => server,
    counts: () => ({ shutdowns, aborts, sends, stages, releases }), setIdle: (value: boolean) => { idle = value; },
    waitForShutdown: () => shutdown.promise,
    latchCalls: () => latchCalls,
    setProfile(changes: Partial<OmpLaunchMetadata>) {
      profile = { ...profile, ...changes }; ctx.model = { id: profile.model, provider: profile.provider };
    },
    failStage: (value: typeof stageFailure) => { stageFailure = value; }, failRelease: () => { releaseFailure = true; }, failHold: () => { holdFailure = true; },
    recreate() {
      server.close();
      server = new OmpControlServer(target, "fixture-bearer", journal, () => ctx, api,
        activeBootstrap ? { startHeld: true, restart: activeBootstrap } : {});
    },
    async resume(changes: Partial<OmpTarget> = {}, profileChanges: Partial<OmpLaunchMetadata> = {}) {
      const old = target; server.close();
      profile = { ...profile, ...profileChanges }; ctx.model = { id: profile.model, provider: profile.provider };
      target = { ...old, instanceId: "fresh-native-process", generation: 1, ...changes };
      core = { sessionId: target.sessionId, generation: 0, status: "open" };
      const bootstrap: LeadRestartBootstrap = { ...intent, previousTarget: old };
      activeBootstrap = bootstrap;
      server = new OmpControlServer(target, "fixture-bearer", journal, () => ctx, api, { startHeld: true, restart: bootstrap });
      await server.listen();
      return { target, bootstrap };
    },
    cleanup() { server.close(); f.cleanup(); },
  };
}

test("unsupported loaded runtime refuses before native intent and retains durable owner input", async () => {
  const h = harness(); delete h.ctx.executionHold!.stageRestartContinuation;
  try {
    await h.server().listen();
    const client = await connectOmp(h.target);
    try {
      expect((await client.inspect()).capabilities.leadRestart).toBe(false);
      const config = { runtime: { kind: "omp", rpcTimeoutMs: 500 } } as DoriConfig;
      const refusal = await prepareLeadRestart(config, h.target, intent).catch(error => error);
      expect(refusal.code).toBe("restart-native-unavailable"); expect(refusal.attempted).toBe(false);
      expect(existsSync(join(h.journal, "lead-restart.json"))).toBe(false);
      const received = await client.input("owner ingress still works", "new-owner-input");
      expect(received.receipt.entryId).toBe("native-entry-1");
      expect(h.counts()).toEqual({ shutdowns: 0, aborts: 0, sends: 1, stages: 0, releases: 0 });
    } finally { client.close(); }
  } finally { h.cleanup(); }
});

test("busy restart arms idempotently, fences input, finishes normally, and commits only once", async () => {
  const h = harness(); h.setIdle(false);
  try {
    expect((await h.dispatch("restart-prepare") as LeadRestartStatus).phase).toBe("waiting-idle");
    await h.dispatch("restart-prepare");
    await expect(h.dispatch("restart-commit")).rejects.toThrow("idle native restart latch");
    await expect(h.dispatch("input", { operationId: "late", text: "late", payloadHash: payloadHash("late") })).rejects.toThrow("fenced");
    await expect(h.dispatch("restart-prepare", { ...intent, authorizationHash: "b".repeat(64) })).rejects.toThrow("conflict");
    await expect(h.dispatch("restart-inspect", { ...intent, sourceMessageId: "quoted-owner" })).rejects.toThrow("conflict");
    h.setIdle(true);
    expect((await h.held()).phase).toBe("held");
    const committed = await h.dispatch("restart-commit") as LeadRestartStatus;
    expect(committed.phase).toBe("exit-requested");
    expect(committed.process).toEqual({ pid: process.pid, controllerInstanceId: h.target.instanceId, controllerGeneration: h.target.generation });
    expect(committed.fence?.status).toBe("held");
    await h.dispatch("restart-commit"); await h.waitForShutdown();
    expect(h.counts().shutdowns).toBe(1); expect(h.counts().aborts).toBe(0);
    for (const method of ["hold", "release", "stop"]) await expect(h.dispatch(method, method === "stop" ? { operationId: method } : { operationId: method, origin: "user" })).rejects.toThrow("Borrowed OMP lead");
  } finally { h.cleanup(); }
});

test("fresh controller attests its bootstrap and stages a real held receipt before exactly one release", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held(); await h.dispatch("restart-commit");
    const fresh = await h.resume();
    const client = await connectOmp(fresh.target);
    try {
      const status = await client.leadRestart("restart-inspect", fresh.bootstrap);
      expect(status.bootstrap).toEqual(fresh.bootstrap); expect(status.target.instanceId).toBe("fresh-native-process");
      expect(status.fence?.status).toBe("held"); expect(status.target.sessionFile).toBe(h.target.sessionFile);
      expect(status.target.paneId).toBe(h.target.paneId); expect(status.target.terminalId).toBe(h.target.terminalId);
      await expect(client.leadRestart("restart-release", fresh.bootstrap)).rejects.toThrow("restart-not-held");
      const text = "Explicit service continuation for the fresh scoped binding";
      const staged = await client.leadRestartStage(fresh.bootstrap, text);
      expect(staged.receipt.entryId).toBe("native-entry-1"); expect(staged.textHash).toBe(payloadHash(text));
      await client.leadRestartStage(fresh.bootstrap, text);
      await expect(client.leadRestartStage(fresh.bootstrap, "changed")).rejects.toThrow("operation-conflict");
      expect(h.counts().stages).toBe(1); expect(h.counts().sends).toBe(0); expect(h.counts().releases).toBe(0);
      expect((await client.leadRestart("restart-release", fresh.bootstrap)).phase).toBe("released");
      await client.leadRestart("restart-release", fresh.bootstrap); expect(h.counts().releases).toBe(1);
    } finally { client.close(); }
  } finally { h.cleanup(); }
});

test("lost stage ACK reconciles the original native entry without a second append", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held(); await h.dispatch("restart-commit");
    const { bootstrap } = await h.resume(); h.failStage("after");
    const text = "receipt survives a lost stage ACK", params = { ...bootstrap, text, payloadHash: payloadHash(text) };
    await expect(h.dispatch("restart-stage", params)).rejects.toThrow("ACK lost");
    const status = await h.dispatch("restart-inspect", bootstrap) as LeadRestartStatus;
    expect(status.continuation?.receipt.entryId).toBe("native-entry-1");
    await h.dispatch("restart-stage", params); expect(h.counts().stages).toBe(1);
  } finally { h.cleanup(); }
});

test("unknown native stage or release never repeats its irreversible operation", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held(); await h.dispatch("restart-commit");
    const { bootstrap } = await h.resume(); h.failStage("before");
    const text = "unknown append", params = { ...bootstrap, text, payloadHash: payloadHash(text) };
    await expect(h.dispatch("restart-stage", params)).rejects.toThrow("append unknown");
    await expect(h.dispatch("restart-stage", params)).rejects.toThrow("receipt unknown");
    await expect(h.dispatch("restart-release", bootstrap)).rejects.toThrow("latch required");
    expect(h.counts().stages).toBe(1); expect(h.counts().releases).toBe(0);
  } finally { h.cleanup(); }
  const r = harness();
  try {
    await r.dispatch("restart-prepare"); await r.held(); await r.dispatch("restart-commit");
    const { bootstrap } = await r.resume();
    const text = "unknown release"; await r.dispatch("restart-stage", { ...bootstrap, text, payloadHash: payloadHash(text) });
    r.failRelease();
    await expect(r.dispatch("restart-release", bootstrap)).rejects.toThrow("outcome unknown");
    await expect(r.dispatch("restart-release", bootstrap)).rejects.toThrow("latch required");
    expect((await r.dispatch("restart-inspect", bootstrap) as LeadRestartStatus).phase).toBe("failed");
    expect(r.counts().releases).toBe(1);
  } finally { r.cleanup(); }
});

test("wrong resumed terminal cannot activate an old exit intent", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held(); await h.dispatch("restart-commit");
    await expect(h.resume({ terminalId: "replacement-terminal" })).rejects.toThrow("bootstrap mismatch");
    expect(h.counts().stages).toBe(0); expect(h.counts().releases).toBe(0);
  } finally { h.cleanup(); }
});

test("unknown native latch failure stays failed without retrying prepare or shutdown", async () => {
  const h = harness(); h.failHold();
  try {
    await expect(h.dispatch("restart-prepare")).rejects.toThrow("latch failed");
    expect((await h.dispatch("restart-inspect") as LeadRestartStatus).phase).toBe("failed");
    expect((await h.dispatch("restart-prepare") as LeadRestartStatus).phase).toBe("failed");
    await expect(h.dispatch("restart-commit")).rejects.toThrow("latch required");
    expect(h.latchCalls()).toBe(1); expect(h.counts().shutdowns).toBe(0);
  } finally { h.cleanup(); }
});

test("a native controller replacement cannot recover an uncommitted old held operation", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held();
    await expect(h.resume()).rejects.toThrow("bootstrap mismatch");
    expect(h.counts().shutdowns).toBe(0); expect(h.counts().stages).toBe(0);
  } finally { h.cleanup(); }
});

test("durable exit intent survives controller recovery without repeating a possibly lost shutdown", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.held();
    const before = await h.dispatch("restart-commit") as LeadRestartStatus;
    h.recreate();
    const recovered = await h.dispatch("restart-inspect") as LeadRestartStatus;
    expect(recovered.phase).toBe("exit-requested");
    expect(recovered.process).toEqual(before.process);
    expect((await h.dispatch("restart-commit") as LeadRestartStatus).phase).toBe("exit-requested");
    expect(h.counts().shutdowns).toBe(0);
    expect(h.latchCalls()).toBe(1);
    await expect(h.dispatch("restart-prepare", { ...intent, operationId: "replacement" })).rejects.toThrow("conflict");
  } finally { h.cleanup(); }
});

test("borrowed-lead profile rejects worker defaults before native acceptance and leaves owner ingress usable", async () => {
  const h = harness();
  try {
    await h.server().listen();
    const client = await connectOmp(h.target);
    try {
      const observed = await client.inspect();
      expect(observed.launchMetadata?.agentDir).toBe("/fixture/borrowed-lead-agent");
      expect(observed.launchMetadata?.approvalMode).toBe("yolo");
      const config = { runtime: { kind: "omp", rpcTimeoutMs: 500, settingsHome: "/fixture/worker-agent" } } as DoriConfig;
      const wrong = { ...intent, launchMetadata: { ...launchMetadata, agentDir: "/fixture/worker-agent",
        settingsHome: "/fixture/worker-agent", approvalMode: "always-ask" as const } };
      const refusal = await prepareLeadRestart(config, h.target, wrong).catch(error => error);
      expect(refusal.code).toBe("restart-launch-mismatch"); expect(refusal.attempted).toBe(false);
      expect(existsSync(join(h.journal, "lead-restart.json"))).toBe(false);
      await expect(h.dispatch("restart-prepare", wrong)).rejects.toThrow("launch profile");
      expect(existsSync(join(h.journal, "lead-restart.json"))).toBe(false);
      expect((await client.input("owner source is still usable", "owner-after-profile-refusal")).receipt.entryId).toBe("native-entry-1");
      expect(h.latchCalls()).toBe(0);
      await prepareLeadRestart(config, h.target, { ...intent, launchMetadata: observed.launchMetadata! });
      expect((await client.leadRestart("restart-inspect", intent)).launchMetadata.approvalMode).toBe("yolo");
    } finally { client.close(); }
  } finally { h.cleanup(); }
});

test("split agent/settings roots cannot be guessed into a single startup profile", async () => {
  const h = harness(); h.setProfile({ settingsHome: "/fixture/different-settings" });
  try {
    const observed = h.server().snapshot();
    expect(observed.launchMetadata?.agentDir).toBe("/fixture/borrowed-lead-agent");
    expect(observed.launchMetadata?.settingsHome).toBe("/fixture/different-settings");
    expect(observed.capabilities.leadRestart).toBe(false);
    await expect(h.dispatch("restart-prepare", { ...intent, launchMetadata: observed.launchMetadata! })).rejects.toThrow("launch profile");
    expect(existsSync(join(h.journal, "lead-restart.json"))).toBe(false);
    expect(h.latchCalls()).toBe(0);
  } finally { h.cleanup(); }
});

test("approval drift during busy deferral cannot latch or shut down using a stale profile", async () => {
  const h = harness(); h.setIdle(false);
  try {
    await h.dispatch("restart-prepare");
    h.setProfile({ approvalMode: "always-ask" }); h.setIdle(true);
    await expect(h.dispatch("restart-prepare")).rejects.toThrow("launch profile");
    const status = await h.dispatch("restart-inspect") as LeadRestartStatus;
    expect(status.phase).toBe("failed"); expect(status.launchMetadata.approvalMode).toBe("always-ask");
    expect(h.counts().shutdowns).toBe(0); expect(h.latchCalls()).toBe(1);
  } finally { h.cleanup(); }
});

test("fresh native bootstrap cannot change the original account directory or permission mode", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.dispatch("restart-commit");
    await expect(h.resume({}, { agentDir: "/fixture/worker-agent", settingsHome: "/fixture/worker-agent", approvalMode: "always-ask" })).rejects.toThrow("launch profile");
    expect(h.counts().stages).toBe(0); expect(h.counts().releases).toBe(0);
  } finally { h.cleanup(); }
});

test("permission drift after staging refuses release before the native continuation attempt", async () => {
  const h = harness();
  try {
    await h.dispatch("restart-prepare"); await h.dispatch("restart-commit");
    const { bootstrap } = await h.resume();
    const text = "same-profile continuation";
    await h.dispatch("restart-stage", { ...bootstrap, text, payloadHash: payloadHash(text) });
    h.setProfile({ approvalMode: "always-ask" });
    await expect(h.dispatch("restart-release", bootstrap)).rejects.toThrow("launch profile");
    expect(h.counts().releases).toBe(0);
    h.setProfile({ approvalMode: "yolo" });
    const status = await h.dispatch("restart-release", bootstrap) as LeadRestartStatus;
    expect(status.phase).toBe("released"); expect(status.launchMetadata).toEqual(launchMetadata);
  } finally { h.cleanup(); }
});
