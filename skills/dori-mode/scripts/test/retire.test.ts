import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { retireManagedLane, type RetireArgs } from "../src/retire.ts";
import { Registry, statusOf, type Lane } from "../src/registry.ts";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { DoriService } from "../src/service.ts";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import type { OmpTarget } from "../src/runtime/omp/contract.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });
async function fixture(addressable = true) {
  const state = withState(); cleanups.push(state.done);
  const world = newWorld(), clock = fakeClock(Date.parse("2026-11-04T08:00:00Z"));
  const deps = depsFor(world, clock, state.dir);
  const target: OmpTarget = { kind: "omp", protocol: 1, sessionId: "00000000-0000-4000-8000-000000000001",
    sessionFile: join(state.dir, "original.jsonl"), cwd: state.dir, paneId: "w:p1", terminalId: "original-terminal",
    instanceId: "original-native", generation: 1, role: "managed-lane", laneKey: "finished-lane", runtimeVersion: "18.15.0",
    socketPath: join(state.dir, "native.sock"), tokenFile: join(state.dir, "fixture.token") };
  const lane: Lane = { key: "finished-lane", role: "lane", title: "done elsewhere", thread: "slack:owner-thread", brief: "fixture", done: "file missing-final.json",
    cwd: state.dir, pane: target.paneId, openedAt: new Date(clock.now()).toISOString(), status: "paused", dispatchBlocked: true, holdReason: "owner-pause",
    runtime: { kind: "omp", backend: "herdr-tui", hostInstanceId: "original-host", generation: 1, binaryVersion: "18.15.0", state: addressable ? "idle" : "recovering", held: true,
      ...(addressable ? { threadId: target.sessionId, omp: { kind: "omp", target, attachmentInstanceId: "original-host", attachmentGeneration: 1, attachedAt: new Date(clock.now()).toISOString(), excludedInboxIds: [] } } : {}) } };
  await deps.registry.write(lane);
  const args: RetireArgs = { key: lane.key, operationId: "owner-retirement", evidence: "Already integrated; owner authorized lead judgment", expectedInstance: "original-host", expectedGeneration: 1 };
  return { state, world, deps, lane, args, target, authority: async () => {} };
}

test("retiring a paused known worker stops without admission or destructive completion cleanup", async () => {
  const f = await fixture();
  const file = join(f.state.dir, "uncommitted.txt"); writeFileSync(file, "preserve my work");
  await f.deps.registry.update(f.lane.key, lane => ({ ...lane, worktrees: [f.state.dir] }));
  const result = await retireManagedLane(f.deps, f.args, f.authority);
  expect(result).toMatchObject({ retired: true, runtimeStop: "confirmed", processExitVerified: true, filesPreserved: true, panePreserved: true });
  expect(f.world.runtimeCalls).toEqual(["stop"]);
  expect(f.world.calls).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("preserve my work");
  const after = (await f.deps.registry.read(f.lane.key))!;
  expect(statusOf(after)).toBe("closed"); expect(after.dispatchBlocked).toBe(true);
  expect(after.claim).toBeUndefined(); expect(after.cleanupFence).toBeUndefined();
  expect(after.history?.some(h => h.status === "verified-done")).toBe(false);
});

test("unconfirmed startup is retired as a record, never guessed into a stopped native process", async () => {
  const f = await fixture(false);
  const originalRuntime = structuredClone(f.lane.runtime);
  const result = await retireManagedLane(f.deps, f.args, f.authority);
  expect(result).toMatchObject({ retired: true, runtimeStop: "not-addressable", processExitVerified: false });
  expect(f.world.runtimeCalls ?? []).toEqual([]);
  expect((await f.deps.registry.read(f.lane.key))?.runtime).toEqual(originalRuntime);
});

test("lost stop acknowledgement remains unknown and repeated requests never issue stop twice", async () => {
  const f = await fixture(); let stops = 0;
  f.deps.runtime.stop = async () => { stops++; throw new Error("lost acknowledgement"); };
  expect(await retireManagedLane(f.deps, f.args, f.authority)).toMatchObject({ retired: true, runtimeStop: "unknown", processExitVerified: false });
  const reconstructed = { ...f.deps, registry: new Registry(f.state.dir) };
  expect(await retireManagedLane(reconstructed, f.args, f.authority)).toMatchObject({ runtimeStop: "unknown" });
  expect(stops).toBe(1);
  await expect(retireManagedLane(reconstructed, { ...f.args, evidence: "different payload" }, f.authority)).rejects.toThrow("payload");
  expect(stops).toBe(1);
});

test("reconstruction after persisted stop intent is observation-only and automatic Done cleanup cannot race it", async () => {
  const f = await fixture(); let checks = 0;
  const authority = async () => { if (++checks === 2) throw new Error("authority changed"); };
  await expect(retireManagedLane(f.deps, f.args, authority)).rejects.toThrow("authority changed");
  const pending = (await f.deps.registry.read(f.lane.key))!;
  expect(pending.retirement?.phase).toBe("stop-attempted");
  await f.deps.registry.update(f.lane.key, lane => ({ ...lane, status: "done-claimed", holdReason: "done-review", claim: { at: "2026-01-01T00:00:00Z", evidence: "old claim" } }));
  expect(await watchTick(f.deps)).toEqual([]);
  expect((await closeLane(f.deps, (await f.deps.registry.read(f.lane.key))!, "automatic")).closed).toBe(false);
  expect(await retireManagedLane({ ...f.deps, registry: new Registry(f.state.dir) }, f.args, f.authority)).toMatchObject({ retired: true, runtimeStop: "unknown" });
  expect(f.world.runtimeCalls ?? []).toEqual([]); expect(f.world.calls).toEqual([]);
});

test("replacement native host cannot be closed by an old retirement intent", async () => {
  const f = await fixture();
  f.deps.runtime.stop = async () => { await f.deps.registry.update(f.lane.key, lane => ({ ...lane, runtime: { ...lane.runtime!, hostInstanceId: "replacement", generation: 2 } })); };
  await expect(retireManagedLane(f.deps, f.args, f.authority)).rejects.toThrow("scope changed");
  expect(statusOf((await f.deps.registry.read(f.lane.key))!)).not.toBe("closed");
});

for (const mutation of ["lead", "borrowed", "stale-generation", "wrong-native-pane"] as const) {
  test(`retirement refuses ${mutation} before any shutdown`, async () => {
    const f = await fixture();
    if (mutation === "stale-generation") f.args.expectedGeneration = 2;
    else await f.deps.registry.update(f.lane.key, lane => mutation === "lead" ? { ...lane, role: "lead" } : mutation === "borrowed" ?
      { ...lane, runtime: { ...lane.runtime!, backend: "external-current-session" } } :
      { ...lane, runtime: { ...lane.runtime!, omp: { ...lane.runtime!.omp!, target: { ...lane.runtime!.omp!.target, paneId: "different-pane" } } } });
    await expect(retireManagedLane(f.deps, f.args, f.authority)).rejects.toThrow();
    expect(f.world.runtimeCalls ?? []).toEqual([]);
    expect((await f.deps.registry.read(f.lane.key))?.retirement).toBeUndefined();
  });
}

async function serviceFixture() {
  const f = await fixture(false), config = defaultConfig(f.state.dir); config.stateDir = f.state.dir;
  const service = new DoriService(config);
  const target = { ...f.target, role: "attached-lead" as const, laneKey: "lead", paneId: "w:lead" };
  const lead: Lane = { ...f.lane, key: "lead", role: "lead", pane: target.paneId, status: "working", dispatchBlocked: false, holdReason: undefined,
    runtime: { kind: "omp", backend: "external-current-session", state: "idle", held: false, hostInstanceId: "lead-instance", generation: 4, threadId: target.sessionId, binaryVersion: "18.15.0",
      external: { socketPath: target.socketPath, binary: "/fixture/omp", bridge: "/fixture/iyen" },
      omp: { kind: "omp", target, attachmentInstanceId: "lead-instance", attachmentGeneration: 4, attachedAt: "2026-11-04T08:00:00Z", excludedInboxIds: [] } } };
  await service.registry.write(lead);
  atomicJson(join(config.stateDir, "attachments/lead.json"), { instance: "lead-instance", generation: 4, threadId: target.sessionId, pane: target.paneId, cwd: lead.cwd,
    token: "fixture-only", socketPath: target.socketPath, binary: "/fixture/omp", bridge: "/fixture/iyen", omp: target, excludedInboxIds: [] });
  return { ...f, service, caller: { role: "lead" as const, key: "lead", instance: "lead-instance" } };
}

test("service retirement preserves uncertain inbox provenance and rejects late startup or new work", async () => {
  const f = await serviceFixture();
  const mail = { id: "original-unknown", target: f.lane.key, text: "never replay", state: "unknown" as const, at: "2026-11-04T07:00:00Z", attachmentInstance: "original-host" };
  f.service.inbox.put(mail);
  expect(await f.service.handle("retire", f.args, f.caller)).toMatchObject({ retired: true, runtimeStop: "not-addressable" });
  expect(f.service.inbox.get(mail.id)).toEqual(mail);
  expect(await f.service.handle("host-register", { key: f.lane.key, instance: "original-host", runtime: { ...f.lane.runtime, threadId: "late-start" } },
    { role: "host", key: f.lane.key })).toEqual({ accepted: false, retired: true });
  for (const action of ["resume", "reopen", "recover", "launch", "input", "claim-done"])
    await expect(f.service.handle(action, { key: f.lane.key }, f.caller)).rejects.toThrow("Retired lane");
  expect(f.service.inbox.get(mail.id)).toEqual(mail);
  expect((await f.service.registry.read(f.lane.key))?.runtime?.threadId).toBeUndefined();
});

test("worker, stale lead and held lead cannot authorize retirement", async () => {
  const f = await serviceFixture();
  await expect(f.service.handle("retire", f.args, { role: "lane", key: f.lane.key })).rejects.toThrow("Lane capability");
  await expect(f.service.handle("retire", f.args, { ...f.caller, instance: "stale" })).rejects.toThrow("Stale lead");
  await f.service.registry.update("lead", lead => ({ ...lead, dispatchBlocked: true }));
  await expect(f.service.handle("retire", f.args, f.caller)).rejects.toThrow("authority changed or held");
  expect((await f.service.registry.read(f.lane.key))?.retirement).toBeUndefined();
});
