import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { DoriService } from "../src/service.ts";
import { OmpControlServer, type OmpContext } from "../src/runtime/omp/server.ts";
import { ompFixture } from "./fixtures/omp.ts";
import type { Runner } from "../src/run.ts";
import { DeliveryWatchdog } from "../src/watchdog.ts";
import { restartAuthorization, type RestartRecord } from "../src/lead-restart-coordinator.ts";
import type { Lane } from "../src/registry.ts";
import type { Mail } from "../src/mailbox.ts";
import { payloadHash } from "../src/runtime/omp/contract.ts";

/** Exercise real service authorization, inbox receipts and native server without restart SDK support. */
test("old-loaded native refusal leaves source unused, attachment open and new owner ingress deliverable", async () => {
  const f = ompFixture(); f.transcript([]);
  Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity);
  let leaf: string | null = null;
  const entries: unknown[] = [];
  const ctx: OmpContext = { mode: "tui", agent: { kind: "main" }, cwd: f.directory, model: { id: "test", provider: "fixture" },
    sessionManager: { getSessionId: () => f.identity.sessionId, getSessionFile: () => f.identity.sessionFile, getLeafId: () => leaf, ensureOnDisk: async () => {} },
    isIdle: () => true, hasPendingMessages: () => false, getPendingPlanReview: () => undefined, getAsyncJobSnapshot: () => null,
    abort: () => { throw new Error("Borrowed lead must never abort"); }, shutdown: () => { throw new Error("Unsupported restart must never shut down"); } };
  const server = new OmpControlServer(f.target, "fixture-bearer", join(f.directory, "native"), () => ctx,
    { getThinkingLevel: () => "medium", sendUserMessage: text => {
      leaf = `input-${entries.length + 1}`;
      entries.push({ type: "message", id: leaf, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
      f.transcript(entries);
    } });
  const runner: Runner = async argv => {
    if (argv.join(" ") !== "herdr agent list") throw new Error("Unsupported restart must not launch anything");
    return { code: 0, err: "", out: JSON.stringify({ result: { agents: [{ agent: "omp", cwd: f.directory, pane_id: f.identity.paneId, terminal_id: f.identity.terminalId,
      agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: f.identity.sessionFile } }] } }) };
  };
  const defaults = defaultConfig(f.directory);
  const config: DoriConfig = { ...defaults, stateDir: join(f.directory, "state"), ingress: [{ id: "slack", command: ["fixture-only"], owners: ["owner"] }],
    runtime: { ...defaults.runtime, kind: "omp", binary: "/fixture/omp", requiredVersion: "18.15.0", rpcTimeoutMs: 200,
      settingsHome: join(f.directory, "profile"), roles: { lead: { model: "test", effort: "medium" }, lane: { model: "test", effort: "medium" } },
      omp: { registryDir: f.directory, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "yolo" } } };
  await server.listen();
  try {
    atomicJson(join(f.directory, `${createHash("sha256").update("instance:1").digest("hex")}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
    let service = new DoriService(config, runner);
    await service.handle("lead-attach", { threadId: f.identity.sessionId, sessionFile: f.identity.sessionFile, pane: f.identity.paneId, terminalId: f.identity.terminalId, cwd: f.directory }, { role: "admin" });
    const thread = "slack:original-owner-thread";
    await service.receive("slack", { user: "owner", id: "restart-source", thread, text: "Restart this lead" });
    const source = service.inbox.list().find(m => m.sourceMessageId === "restart-source")!;
    await service.deps.runtime.input("lead", source.text, source.id);
    const original = structuredClone(service.inbox.get(source.id));
    const lead = (await service.registry.read("lead"))!;
    await expect(service.handle("lead-restart", { operationId: "not-supported", sourceMessageId: "restart-source" },
      { role: "lead", key: "lead", instance: lead.runtime!.hostInstanceId })).rejects.toThrow("first operator bootstrap");
    expect(service.leadRestarts.active()).toBeUndefined();
    expect(service.leadRestarts.get("not-supported")).toBeUndefined();
    expect(service.inbox.get(source.id)).toEqual(original);
    expect((await service.registry.read("lead"))!.dispatchBlocked).toBe(false);
    service = new DoriService(config, runner);
    expect(service.leadRestarts.active()).toBeUndefined();
    await service.receive("slack", { user: "owner", id: "next-owner-message", thread, text: "Continue the current work" });
    const next = service.inbox.list().find(m => m.sourceMessageId === "next-owner-message")!;
    await service.deps.runtime.input("lead", next.text, next.id);
    expect(service.inbox.get(next.id)?.state).toBe("sent");
    expect(service.inbox.get(next.id)?.receipt?.operationId).toBe(next.id);
    expect(service.inbox.get(next.id)?.attachmentInstance).toBe(lead.runtime!.hostInstanceId);
    await expect(service.handle("lead-restart", { operationId: "still-not-supported", sourceMessageId: "restart-source" }, { role: "admin" })).rejects.toThrow("first operator bootstrap");
    expect(service.leadRestarts.get("still-not-supported")).toBeUndefined();
  } finally { await server.close(); f.cleanup(); }
});

test("watchdog treats coordinator-owned detached startup gap as deliberate and never notifies vanished controller", async () => {
  const f = ompFixture();
  try {
    const config = defaultConfig(f.directory); config.stateDir = join(f.directory, "state");
    atomicJson(join(config.stateDir, "attachments/lead-restarts.json"), { version: 1, active: "restart-during-exit", operations: {} });
    let calls = 0;
    const watchdog = new DeliveryWatchdog(config, { now: () => 500000, graceMs: 1,
      health: async () => ({ serviceReachable: true, phase: "ready", delivery: { state: "held" }, ingress: [] }),
      runner: async () => { calls++; throw new Error("No native access during restart gap"); } });
    const first = await watchdog.poll(), second = await watchdog.poll();
    expect(first.incidents).toEqual([]); expect(second.incidents).toEqual([]); expect(calls).toBe(0);
  } finally { f.cleanup(); }
});

test("queued owner ingress crosses only the reserved fresh epoch and old capability is revoked by local rotation", async () => {
  const f = ompFixture();
  try {
    const config = defaultConfig(f.directory); config.stateDir = join(f.directory, "state");
    config.ingress = [{ id: "slack", command: ["fixture-only"], owners: ["owner"] }];
    config.runtime.kind = "omp"; config.runtime.binary = "/fixture/omp";
    config.runtime.omp = { registryDir: f.directory, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "yolo" };
    Object.assign(f.target, { role: "attached-lead", laneKey: "lead" });
    const oldInstance = crypto.randomUUID(), nextInstance = crypto.randomUUID(), oldToken = "old-fixture-token", nextToken = "fresh-fixture-token";
    const thread = "slack:original-thread", at = "2026-11-02T00:00:00.000Z";
    const oldBridge = join(config.stateDir, "old/iyen"), bridge = join(config.stateDir, "clients", "attached-lead", nextInstance, "iyen");
    const lane: Lane = { key: "lead", role: "lead", title: "lead", thread: "none", brief: "", done: "", pane: f.target.paneId, cwd: f.directory, openedAt: at, status: "working",
      runtime: { kind: "omp", backend: "external-current-session", state: "idle", threadId: f.target.sessionId, hostInstanceId: oldInstance, generation: 2, binaryVersion: "18.15.0",
        external: { socketPath: f.target.socketPath, binary: config.runtime.binary, bridge: oldBridge },
        omp: { kind: "omp", target: f.target, attachmentInstanceId: oldInstance, attachmentGeneration: 2, attachedAt: at, excludedInboxIds: ["historical-mail"] } } };
    let service = new DoriService(config);
    await service.registry.write(lane);
    atomicJson(join(config.stateDir, "attachments/lead.json"), { instance: oldInstance, generation: 2, token: oldToken, threadId: f.target.sessionId, pane: f.target.paneId,
      cwd: f.directory, binary: config.runtime.binary, binaryVersion: "18.15.0", socketPath: f.target.socketPath, bridge: oldBridge, omp: f.target, excludedInboxIds: ["historical-mail"] });
    atomicJson(join(config.stateDir, "control.json"), { token: "fixture-admin-not-used" });
    const mail: Mail = { id: "original-source", target: "lead", text: "restart", source: "slack", sourceMessageId: "restart-source", ownerUser: "owner", thread,
      state: "sent", at, attachmentInstance: oldInstance, ompProvenance: { target: f.target, attachmentInstanceId: oldInstance, attachmentGeneration: 2 },
      receipt: { operationId: "original-source", payloadHash: payloadHash("restart"), sessionId: f.target.sessionId, sessionFile: f.target.sessionFile, entryId: "owner-entry", receiptId: `omp-entry:${f.target.sessionId}:owner-entry` } };
    service.inbox.put(mail);
    const authorization = restartAuthorization(config, lane, [mail], "restart-source");
    const record: RestartRecord = { version: 1, operationId: "rotation-window", authorization, authorizationHash: payloadHash(JSON.stringify(authorization)), before: lane, config,
      phase: "rotation-pending", createdAt: at, updatedAt: at, freshFence: 1,
      launch: { instance: nextInstance, generation: 3, token: nextToken, bridge, bootstrapFile: join(config.stateDir, "bootstrap.json") },
      freshTarget: { ...f.target, instanceId: "fresh-native", generation: 1, socketPath: join(f.directory, "fresh.sock"), tokenFile: join(f.directory, "fresh.token") } };
    atomicJson(join(config.stateDir, "attachments/lead-restarts.json"), { version: 1, active: record.operationId, operations: { [record.operationId]: record } });
    service = new DoriService(config);
    await service.receive("slack", { user: "owner", id: "during-restart", thread, text: "Keep this new owner instruction" });
    const queued = service.inbox.list().find(row => row.sourceMessageId === "during-restart")!;
    expect(queued.state).toBe("queued"); expect(queued.attachmentInstance).toBe(nextInstance);
    expect((await service.authorize(oldToken)).instance).toBe(oldInstance);
    const transaction = service as unknown as { rotateRestartAttachment(record: RestartRecord): Promise<void> };
    await transaction.rotateRestartAttachment(record);
    await expect(service.authorize(oldToken)).rejects.toThrow("Forbidden");
    expect((await service.authorize(nextToken)).instance).toBe(nextInstance);
    expect(service.inbox.get(mail.id)).toEqual(mail);
    const current = (await service.registry.read("lead"))!;
    expect(current.runtime!.omp!.excludedInboxIds).toContain(mail.id);
    expect(current.runtime!.omp!.excludedInboxIds).toContain("historical-mail");
    expect(current.runtime!.omp!.excludedInboxIds).not.toContain(queued.id);
    expect(service.inbox.get(queued.id)).toEqual(queued);
    await transaction.rotateRestartAttachment(record);
    expect((await service.registry.read("lead"))!.runtimeHistory).toHaveLength(1);
  } finally { f.cleanup(); }
});

