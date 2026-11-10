import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { retireFailedCodex, assertFailedCodexProcessesExited } from "../src/retire-codex.ts";
import { atomicJson } from "../src/journal.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import type { RetireArgs } from "../src/retire-codex.ts";
import { DoriService } from "../src/service.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(f => f()));
async function fixture() {
  const state = withState(); cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(Date.now()), state.dir);
  const child = Bun.spawn(["/usr/bin/true"]); await child.exited;
  const lane: Lane = { key: "failed-codex", role: "lane", title: "failed", thread: "none", brief: "b", done: "never",
    cwd: state.dir, pane: "w:p1", tab: "w:t1", openedAt: new Date().toISOString(), status: "working", dispatchBlocked: true,
    holdReason: "recovery", runtime: { kind: "codex", backend: "herdr-tui", hostInstanceId: "instance", generation: 1,
      state: "recovering", binaryVersion: "fixture" } };
  await deps.registry.write(lane);
  const paths = Object.fromEntries(["", ".pid", ".backend", ".runtime"].map(s => [s, join(state.dir, "hosts", `${lane.key}${s}.json`)]));
  atomicJson(paths[""]!, { key: lane.key, role: "lane", instance: "instance", generation: 1, pane: lane.pane, cwd: state.dir });
  for (const suffix of [".pid", ".backend"]) atomicJson(paths[suffix]!, { pid: child.pid, instance: "instance" });
  let present = true, closeCount = 0, loseAck = false, retainOnClose = false, badInventory = false;
  const pane: any = { pane_id: lane.pane, tab_id: lane.tab, cwd: state.dir, terminal_id: "terminal", agent: "codex" };
  const agent: any = { ...pane, name: "dori-failed-codex-instan" };
  const calls: string[][] = [];
  deps.run = async argv => {
    calls.push([...argv]);
    if (argv[1] === "pane" && argv[2] === "close") {
      closeCount++; if (!retainOnClose) present = false;
      if (loseAck) throw new Error("lost ACK");
      return { code: 0, out: "{}", err: "" };
    }
    if (badInventory) return { code: 1, out: "", err: "disconnected" };
    return { code: 0, out: JSON.stringify({ result: argv[1] === "pane" ? { panes: present ? [pane] : [] } : { agents: present ? [agent] : [] } }), err: "" };
  };
  const args: RetireArgs = { key: lane.key, operationId: "cleanup-1", evidence: "owner requested cleanup", expectedInstance: "instance", expectedGeneration: 1, expectedTerminalId: "terminal" };
  const authority = async () => {};
  return { state, deps, lane, args, authority, paths, pane, agent, calls, get closeCount() { return closeCount; },
    absent: () => { present = false; }, lost: (retain: boolean) => { loseAck = true; retainOnClose = retain; }, bad: () => { badInventory = true; } };
}

test("failed Codex retires through one exact pane close, preserves files and never claims Done", async () => {
  const f = await fixture();
  expect(await retireFailedCodex(f.deps, f.args, f.authority)).toMatchObject({ retired: true, paneClosed: true, filesPreserved: true, hostBackendExitVerified: true, processExitVerified: false });
  expect(f.closeCount).toBe(1);
  const after = (await f.deps.registry.read(f.lane.key))!;
  expect(after.status).toBe("closed"); expect(after.claim).toBeUndefined(); expect(after.cleanupFence).toBeUndefined();
  expect(after.retirement?.paneClose).toEqual({ terminalId: "terminal", attempted: true, confirmed: true });
  expect(await retireFailedCodex({ ...f.deps, registry: new Registry(f.state.dir) }, f.args, f.authority)).toMatchObject({ retired: true });
  expect(f.closeCount).toBe(1);
  await expect(retireFailedCodex(f.deps, { ...f.args, evidence: "changed" }, f.authority)).rejects.toThrow("payload");
});

test("already absent panes retire without commands; absence-only argument never closes a present pane", async () => {
  const f = await fixture(); f.args.expectedTerminalId = "absent";
  await expect(retireFailedCodex(f.deps, f.args, f.authority)).rejects.toThrow("occupant");
  f.absent(); expect(await retireFailedCodex(f.deps, f.args, f.authority)).toMatchObject({ retired: true });
  expect(f.closeCount).toBe(0);
});

test("lost close ACK reconciles observed absence; uncertain presence never resubmits", async () => {
  const f = await fixture(); f.lost(true);
  await expect(retireFailedCodex(f.deps, f.args, f.authority)).rejects.toThrow("unconfirmed");
  await expect(retireFailedCodex(f.deps, f.args, f.authority)).rejects.toThrow("read-only");
  expect(f.closeCount).toBe(1); f.absent();
  expect(await retireFailedCodex(f.deps, f.args, f.authority)).toMatchObject({ retired: true });
  expect(f.closeCount).toBe(1);
  const g = await fixture(); g.lost(false);
  expect(await retireFailedCodex(g.deps, g.args, g.authority)).toMatchObject({ retired: true }); expect(g.closeCount).toBe(1);
});

for (const kind of ["terminal", "tab", "cwd", "name", "thread", "generation", "owner-pause", "registered-thread", "lead", "borrowed", "missing-terminal", "inventory"] as const) {
  test(`refuses ${kind} without effects`, async () => {
    const f = await fixture();
    if (kind === "terminal") f.pane.terminal_id = "other";
    if (kind === "tab") f.pane.tab_id = "other";
    if (kind === "cwd") f.pane.cwd = "/";
    if (kind === "name") f.agent.name = "other";
    if (kind === "thread") f.agent.agent_session = { value: "another-thread" };
    if (kind === "generation") f.args.expectedGeneration = 2;
    if (kind === "missing-terminal") delete f.args.expectedTerminalId;
    if (kind === "inventory") { f.absent(); f.bad(); }
    if (["owner-pause", "registered-thread", "lead", "borrowed"].includes(kind)) await f.deps.registry.update(f.lane.key, l =>
      kind === "owner-pause" ? { ...l, holdReason: "owner-pause" } : kind === "lead" ? { ...l, role: "lead" } :
      { ...l, runtime: { ...l.runtime!, ...(kind === "registered-thread" ? { threadId: "native" } : { backend: "external-current-session" as const }) } });
    await expect(retireFailedCodex(f.deps, f.args, f.authority)).rejects.toThrow(); expect(f.closeCount).toBe(0);
  });
}

test("authority/identity change after intent leaves a fence and sends no close", async () => {
  const f = await fixture(); let checks = 0;
  await expect(retireFailedCodex(f.deps, f.args, async () => { if (++checks === 3) throw new Error("authority lost"); })).rejects.toThrow("authority lost");
  expect((await f.deps.registry.read(f.lane.key))?.retirement).toBeDefined(); expect(f.closeCount).toBe(0);
  f.pane.terminal_id = "replacement";
  await expect(retireFailedCodex(f.deps, f.args, f.authority)).rejects.toThrow("identity"); expect(f.closeCount).toBe(0);
});

test("process guard rejects live/reused PIDs, stale instance, missing host proof and saved native threads", async () => {
  const f = await fixture();
  for (const suffix of [".pid", ".backend"]) {
    const original = await Bun.file(f.paths[suffix]!).json();
    atomicJson(f.paths[suffix]!, { ...original, pid: process.pid });
    expect(() => assertFailedCodexProcessesExited(f.state.dir, f.lane)).toThrow("still exists");
    atomicJson(f.paths[suffix]!, { ...original, instance: "other" });
    expect(() => assertFailedCodexProcessesExited(f.state.dir, f.lane)).toThrow("identity");
    atomicJson(f.paths[suffix]!, original);
  }
  atomicJson(f.paths[".runtime"]!, { instance: "instance", threadId: "saved-native" });
  expect(() => assertFailedCodexProcessesExited(f.state.dir, f.lane)).toThrow("native thread");
  unlinkSync(f.paths[".runtime"]!); unlinkSync(f.paths[".pid"]!);
  expect(() => assertFailedCodexProcessesExited(f.state.dir, f.lane)).toThrow();
});

test("scoped service routes Codex retirement and preserves unknown mail/launch records", async () => {
  const f = await fixture(), service = new DoriService(f.deps.config, f.deps.run);
  await service.registry.write({ ...f.lane, key: "lead", role: "lead", status: "working", dispatchBlocked: false, holdReason: undefined,
    runtime: { kind: "codex", backend: "external-current-session", hostInstanceId: "lead-host", generation: 2,
      threadId: "lead-thread", state: "idle", held: false, binaryVersion: "fixture", external: { socketPath: "/fixture", binary: "/fixture", bridge: "/fixture" } } });
  atomicJson(join(f.state.dir, "attachments/lead.json"), { instance: "lead-host", generation: 2, threadId: "lead-thread",
    pane: f.lane.pane, cwd: f.lane.cwd, token: "fixture", socketPath: "/fixture", binary: "/fixture", bridge: "/fixture", excludedInboxIds: [] });
  const original = { id: "unknown-input", target: f.lane.key, text: "do not replay", state: "unknown" as const, at: "original" };
  service.inbox.put(original); service.operations.put({ ...original, id: "unknown-launch" });
  const caller = { role: "lead" as const, key: "lead", instance: "lead-host" };
  await expect(service.handle("retire", f.args, { role: "lane", key: f.lane.key })).rejects.toThrow("capability");
  expect(await service.handle("retire", f.args, caller)).toMatchObject({ retired: true, paneClosed: true });
  expect(service.inbox.get(original.id)).toEqual(original);
  expect(service.operations.get("unknown-launch")).toEqual({ ...original, id: "unknown-launch" });
  expect(await service.handle("host-register", { key: f.lane.key, instance: "instance", runtime: f.lane.runtime }, { role: "host", key: f.lane.key })).toEqual({ accepted: false, retired: true });
  await expect(service.handle("recover", { key: f.lane.key }, caller)).rejects.toThrow("Retired");
});
