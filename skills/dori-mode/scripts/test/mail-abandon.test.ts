import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { abandonManagedInput } from "../src/mail-abandon.ts";
import { Mailbox, type Mail } from "../src/mailbox.ts";
import * as native from "../src/runtime/omp-integration.ts";
import { payloadHash, type OmpTarget, type OmpReceipt } from "../src/runtime/omp/contract.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const args = { id: "original-input", operationId: "explicit-abandon-1", evidence: "Owner deliberately retires historical input without replay" };
const target: OmpTarget = {
  kind: "omp", sessionId: "native-original", sessionFile: "/fixture/original.jsonl", cwd: "/fixture/repo", paneId: "w:p1", terminalId: "terminal-1",
  instanceId: "controller-original", generation: 1, role: "managed-lane", laneKey: "worker-one", protocol: 1, runtimeVersion: "18.15.0",
  socketPath: "/fixture/original.sock", tokenFile: "/fixture/original.token",
};
const receipt: OmpReceipt = { operationId: args.id, payloadHash: payloadHash("historical task"), sessionId: target.sessionId, sessionFile: target.sessionFile, entryId: "entry-1", receiptId: `omp-entry:${target.sessionId}:entry-1` };

const fixture = async (state: "queued" | "unknown" = "unknown") => {
  const disk = withState(), base = depsFor(newWorld(), fakeClock(Date.parse("2026-11-03T00:00:00Z")), disk.dir);
  await base.registry.write({ key: "worker-one", role: "lane", title: "worker", thread: "fixture:thread", brief: "/fixture/brief", done: "fixture", openedAt: "now",
    dispatchBlocked: true, holdReason: "recovery", runtime: { kind: "omp", backend: "herdr-tui", state: "recovering", threadId: target.sessionId,
      hostInstanceId: "host-original", generation: 2, binaryVersion: "18.15.0", omp: { kind: "omp", target, attachmentInstanceId: "host-original", attachmentGeneration: 2, attachedAt: "now", excludedInboxIds: [] } } });
  const inbox = new Mailbox(disk.dir, "inbox");
  const original: Mail = { id: args.id, target: "worker-one", text: "historical task", state, at: "original-time", source: "owner-ingress", sourceMessageId: "original-owner-message", ownerUser: "owner", thread: "fixture:thread", metadata: { audit: "preserve" },
    ...(state === "unknown" ? { attachmentInstance: "host-original", ompProvenance: { target, attachmentInstanceId: "host-original", attachmentGeneration: 2 } } : {}) };
  inbox.put(structuredClone(original));
  let stopped = 0, scoped = true;
  const deps = { ...base, inbox, assertScope: async () => { if (!scoped) throw new Error("Current lead changed"); } };
  deps.runtime.stop = async key => {
    stopped++;
    expect(new Mailbox(disk.dir, "inbox").get(args.id)?.abandonment).toMatchObject({ operationId: args.operationId, evidence: args.evidence, original, outcome: "pending" });
    await deps.registry.update(key, lane => ({ ...lane, runtime: { ...lane.runtime!, state: "stopped" } }));
  };
  deps.runtime.input = async () => { throw new Error("Unexpected submission"); };
  deps.runtime.hold = deps.runtime.release = async () => { throw new Error("Unexpected hold/release"); };
  const query = spyOn(native, "callOmp").mockResolvedValue({ status: "unknown", operationId: args.id, payloadHash: receipt.payloadHash });
  return { disk, deps, original, query, stopped: () => stopped, revokeScope: () => { scoped = false; }, done: () => { query.mockRestore(); disk.done(); } };
};

test("actual exact durable receipt reconciles received rather than abandoning or stopping", async () => {
  const f = await fixture();
  try {
    f.query.mockResolvedValue({ status: "received", receipt });
    const result = await abandonManagedInput(f.deps, args);
    expect(result).toMatchObject({ state: "sent", receipt, turnId: receipt.receiptId, abandonment: { outcome: "received", original: f.original } });
    expect(result.abandonment?.processStoppedAt).toBeUndefined();
    expect(f.stopped()).toBe(0);
    expect(await abandonManagedInput(f.deps, args)).toEqual(result);
  } finally { f.done(); }
});

test("a saved real native receipt cannot become abandoned when the controller is gone", async () => {
  const f = await fixture();
  try {
    f.deps.inbox.mark(args.id, { receipt, receiptKind: "omp-session-entry", turnId: receipt.receiptId });
    f.query.mockRejectedValue(new Error("original controller gone"));
    expect(await abandonManagedInput(f.deps, args)).toMatchObject({ state: "sent", receipt, abandonment: { outcome: "received" } });
    expect(f.stopped()).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
  } finally { f.done(); }
});

test("unknown delivery retains original uncertainty and provenance after exact process stop", async () => {
  const f = await fixture();
  try {
    const result = await abandonManagedInput(f.deps, args);
    expect(result).toMatchObject({ ...f.original, state: "abandoned", abandonment: { operationId: args.operationId, evidence: args.evidence, original: f.original, delivery: "unknown", outcome: "abandoned", epoch: { hostInstanceId: "host-original", generation: 2, target } } });
    expect(result.abandonment?.processStoppedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(result.receipt).toBeUndefined(); expect(result.turnId).toBeUndefined(); expect(f.stopped()).toBe(1);
    expect(f.query).toHaveBeenCalledWith(target, "operation", { operationId: args.id, text: f.original.text }, f.deps.config, f.deps.run);
  } finally { f.done(); }
});

test("explicit queued cancellation never queries, stops, or submits and survives restart", async () => {
  const f = await fixture("queued");
  try {
    const result = await abandonManagedInput(f.deps, args);
    expect(result).toMatchObject({ state: "abandoned", abandonment: { original: f.original, delivery: "not-attempted", outcome: "abandoned" } });
    expect(result.abandonment?.processStoppedAt).toBeUndefined(); expect(f.stopped()).toBe(0); expect(f.query).not.toHaveBeenCalled();
    const restarted = new Mailbox(f.disk.dir, "inbox");
    expect(restarted.get(args.id)).toEqual(result);
    await expect(restarted.deliver(args.id, async () => { throw new Error("submission ran"); })).rejects.toThrow("never replay");
    expect(() => restarted.mark(args.id, { state: "queued" })).toThrow("never replay");
    expect(() => new Mailbox(f.disk.dir, "outbox").put(result)).toThrow("cannot be copied");
  } finally { f.done(); }
});

for (const unavailable of [false, true]) test(`stop uncertainty leaves durable pending intent and original unknown (query unavailable=${unavailable})`, async () => {
  const f = await fixture();
  try {
    if (unavailable) f.query.mockRejectedValue(new Error("native unavailable"));
    f.deps.runtime.stop = async () => { throw new Error("process exit unconfirmed"); };
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("exit unconfirmed");
    const restarted = new Mailbox(f.disk.dir, "inbox");
    expect(restarted.get(args.id)).toMatchObject({ ...f.original, abandonment: { outcome: "pending", original: f.original, evidence: args.evidence } });
    await expect(restarted.deliver(args.id, async () => ({ turnId: "must-not-submit" }))).rejects.toThrow("never replay");
  } finally { f.done(); }
});

test("stop acknowledgment without durable stopped state cannot abandon", async () => {
  const f = await fixture();
  try {
    f.deps.runtime.stop = async () => {};
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("stop not durably confirmed");
    expect(f.deps.inbox.get(args.id)?.state).toBe("unknown");
  } finally { f.done(); }
});

for (const change of ["target", "epoch", "lead", "row"] as const) test(`${change} change during stop cannot commit abandonment`, async () => {
  const f = await fixture();
  try {
    const stop = f.deps.runtime.stop;
    f.deps.runtime.stop = async key => {
      await stop(key);
      if (change === "lead") f.revokeScope();
      else if (change === "row") f.deps.inbox.get(args.id)!.text = "changed original payload";
      else await f.deps.registry.update(key, lane => ({ ...lane, runtime: { ...lane.runtime!, ...(change === "epoch" ? { generation: 3 } : { omp: { ...lane.runtime!.omp!, target: { ...target, instanceId: "replacement-controller" } } }) } }));
    };
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow(change === "lead" ? "lead changed" : change === "row" ? "Original input changed" : "epoch changed");
    expect(f.deps.inbox.get(args.id)?.state).toBe("unknown");
    expect(f.deps.inbox.get(args.id)?.abandonment?.original).toEqual(f.original);
  } finally { f.done(); }
});

test("target changes during original receipt query prevent stopping either controller", async () => {
  const f = await fixture();
  try {
    f.query.mockImplementation(async () => {
      await f.deps.registry.update("worker-one", lane => ({ ...lane, runtime: { ...lane.runtime!, omp: { ...lane.runtime!.omp!, target: { ...target, socketPath: "/replacement.sock" } } } }));
      return { status: "absent" };
    });
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("epoch changed");
    expect(f.stopped()).toBe(0); expect(f.deps.inbox.get(args.id)?.state).toBe("unknown");
  } finally { f.done(); }
});

test("retries retain stable intent across restart, reject conflicts, and never replay after recovery", async () => {
  const f = await fixture();
  try {
    const stop = f.deps.runtime.stop;
    f.deps.runtime.stop = async () => { throw new Error("timeout"); };
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("timeout");
    f.deps.inbox = new Mailbox(f.disk.dir, "inbox");
    await expect(abandonManagedInput(f.deps, { ...args, evidence: "different evidence" })).rejects.toThrow("conflicts");
    await expect(abandonManagedInput(f.deps, { ...args, operationId: "different-operation" })).rejects.toThrow("conflicts");
    f.deps.runtime.stop = stop;
    const result = await abandonManagedInput(f.deps, args);
    await f.deps.registry.update("worker-one", lane => ({ ...lane, runtime: { ...lane.runtime!, generation: 3, state: "idle", omp: { ...lane.runtime!.omp!, target: { ...target, instanceId: "recovered-controller" } } } }));
    f.deps.inbox = new Mailbox(f.disk.dir, "inbox");
    expect(await abandonManagedInput(f.deps, args)).toEqual(result);
    expect(f.stopped()).toBe(1);
    expect(f.deps.inbox.list().filter(row => row.state === "queued")).toEqual([]);
    await expect(f.deps.inbox.deliver(args.id, async () => ({ turnId: "replay" }))).rejects.toThrow("never replay");
  } finally { f.done(); }
});

test("pending intent cannot silently follow a replacement target after restart", async () => {
  const f = await fixture();
  try {
    f.deps.runtime.stop = async () => { throw new Error("timeout"); };
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("timeout");
    f.deps.inbox = new Mailbox(f.disk.dir, "inbox");
    await f.deps.registry.update("worker-one", lane => ({ ...lane, runtime: { ...lane.runtime!, hostInstanceId: "replacement-host" } }));
    f.query.mockClear();
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("epoch changed");
    expect(f.query).not.toHaveBeenCalled(); expect(f.deps.inbox.get(args.id)?.state).toBe("unknown");
  } finally { f.done(); }
});

test("a failed durable intent write prevents any native query or stop", async () => {
  const f = await fixture();
  try {
    const rename = fs.renameSync;
    const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === join(f.disk.dir, "inbox.json")) throw new Error("intent disk failure");
      return rename(from, to);
    });
    try { await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("intent disk failure"); } finally { fault.mockRestore(); }
    expect(f.query).not.toHaveBeenCalled(); expect(f.stopped()).toBe(0); expect(f.deps.inbox.get(args.id)).toEqual(f.original);
  } finally { f.done(); }
});

test("invalid receipt never becomes successful reconciliation or abandonment", async () => {
  const f = await fixture();
  try {
    f.query.mockResolvedValue({ status: "received", receipt: { ...receipt, payloadHash: payloadHash("different payload") } });
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("Invalid original native receipt");
    expect(f.deps.inbox.get(args.id)?.state).toBe("unknown"); expect(f.stopped()).toBe(0);
  } finally { f.done(); }
});

for (const forbidden of ["lead", "borrowed", "outbox", "missing-provenance"] as const) test(`refuses ${forbidden} authority without querying or stopping`, async () => {
  const f = await fixture();
  try {
    if (forbidden === "lead") await f.deps.registry.update("worker-one", lane => ({ ...lane, role: "lead" }));
    if (forbidden === "borrowed") await f.deps.registry.update("worker-one", lane => ({ ...lane, runtime: { ...lane.runtime!, backend: "external-current-session" } }));
    if (forbidden === "outbox") {
      f.deps.inbox = new Mailbox(f.disk.dir, "outbox"); f.deps.inbox.put(f.original);
    }
    if (forbidden === "missing-provenance") f.deps.inbox.mark(args.id, { ompProvenance: undefined });
    await expect(abandonManagedInput(f.deps, args)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled(); expect(f.stopped()).toBe(0);
  } finally { f.done(); }
});

test("one abandonment operation ID cannot be reused for another original input", async () => {
  const f = await fixture("queued");
  try {
    await abandonManagedInput(f.deps, args);
    f.deps.inbox.put({ ...f.original, id: "other-input" });
    await expect(abandonManagedInput(f.deps, { ...args, id: "other-input" })).rejects.toThrow("reused with different input");
    expect(f.deps.inbox.get("other-input")?.state).toBe("queued");
  } finally { f.done(); }
});

for (const state of ["queued", "unknown"] as const) test(`restart after ${state} final write failure preserves original intent without dispatch`, async () => {
  const f = await fixture(state);
  try {
    const rename = fs.renameSync;
    let inboxWrites = 0;
    const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === join(f.disk.dir, "inbox.json") && ++inboxWrites === 2) throw new Error("final write failed");
      return rename(from, to);
    });
    try { await expect(abandonManagedInput(f.deps, args)).rejects.toThrow("final write failed"); } finally { fault.mockRestore(); }
    f.deps.inbox = new Mailbox(f.disk.dir, "inbox");
    expect(f.deps.inbox.get(args.id)).toMatchObject({ ...f.original, abandonment: { outcome: "pending", original: f.original } });
    expect(() => f.deps.inbox.mark(args.id, { ompProvenance: { target, attachmentInstanceId: "replacement", attachmentGeneration: 99 } })).toThrow("fences mutation");
    await expect(f.deps.inbox.deliver(args.id, async () => ({ turnId: "replay" }))).rejects.toThrow("never replay");
    const result = await abandonManagedInput(f.deps, args);
    expect(result).toMatchObject({ state: "abandoned", abandonment: { outcome: "abandoned", original: f.original, evidence: args.evidence } });
    expect(f.stopped()).toBe(state === "queued" ? 0 : 2);
  } finally { f.done(); }
});
