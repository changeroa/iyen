import { afterEach, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { DeliveryDeferred } from "../src/mailbox.ts";
import { ExternalCurrentSession } from "../src/runtime/external-current-session.ts";
import { operationText } from "../src/runtime/herdr.ts";
import type { Observer } from "../src/runtime/observer.ts";
import type { Runner } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const state = withState(); cleanups.push(state.done);
  const identity = { threadId: "11111111-1111-4111-8111-111111111111", pane: "test:pane", cwd: state.dir };
  const agent: any = { agent: "codex", pane_id: identity.pane, agent_status: "working", agent_session: { agent: "codex", kind: "id", value: identity.threadId } };
  const thread: any = { id: identity.threadId, cwd: state.dir, status: { type: "active", activeFlags: [] } };
  const turns: any[] = [{ id: "current-turn", status: "inProgress", items: [] }];
  const calls: string[][] = [], reads: string[] = [], holds: unknown[] = [];
  let loaded = true, accept = true, failure = false, disconnect = false, gets = 0, now = 0;
  let beforeGet = (_count: number) => {}, afterSend = () => {};
  const observer: Observer = { close() {}, async read<T>(method: string): Promise<T> {
    reads.push(method);
    const result = method === "thread/read" ? { thread } : method === "thread/loaded/list" ? { data: loaded ? [identity.threadId] : [], nextCursor: null } :
      method === "thread/turns/list" ? { data: turns, nextCursor: null } : method === "thread/goal/get" ? { goal: null } : undefined;
    if (!result) throw new Error(`Observer mutation prohibited: ${method}`);
    return result as T;
  } };
  const run: Runner = async argv => {
    calls.push([...argv]);
    if (argv.slice(0, 3).join(" ") === "herdr agent get") {
      beforeGet(++gets); return { code: 0, out: JSON.stringify({ result: { agent } }), err: "" };
    }
    if (argv.slice(0, 3).join(" ") === "herdr agent prompt" || argv[1] === "queue") {
      const steering = argv[0] === "herdr", text = argv[steering ? 4 : 5];
      if (accept) {
        const item = { type: "userMessage", content: [{ type: "text", text }] };
        if (steering) turns[0].items.push(item);
        else turns.push({ id: "queued-turn", status: "completed", items: [item] });
      }
      afterSend();
      if (disconnect) throw new Error("private transport failure");
      return { code: failure ? 1 : 0, out: "acknowledged", err: "" };
    }
    throw new Error(`Unexpected command ${argv[0]}`);
  };
  const session = new ExternalCurrentSession(observer, run, { ...defaultConfig().runtime, rpcTimeoutMs: 200 }, identity, "/fixture/codex",
    { now: () => now, sleep: async ms => { now += ms; } });
  return { session, agent, thread, turns, calls, reads, holds, identity, observer, run,
    input: (id = "op") => session.input("literal $(x) `x`", id, async error => { holds.push(error); }),
    idle() { agent.agent_status = "idle"; thread.status = { type: "idle" }; turns[0].status = "completed"; },
    unloaded() { loaded = false; }, noReceipt() { accept = false; }, fail() { failure = true; }, disconnect() { disconnect = true; },
    beforeGet(fn: typeof beforeGet) { beforeGet = fn; }, afterSend(fn: typeof afterSend) { afterSend = fn; },
    sends: () => calls.filter(a => a[2] === "prompt" || a[1] === "queue") };
}

test("working input steers the verified pane and accepts an exact receipt in the same inProgress turn", async () => {
  const h = fixture();
  expect(await h.session.inspect()).toMatchObject({ state: "running", activeTurnId: "current-turn" });
  expect(await h.input()).toEqual({ turnId: "current-turn" });
  expect(h.sends()).toEqual([["herdr", "agent", "prompt", h.identity.pane, operationText("literal $(x) `x`", "op")]]);
  expect(h.turns).toHaveLength(1); expect(h.turns[0].status).toBe("inProgress"); expect(h.agent.agent_status).toBe("working");
  expect(await h.session.inspect()).toMatchObject({ state: "running", activeTurnId: "current-turn" });
  expect(await h.input()).toEqual({ turnId: "current-turn" }); expect(h.sends()).toHaveLength(1);
  expect(h.reads.every(m => ["thread/read", "thread/loaded/list", "thread/turns/list", "thread/goal/get"].includes(m))).toBe(true);
});

test("idle input retains the CLI queue path", async () => {
  const h = fixture(); h.idle(); expect(await h.input()).toEqual({ turnId: "queued-turn" });
  expect(h.sends()).toEqual([["/fixture/codex", "queue", "--thread", h.identity.threadId, "--message", operationText("literal $(x) `x`", "op")]]);
});

for (const waiting of ["waitingOnApproval", "waitingOnUserInput", "blocked", "failed"])
  test(`${waiting} prevents TUI input`, async () => {
    const h = fixture();
    if (waiting === "blocked") h.agent.agent_status = "blocked";
    else if (waiting === "failed") h.thread.status = { type: "systemError" };
    else h.thread.status.activeFlags = [waiting];
    await expect(h.input()).rejects.toBeInstanceOf(DeliveryDeferred); expect(h.sends()).toHaveLength(0);
  });

test("a working hook without a materialized active turn stays deferred", async () => {
  const h = fixture(); h.thread.status = { type: "idle" }; h.turns.length = 0;
  await expect(h.input()).rejects.toBeInstanceOf(DeliveryDeferred); expect(h.sends()).toHaveLength(0);
});

for (const change of ["approval", "identity", "unloaded"])
  test(`${change} immediately before submission prevents steering`, async () => {
    const h = fixture(); h.beforeGet(count => {
      if (count !== 2) return;
      if (change === "approval") h.thread.status.activeFlags = ["waitingOnApproval"];
      if (change === "identity") h.agent.agent_session.value = "other-thread";
      if (change === "unloaded") h.unloaded();
    });
    await expect(h.input()).rejects.toBeInstanceOf(DeliveryDeferred); expect(h.sends()).toHaveLength(0);
    expect(h.holds).toHaveLength(change === "approval" ? 0 : 1);
  });

test("transport selection uses the last verified state", async () => {
  const h = fixture(); h.beforeGet(count => { if (count === 2) h.idle(); });
  expect(await h.input()).toEqual({ turnId: "queued-turn" }); expect(h.sends()[0]?.[1]).toBe("queue");
});

for (const outcome of ["ack", "failure", "disconnect"])
  test(`TUI ${outcome} without receipt remains unknown and never falls back to queue`, async () => {
    const h = fixture(); h.noReceipt(); if (outcome === "failure") h.fail(); if (outcome === "disconnect") h.disconnect();
    await expect(h.input()).rejects.toThrow(outcome === "ack" ? "receipt unknown" : "submission outcome unknown");
    expect(h.sends()).toHaveLength(1); expect(h.sends()[0]?.slice(0, 3)).toEqual(["herdr", "agent", "prompt"]);
  });

test("exact receipt survives a TUI transport failure", async () => {
  const h = fixture(); h.disconnect(); expect(await h.input()).toEqual({ turnId: "current-turn" }); expect(h.sends()).toHaveLength(1);
});

test("identity loss after steering cannot accept even an exact receipt", async () => {
  const h = fixture(); h.afterSend(() => { h.agent.agent_session.value = "replacement"; });
  await expect(h.input()).rejects.toThrow("delivery unknown"); expect(h.holds).toHaveLength(1); expect(h.sends()).toHaveLength(1);
});

test("assistant echoes and duplicate exact user receipts never prove delivery", async () => {
  const h = fixture(); h.noReceipt(); const text = operationText("literal $(x) `x`", "op");
  h.turns[0].items.push({ type: "agentMessage", text });
  await expect(h.input()).rejects.toThrow("receipt unknown"); expect(h.sends()).toHaveLength(1);
  const item = { type: "userMessage", content: [{ type: "text", text }] };
  h.turns[0].items = [item, item]; await expect(h.input()).rejects.toThrow("Duplicate"); expect(h.sends()).toHaveLength(1);
});
