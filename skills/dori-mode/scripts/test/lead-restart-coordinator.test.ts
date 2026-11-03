import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { LeadRestartCoordinator, restartAuthorization, type RestartDeps, type RestartRecord, type RestartObservation } from "../src/lead-restart-coordinator.ts";
import { OmpError, payloadHash, type OmpTarget } from "../src/runtime/omp/contract.ts";
import type { Lane } from "../src/registry.ts";
import type { Mail } from "../src/mailbox.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iyen-restart-")); dirs.push(dir);
  const config = defaultConfig(dir); config.stateDir = join(dir, "state"); config.ingress = [{ id: "slack", command: ["fixture"], owners: ["owner"] }];
  const target: OmpTarget = { kind: "omp", protocol: 1, sessionId: "00000000-0000-4000-8000-000000000001", sessionFile: join(dir, "original.jsonl"),
    cwd: dir, paneId: "w1:p1", terminalId: "original-terminal", instanceId: "native-old", generation: 2, role: "attached-lead", laneKey: "lead", runtimeVersion: "18.15.0", socketPath: join(dir, "old.sock"), tokenFile: join(dir, "old.token") };
  const lane: Lane = { key: "lead", role: "lead", title: "lead", thread: "none", brief: "", done: "", pane: target.paneId, cwd: dir, status: "working", openedAt: "2026-11-01T00:00:00.000Z",
    runtime: { kind: "omp", backend: "external-current-session", threadId: target.sessionId, state: "running", hostInstanceId: "attachment-old", generation: 3, binaryVersion: "18.15.0",
      omp: { kind: "omp", target, attachmentInstanceId: "attachment-old", attachmentGeneration: 3, attachedAt: "2026-11-01T00:00:00.000Z", excludedInboxIds: [] } } };
  const mail: Mail = { id: "original-owner-mail", source: "slack", sourceMessageId: "source-id", ownerUser: "owner", thread: "slack:original-thread", text: "Restart this lead", target: "lead", state: "sent", at: "2026-11-02T00:00:00.000Z", attachmentInstance: "attachment-old",
    ompProvenance: { target, attachmentInstanceId: "attachment-old", attachmentGeneration: 3 },
    receipt: { operationId: "original-owner-mail", payloadHash: payloadHash("Restart this lead"), sessionId: target.sessionId, sessionFile: target.sessionFile, entryId: "entry-owner", receiptId: `omp-entry:${target.sessionId}:entry-owner` } };
  const authorization = restartAuthorization(config, lane, [mail], "source-id");
  const record: RestartRecord = { version: 1, operationId: "restart-one", authorization, authorizationHash: payloadHash(JSON.stringify(authorization)), phase: "authorized", config, before: lane,
    createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z", process: { pid: 123, startedAt: "2026-11-01T00:00:00.000Z" },
    launch: { instance: "attachment-fresh", generation: 4, token: "fixture-only", bridge: join(dir, "fresh/iyen"), bootstrapFile: join(dir, "bootstrap.json") },
    continuation: { operationId: "continuation-one", text: "Continue with fresh bridge" } };
  const fresh: OmpTarget = { ...target, instanceId: "native-fresh", generation: 3, socketPath: join(dir, "new.sock"), tokenFile: join(dir, "new.token") };
  let native: RestartObservation = "waiting-idle", exited = false, discovered = false, staged = false, rotated = false, finished = false, validScope = true, attested = true;
  const effects = { prepare: 0, commit: 0, start: 0, rotate: 0, stage: 0, release: 0 };
  let lose: keyof typeof effects | undefined;
  const fault = (effect: keyof typeof effects) => { if (lose === effect) throw new Error("effect outcome unknown"); };
  const deps: RestartDeps = {
    reject: async () => {},
    assertScope: async () => { if (!validScope) throw new Error("superseded epoch"); },
    prepare: async () => { effects.prepare++; fault("prepare"); return native; }, inspect: async () => native,
    commit: async () => { effects.commit++; native = "exit-requested"; fault("commit"); },
    exited: async () => exited,
    start: async () => { effects.start++; fault("start"); discovered = true; },
    discover: async () => discovered ? fresh : undefined,
    attest: async () => { if (!attested) throw new Error("bootstrap mismatch"); return 7; },
    rotate: async () => { effects.rotate++; rotated = true; fault("rotate"); },
    stage: async () => { if (!rotated) throw new Error("unrotated bridge"); effects.stage++; staged = true; fault("stage"); },
    staged: async () => staged,
    release: async () => { if (!staged || !rotated) throw new Error("release before continuation/rotation"); effects.release++; native = "released"; fault("release"); },
    finish: async () => { finished = true; },
  };
  let coordinator = new LeadRestartCoordinator(config.stateDir, deps);
  return { config, lane, mail, record, fresh, effects, deps,
    get coordinator() { return coordinator; }, restart() { coordinator = new LeadRestartCoordinator(config.stateDir, deps); },
    idle() { native = "held"; }, exit() { exited = true; }, discover() { discovered = true; },
    lose(effect?: keyof typeof effects) { lose = effect; }, scope(valid: boolean) { validScope = valid; }, attest(valid: boolean) { attested = valid; },
    get finished() { return finished; }, get rotated() { return rotated; } };
}
async function until(f: { coordinator: LeadRestartCoordinator; record: RestartRecord }, phase: RestartRecord["phase"], limit = 30) {
  for (let i = 0; i < limit && f.coordinator.status(f.record.operationId).phase !== phase; i++) await f.coordinator.tick();
  expect(f.coordinator.status(f.record.operationId).phase).toBe(phase);
}

test("service-owned restart waits for idle and exact exit, then rotates, stages and releases after old caller disappears", async () => {
  const f = fixture(); await f.coordinator.accept(f.record);
  await until(f, "waiting-idle");
  f.restart(); await f.coordinator.tick(); expect(f.effects.commit).toBe(0);
  f.idle(); await until(f, "exit-pending");
  f.restart(); await f.coordinator.tick(); expect(f.effects.start).toBe(0);
  f.exit(); await until(f, "fresh-held"); expect(f.rotated).toBe(false);
  await until(f, "released");
  expect(f.finished).toBe(true); expect(f.coordinator.active()).toBeUndefined();
  expect(f.effects).toEqual({ prepare: 1, commit: 1, start: 1, rotate: 1, stage: 1, release: 1 });
  expect(f.coordinator.status(f.record.operationId).sessionId).toBe(f.record.authorization.scope.target.sessionId);
  expect(f.coordinator.status(f.record.operationId).attachment?.generation).toBe(4);
});

test("known operation retry and status reconcile read-only without issuing next effects", async () => {
  const f = fixture(); await f.coordinator.accept(f.record); await until(f, "waiting-idle"); f.idle();
  await f.coordinator.reconcile(f.record.operationId);
  await f.coordinator.accept(f.record);
  expect(f.coordinator.status(f.record.operationId).phase).toBe("held"); expect(f.effects.commit).toBe(0);
});

for (const effect of ["prepare", "commit", "start", "stage", "release"] as const) test(`lost ${effect} outcome survives restart without repeating external effect`, async () => {
  const f = fixture(); f.idle(); f.exit(); f.lose(effect); await f.coordinator.accept(f.record);
  const pending = { prepare: "prepare-pending", commit: "exit-pending", start: "start-pending", stage: "continuation-pending", release: "release-pending" }[effect] as RestartRecord["phase"];
  await until(f, pending); expect(f.effects[effect]).toBe(1);
  f.restart(); f.lose();
  for (let i = 0; i < 4; i++) await f.coordinator.reconcile(f.record.operationId);
  expect(f.effects[effect]).toBe(1);
  if (effect === "start") {
    for (let i = 0; i < 5; i++) await f.coordinator.tick();
    expect(f.coordinator.status(f.record.operationId).phase).toBe("start-pending"); expect(f.effects.start).toBe(1);
    f.discover();
  }
  await until(f, "released"); expect(f.effects[effect]).toBe(1);
});

test("fresh bootstrap mismatch freezes before capability rotation and release", async () => {
  const f = fixture(); f.idle(); f.exit(); await f.coordinator.accept(f.record); await until(f, "start-pending"); f.attest(false);
  f.restart(); await f.coordinator.tick(); expect(f.coordinator.status(f.record.operationId).phase).toBe("start-pending");
  expect(f.effects.rotate).toBe(0); expect(f.effects.release).toBe(0);
  f.attest(true); await until(f, "released");
});

test("interrupted local rotation repairs same transaction without launching or staging twice", async () => {
  const f = fixture(); f.idle(); f.exit(); await f.coordinator.accept(f.record); f.lose("rotate"); await until(f, "rotation-pending");
  f.restart(); f.lose(); await until(f, "released"); expect(f.effects.start).toBe(1); expect(f.effects.stage).toBe(1); expect(f.effects.release).toBe(1);
});

test("a changed owner or attachment scope freezes all later effects", async () => {
  const f = fixture(); f.idle(); await f.coordinator.accept(f.record); await until(f, "held"); f.scope(false); f.restart();
  await f.coordinator.tick(); await f.coordinator.reconcile(f.record.operationId);
  expect(f.coordinator.status(f.record.operationId).phase).toBe("held"); expect(f.effects.commit).toBe(0);
});

test("operation IDs and source messages cannot authorize changed payloads or another restart", async () => {
  const f = fixture(); await f.coordinator.accept(f.record);
  const changed = structuredClone(f.record); changed.authorization.thread = "slack:other-thread";
  await expect(f.coordinator.accept(changed)).rejects.toThrow("changed authorization");
  f.idle(); f.exit(); await until(f, "released");
  await expect(f.coordinator.accept({ ...f.record, operationId: "another-operation" })).rejects.toThrow("already consumed");
});

const invalidSources: [string, (mail: Mail) => void][] = [
  ["guest", m => { m.ownerUser = "guest"; }], ["unknown ingress", m => { m.source = "quoted"; }],
  ["no thread", m => { m.thread = "none"; }], ["queued", m => { m.state = "queued"; }],
  ["future source", m => { m.at = "2999-01-01T00:00:00.000Z"; }], ["pre-attachment source", m => { m.at = "2020-01-01T00:00:00.000Z"; }],
  ["old attachment", m => { m.attachmentInstance = "old"; }], ["changed attachment generation", m => { m.ompProvenance!.attachmentGeneration++; }],
  ["other native generation", m => { m.ompProvenance!.target.generation++; }], ["other socket", m => { m.ompProvenance!.target.socketPath = "/other.sock"; }],
  ["no receipt", m => { delete m.receipt; }], ["wrong receipt payload", m => { m.text = "quoted restart"; }],
  ["other session file", m => { m.receipt!.sessionFile = "/other.jsonl"; }], ["wrong original operation", m => { m.receipt!.operationId = "another"; }],
];
for (const [name, mutate] of invalidSources) test(`restart rejects ${name}`, () => {
  const f = fixture(), mail = structuredClone(f.mail); mutate(mail);
  expect(() => restartAuthorization(f.config, f.lane, [mail], "source-id")).toThrow();
});
for (const state of ["paused", "done-claimed", "verified-done", "closed"] as const) test(`restart rejects ${state} lead`, () => {
  const f = fixture(); expect(() => restartAuthorization(f.config, { ...f.lane, status: state }, [f.mail], "source-id")).toThrow();
});
test("ambiguous original source, excluded historical mail and unresolved input cannot cross restart epoch", () => {
  const f = fixture();
  expect(() => restartAuthorization(f.config, f.lane, [f.mail, { ...f.mail, id: "duplicate" }], "source-id")).toThrow();
  expect(() => restartAuthorization(f.config, f.lane, [f.mail, { ...f.mail, id: "uncertain", sourceMessageId: "other", state: "unknown" }], "source-id")).toThrow();
  f.lane.runtime!.omp!.excludedInboxIds.push(f.mail.id);
  expect(() => restartAuthorization(f.config, f.lane, [f.mail], "source-id")).toThrow();
});

test("verified pre-submit refusal frees the source instead of becoming an uncertain restart", async () => {
  const f = fixture();
  f.deps.prepare = async () => { throw new OmpError("restart-native-unavailable", "Native upgrade required", false); };
  await f.coordinator.accept(f.record); await f.coordinator.tick();
  expect(f.coordinator.status(f.record.operationId).phase).toBe("rejected");
  expect(f.coordinator.active()).toBeUndefined();
  f.restart();
  await f.coordinator.accept({ ...f.record, operationId: "fresh-safe-attempt" });
  expect(f.coordinator.status("fresh-safe-attempt").phase).toBe("authorized");
  expect(f.effects.commit).toBe(0); expect(f.effects.start).toBe(0);
});
