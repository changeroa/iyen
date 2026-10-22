import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", worktrees: [WT], openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect((world.runtimeCalls ?? []).some((t) => t.startsWith("Not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane merged acme/app#1 abc123"]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines.at(-1)).toStartWith("CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`uncommitted, untracked or unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`uncommitted, untracked or unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2: OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled.at(-1)).toStartWith("CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("LANE_NOT_DONE demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("direct close refuses untracked work even after live evidence passes", async () => {
 world.dirty="?? important.txt";
 const result=await closeLane(at(T0),lane,"manual");expect(result.closed).toBe(false);expect(closedVia()).toHaveLength(0);
 expect(world.calls.some(c=>c.includes("--untracked-files=all"))).toBe(true);
});
test("an objection received during slow verification invalidates cleanup", async () => {
 const d=at(T0);await claimDone(d,lane,"done");const claimed=(await d.registry.read(lane.key))!;
 let triggered=false;
 const slow={...d,run:async(argv:readonly string[],opts?:any)=>{
  if(!triggered && argv[0]==="gh") {triggered=true;await objectDone(d,(await d.registry.read(lane.key))!,["new requirement"]);}
  return d.run(argv,opts);
 }};
 await expect(closeLane(slow,claimed,"done")).rejects.toThrow("invalidated");expect(closedVia()).toHaveLength(0);
 expect((await d.registry.read(lane.key))?.status).toBe("not-done");
});
test("worktree removal failure never records closed",async()=>{
 const d=at(T0);const failing={...d,run:async(argv:readonly string[],opts?:any)=>argv.includes("remove")?{code:1,out:"",err:"busy"}:d.run(argv,opts)};
 expect((await closeLane(failing,lane,"done")).closed).toBe(false);expect((await d.registry.read(lane.key))?.status).toBe("verified-done");expect(closedVia()).toHaveLength(0);
});
test("duplicate claim does not extend the original deadline",async()=>{
 const d=at(T0);await claimDone(d,lane,"same evidence");const first=(await d.registry.read(lane.key))!.claim!.at;
 await claimDone(at(T0+MIN),lane,"same evidence");expect((await d.registry.read(lane.key))!.claim!.at).toBe(first);
});
