import { expect, test } from "bun:test";
import { resumeUncertain } from "../src/resume-uncertain.ts";
import { Mailbox } from "../src/mailbox.ts";
import { withStatus } from "../src/registry.ts";
import type { OmpTarget } from "../src/runtime/omp/contract.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

async function fixture() {
  const state = withState(), deps = depsFor(newWorld(), fakeClock(1000), state.dir);
  const target: OmpTarget = { kind: "omp", protocol: 1, role: "managed-lane", laneKey: "worker", sessionId: "01a19feb-99f5-77bc-82b4-17b9a111fc26",
    sessionFile: "/fixture/session.jsonl", cwd: "/repo", paneId: "w:p", terminalId: "term", instanceId: "native-instance", generation: 1,
    runtimeVersion: "18.15.0", socketPath: "/fixture/socket", tokenFile: "/fixture/token" };
  await deps.registry.write({ key: "worker", role: "lane", title: "work", thread: "none", brief: "/brief", done: "file /result", cwd: "/repo", pane: "w:p",
    openedAt: new Date(1000).toISOString(), status: "working", dispatchBlocked: true, holdReason: "recovery", runtime: { kind: "omp", backend: "herdr-tui", state: "idle",
      held: true, threadId: target.sessionId, hostInstanceId: "host", generation: 2, binaryVersion: "18.15.0",
      omp: { kind: "omp", target, attachmentInstanceId: "host", attachmentGeneration: 2, attachedAt: new Date(1000).toISOString(), excludedInboxIds: [] } } });
  const inbox = new Mailbox(state.dir, "inbox"), operations = new Mailbox(state.dir, "operations");
  inbox.put({ id: "original", target: "worker", text: "Original coding instruction", state: "unknown", at: new Date(1000).toISOString(), attachmentInstance: "host",
    ompProvenance: { target, attachmentInstanceId: "host", attachmentGeneration: 2 } });
  let held = true, releases = 0, sends = 0;
  deps.runtime.inspect = async () => ({ threadId: target.sessionId, state: "idle", held, goal: null });
  deps.runtime.input = async () => { sends++; throw new Error("No input permitted"); };
  const release = async () => { releases++; held = false; return deps.runtime.inspect("worker"); };
  const args = { key: "worker", operationId: "owner-choice", evidence: "Owner explicitly permitted same-session execution resume without resubmission", expectedInstance: "host", expectedGeneration: 2 };
  return { state, deps, inbox, operations, args, release, counts: () => ({ releases, sends }) };
}

test("explicit recovery releases only the pinned native hold and leaves uncertain delivery unchanged", async () => {
  const x = await fixture();
  try {
    const original = x.inbox.get("original");
    expect(await resumeUncertain(x.deps, x.inbox, x.operations, x.args, x.release)).toMatchObject({ resumed: true, deliveryState: "unchanged" });
    expect(x.inbox.get("original")).toEqual(original);
    expect((await x.deps.registry.read("worker"))?.dispatchBlocked).toBe(false);
    expect(x.operations.get("resume-uncertain:owner-choice")?.state).toBe("sent");
    expect(await resumeUncertain(x.deps, x.inbox, x.operations, x.args, x.release)).toMatchObject({ resumed: true, recorded: true });
    expect(x.counts()).toEqual({ releases: 1, sends: 0 });
    await expect(resumeUncertain(x.deps, x.inbox, x.operations, { ...x.args, evidence: "changed" }, x.release)).rejects.toThrow("payload changed");
  } finally { x.state.done(); }
});

test("lost release acknowledgement reconciles by observing the same native process without another release", async () => {
  const x = await fixture();
  try {
    await expect(resumeUncertain(x.deps, x.inbox, x.operations, x.args, async () => { await x.release(); throw new Error("lost ACK"); })).rejects.toThrow("lost ACK");
    expect(x.operations.get("resume-uncertain:owner-choice")?.state).toBe("unknown");
    expect((await x.deps.registry.read("worker"))?.dispatchBlocked).toBe(true);
    expect(await resumeUncertain(x.deps, x.inbox, new Mailbox(x.state.dir, "operations"), x.args, x.release)).toMatchObject({ resumed: true });
    expect(x.inbox.get("original")?.state).toBe("unknown");
    expect(x.counts()).toEqual({ releases: 1, sends: 0 });
  } finally { x.state.done(); }
});

for (const conflict of ["generation", "sending", "provenance", "new-pause"] as const) test(`uncertain resume rejects ${conflict} without native release`, async () => {
  const x = await fixture();
  try {
    if (conflict === "generation") x.args.expectedGeneration++;
    if (conflict === "sending") x.inbox.mark("original", { state: "sending" });
    if (conflict === "provenance") x.inbox.mark("original", { ompProvenance: undefined });
    if (conflict === "new-pause") {
      const inspect = x.deps.runtime.inspect;
      x.deps.runtime.inspect = async key => {
        await x.deps.registry.update("worker", current => withStatus(current, "paused", "Newer owner pause", new Date(2000).toISOString()));
        return inspect(key);
      };
    }
    await expect(resumeUncertain(x.deps, x.inbox, x.operations, x.args, x.release)).rejects.toThrow();
    expect((await x.deps.registry.read("worker"))?.dispatchBlocked).toBe(true);
    expect(x.counts()).toEqual({ releases: 0, sends: 0 });
  } finally { x.state.done(); }
});

test("explicit recovery repairs dispatch when the same native process is already open without another release", async () => {
  const x = await fixture();
  try {
    await x.release();
    const original = x.inbox.get("original");
    expect(await resumeUncertain(x.deps, x.inbox, x.operations, x.args, async () => { throw new Error("Second release forbidden"); })).toMatchObject({ resumed: true });
    expect((await x.deps.registry.read("worker"))?.dispatchBlocked).toBe(false);
    expect(x.inbox.get("original")).toEqual(original);
    expect(x.counts()).toEqual({ releases: 1, sends: 0 });
  } finally { x.state.done(); }
});
