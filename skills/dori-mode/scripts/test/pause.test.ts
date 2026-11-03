import { afterEach, beforeEach, expect, test } from "bun:test";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
let state: ReturnType<typeof withState>;
beforeEach(() => state = withState()); afterEach(() => state.done());
const lane: Lane = { key: "pause-lane", title: "test", thread: "none", brief: "/brief", done: "closed acme/repo#1", openedAt: new Date(1000).toISOString(), status: "working" };
test("pause stops runtime before marking paused and explicit resume restores status", async () => {
 const w = newWorld(), clock = fakeClock(1000), d = depsFor(w,clock,state.dir);
 await d.registry.write({ ...lane, status: "not-done" });
 const paused = await pauseLane(d,(await d.registry.read(lane.key))!,"wait");
 expect(paused.code).toBe(0); expect(paused.lane.dispatchBlocked).toBe(true); expect(w.runtimeCalls).toEqual(["hold"]);
 clock.at += 100000;
 const resumed = await resumeLane(d,paused.lane,"go");
 expect(resumed.code).toBe(0); expect(resumed.lane.status).toBe("not-done"); expect(resumed.lane.dispatchBlocked).toBe(false); expect(resumed.lane.lastReplyAt).toBe(clock.at);
});
test("failed pause persists dispatch barrier across restart and prevents nudges", async () => {
 const w = newWorld(); w.holdFails = true;
 const d = depsFor(w,fakeClock(1000),state.dir); await d.registry.write(lane);
 expect((await pauseLane(d,lane,"wait")).code).toBe(3);
 const restarted = depsFor(w,fakeClock(10000000),state.dir);
 expect((await restarted.registry.read(lane.key))?.dispatchBlocked).toBe(true);
 expect(await freshnessTick(restarted,"/home/test")).toEqual([]);
 expect(w.runtimeCalls).toEqual(["hold"]);
});
test("pause cannot stop a closing lane and resume cannot wake a working lane", async () => {
 const d = depsFor(newWorld(),fakeClock(1000),state.dir);
 expect((await pauseLane(d,{ ...lane, status: "done-claimed" },"wait")).code).toBe(2);
 expect((await resumeLane(d,lane,"go")).code).toBe(2);
});

for (const kind of ["omp", "codex"] as const) test(`${kind} idle freshness preserves the runtime-specific automatic progress policy`, async () => {
 const w = newWorld(), clock = fakeClock(10000000), d = depsFor(w,clock,state.dir);
 await d.registry.write({ ...lane, runtime: { kind, backend: "herdr-tui", threadId: "native-session", state: "idle",
   hostInstanceId: "host", generation: 1, binaryVersion: "18.15.0" } });
 const acts = await freshnessTick(d,"/home/test");
 expect(w.runtimeCalls?.length ?? 0).toBe(kind === "omp" ? 0 : 1);
 expect((await d.registry.read(lane.key))?.lastNudgeAt).toBe(kind === "omp" ? undefined : clock.at);
 expect(acts.map(act => act.kind)).toEqual(kind === "omp" ? [] : ["nudged"]);
});
