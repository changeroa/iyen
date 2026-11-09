import { expect, test } from "bun:test";
import { HcLaneEvents, LaneEventTracker, laneEventSink, startLaneEvents, type HcTransport, type LaneEvent } from "../src/lane-events.ts";
import { deadPaneTick } from "../src/dead-panes.ts";

const t = (address: string, state = "live", status: string | null = null) => ({ address, state, status, labels: { "dori.lane": "a" } });
const kinds = (e: LaneEvent[]) => e.map(x => x.kind);
class Fake implements HcTransport {
  sent: string[] = []; closed = false; private queue: string[] = []; private wake?: () => void;
  push(v: unknown) { this.queue.push(JSON.stringify(v)); this.wake?.(); }
  write(l: string) { this.sent.push(l); }
  close() { this.closed = true; this.wake?.(); }
  lines = (async function* (self: Fake) { for (;;) { while (self.queue.length) yield self.queue.shift()!; if (self.closed) return; await new Promise<void>(r => { self.wake = r; }); } })(this);
}
const reply = (seq: number, terminals: unknown[]) => ({ id: 1, jsonrpc: "2.0", result: { seq, terminals } });

test("duplicate delivery of an event is emitted once", () => {
  const k = new LaneEventTracker(); k.reconcile([t("t1")], 5);
  const ev = { seq: 6, type: "finished", terminal: "t1", data: { reason: "exited" } };
  expect(kinds(k.apply(ev))).toEqual(["finished"]);
  expect(k.apply(ev)).toEqual([]);
  expect(k.apply({ ...ev, seq: 7 })).toEqual([]);
});
test("events at or below the snapshot seq are dropped", () => {
  const k = new LaneEventTracker(); k.reconcile([t("t1")], 9);
  expect(k.apply({ seq: 9, type: "status", terminal: "t1", data: { status: "working" } })).toEqual([]);
});
test("seq jumps from filtering do not lose events", () => {
  const k = new LaneEventTracker(); k.reconcile([t("t1")], 1);
  expect(kinds(k.apply({ seq: 40, type: "status", terminal: "t1", data: { status: "working" } }))).toEqual(["status"]);
});
test("gap recovery derives only the transitions that were missed", () => {
  const k = new LaneEventTracker(); k.reconcile([t("t1"), t("t2")], 1);
  expect(k.reconcile([t("t1", "finished"), t("t3")], 50).map(e => [e.terminal, e.kind])).toEqual([["t1", "finished"], ["t3", "created"], ["t2", "removed"]]);
  expect(k.reconcile([t("t1", "finished"), t("t3")], 51)).toEqual([]);
});
test("missed notification resyncs over the live stream", async () => {
  const f = new Fake(), got: LaneEvent[] = []; let saw!: () => void; const done = new Promise<void>(r => { saw = r; });
  const s = new HcLaneEvents(() => f);
  const started = s.start(e => { got.push(e); if (e.kind === "finished") saw(); });
  f.push(reply(1, [t("t1")])); await started;
  expect(s.live).toBe(true);
  f.push({ method: "missed", params: { seq: 9, terminals: [t("t1", "finished")] } }); await done;
  expect(kinds(got)).toEqual(["created", "finished"]); s.stop();
});
test("a core restart resets seq without replaying finished lanes", async () => {
  const a = new Fake(), b = new Fake(), got: LaneEvent[] = []; const q = [a, b]; let second!: () => void; const reconnected = new Promise<void>(r => { second = r; });
  const s = new HcLaneEvents(() => { const n = q.shift()!; if (n === b) { queueMicrotask(() => { b.push(reply(0, [t("t1", "finished"), t("t2")])); }); } return n; }, { retryMs: 0 });
  const started = s.start(e => { got.push(e); if (e.terminal === "t2") second(); });
  a.push(reply(30, [t("t1", "finished")])); await started;
  a.close(); await reconnected;
  expect(got.map(e => [e.terminal, e.kind])).toEqual([["t1", "finished"], ["t2", "created"]]); s.stop();
});
test("heartbeat silence forces a reconnect", async () => {
  const a = new Fake(), b = new Fake(); const q = [a, b]; let again!: () => void; const reconnected = new Promise<void>(r => { again = r; });
  const s = new HcLaneEvents(() => { const n = q.shift()!; if (n === b) again(); return n; }, { heartbeatTimeoutMs: 5, retryMs: 0 });
  const started = s.start(() => {}); a.push(reply(0, [])); await started; await reconnected;
  expect(a.closed).toBe(true); s.stop();
});
test("unavailable hc falls back and logs once", async () => {
  const lines: string[] = [];
  expect(await startLaneEvents({} as never, true, () => { throw new Error("ENOENT"); }, l => lines.push(l))).toBeNull();
  expect(lines).toEqual(["LANE_EVENTS_FALLBACK polling: herdr-core unavailable"]);
  expect(await startLaneEvents({} as never, false)).toBeNull();
});
test("pane polling yields to hc only for bound lanes while hc is live", async () => {
  const run = async () => ({ code: 0, out: JSON.stringify({ result: { panes: [] } }), err: "" });
  const lanes = [{ key: "bound", pane: "p1", hcTerminal: "t1", openedAt: new Date().toISOString() }, { key: "plain", pane: "p2", openedAt: new Date().toISOString() }];
  const reg = { open: async () => lanes } as never, cfg = { runtime: { heartbeatTimeoutMs: 1 } } as never;
  expect(await deadPaneTick(run as never, cfg, reg, Date.now(), x => x === "t1")).toEqual(["DEAD_PANE plain p2"]);
  expect(await deadPaneTick(run as never, cfg, reg, Date.now(), () => false)).toEqual(["DEAD_PANE bound p1", "DEAD_PANE plain p2"]);
});
test("object-shaped hc status is compared by its state word", () => {
  const k = new LaneEventTracker(); k.reconcile([t("t1")], 1);
  const ev = (seq: number) => ({ seq, type: "status", terminal: "t1", data: { status: { state: "blocked", ms: seq } } });
  expect(k.apply(ev(2)).map(e => e.status)).toEqual(["blocked"]);
  expect(k.apply(ev(3))).toEqual([]);
});
test("sink reports one death, clears the binding, and ignores closed lanes", async () => {
  let lane: any = { key: "a", openedAt: "x" }; const lines: string[] = [];
  const reg = { read: async () => lane, update: async (_: string, f: (l: any) => any) => (lane = f(lane)) } as never, sink = laneEventSink(reg, l => lines.push(l));
  await sink({ lane: "a", terminal: "t1", kind: "created" });
  expect(lane.hcTerminal).toBe("t1");
  await sink({ lane: "a", terminal: "t1", kind: "lost" });
  await sink({ lane: "a", terminal: "t1", kind: "finished" });
  await sink({ lane: "a", terminal: "t1", kind: "removed" });
  expect(lines).toEqual(["LANE_LOST a t1", "DEAD_PANE a t1"]);
  expect(lane.hcTerminal).toBeUndefined();
  lane = { key: "a", openedAt: "x", closedAt: "y", hcTerminal: "t1" };
  await sink({ lane: "a", terminal: "t1", kind: "finished" });
  expect(lines.length).toBe(2);
});
test("a live source stops vouching for a terminal after its connection drops", async () => {
  const a = new Fake(); let gone!: () => void; const dropped = new Promise<void>(r => { gone = r; });
  const s = new HcLaneEvents(() => { if (s.live === false && a.sent.length) gone(); return a; }, { retryMs: 0 });
  const started = s.start(() => {}); a.push(reply(0, [t("t1")])); await started;
  expect(s.tracks("t1")).toBe(true);
  a.close(); await dropped;
  expect(s.tracks("t1")).toBe(false); s.stop();
});
