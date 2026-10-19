import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { Registry, type Lane } from "../src/registry.ts";
import { WorkTimers } from "../src/work.ts";
import { fakeClock, withState } from "./fakes.ts";

const states: ReturnType<typeof withState>[] = [];
afterEach(() => { for (const state of states.splice(0)) state.done(); });
const setup = () => {
  const state = withState();
  states.push(state);
  const clock = fakeClock(Date.parse("2026-10-19T00:00:00Z"));
  return { state, clock, timers: new WorkTimers(state.dir, clock) };
};

test("stop persists timestamps and exact elapsed seconds after a restart", async () => {
  // Given a persisted timer with tags and a messenger thread.
  const { state, clock, timers } = setup();
  const work = await timers.start("Draw screen", ["Design", "design"], "slack:C/1");
  clock.at += 120_500;
  // When a new module instance stops it.
  const stopped = await new WorkTimers(state.dir, clock).stop(work.id);
  // Then elapsed time and metadata survive in a readable file.
  expect(stopped).toEqual({
    ...work, tags: ["design"], thread: "slack:C/1",
    startedAt: "2026-10-19T00:00:00.000Z", endedAt: "2026-10-19T00:02:00.500Z", elapsedSec: 120.5,
  });
  expect(await Bun.file(join(timers.dir, `${work.id}.json`)).json()).toEqual(stopped);
});

test("stop refuses missing work and path traversal", async () => {
  const { timers } = setup();
  await expect(timers.stop("00000000-0000-0000-0000-000000000000")).rejects.toThrow("no started work");
  await expect(timers.stop("../lanes/demo")).rejects.toThrow("invalid work id");
});

test("stopping completed work again preserves the original record", async () => {
  const { clock, timers } = setup();
  const work = await timers.start("Lookup");
  clock.at += 42_000;
  await timers.stop(work.id);
  const file = Bun.file(join(timers.dir, `${work.id}.json`));
  const before = await file.text();
  clock.at += 100_000;
  await expect(timers.stop(work.id)).rejects.toThrow("already stopped");
  expect(await file.text()).toBe(before);
});

test("similar title matching finds Korean inflections without relying on spaces", async () => {
  const { clock, timers } = setup();
  const work = await timers.start("피그마화면그리기");
  clock.at += 180_000;
  await timers.stop(work.id);
  const matches = await timers.similar("피그마화면수정");
  expect(matches.map((m) => [m.id, m.elapsedSec])).toEqual([[work.id, 180]]);
});

test("tag matching is normalized and excludes unfinished and unrelated work", async () => {
  const { clock, timers } = setup();
  const work = await timers.start("Draw", ["DESIGN"]);
  clock.at += 2_000;
  await timers.stop(work.id);
  await timers.start("Still running", ["design"]);
  const other = await timers.start("Lookup", ["finance"]);
  await timers.stop(other.id);
  const matches = await timers.similar("", ["design"]);
  expect(matches.map((m) => m.id)).toEqual([work.id]);
  expect(await timers.similar("unrelated")).toEqual([]);
});

test("closed lane durations join direct history without rewriting registry files", async () => {
  const { state, clock, timers } = setup();
  const registry = new Registry(state.dir);
  const lane: Lane = {
    key: "old-drawing", title: "피그마 화면 그리기", thread: "slack:C/2", brief: "", done: "",
    openedAt: "2026-10-18T00:00:00Z", closedAt: "2026-10-18T00:03:30Z",
  };
  await registry.write(lane);
  await registry.write({ ...lane, key: "running-drawing", closedAt: undefined });
  const before = await Bun.file(registry.path(lane.key)).text();
  const work = await timers.start("피그마 화면 수정");
  clock.at += 60_000;
  await timers.stop(work.id);
  const matches = await timers.similar("피그마 화면");
  expect(matches.map((m) => [m.source, m.elapsedSec])).toEqual([["direct", 60], ["lane", 210]]);
  expect(await Bun.file(registry.path(lane.key)).text()).toBe(before);
});

test("empty lookup is rejected and empty history creates no registry directory", async () => {
  const { state, timers } = setup();
  await expect(timers.similar()).rejects.toThrow("similar needs a title or tag");
  expect(await timers.similar("missing")).toEqual([]);
  expect(await Bun.file(join(state.dir, "lanes")).exists()).toBe(false);
  await expect(timers.start("  ")).rejects.toThrow("work title is required");
});

test("a backward clock fails without destroying the started timer", async () => {
  const { clock, timers } = setup();
  const work = await timers.start("Lookup");
  clock.at -= 1;
  await expect(timers.stop(work.id)).rejects.toThrow("end precedes");
  clock.at += 1;
  expect((await timers.stop(work.id)).elapsedSec).toBe(0);
});

test("the CLI reports a missing timer as a concise failure rather than an unhandled exception", async () => {
  const { state } = setup();
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "work", "stop", "00000000-0000-0000-0000-000000000000"], {
    env: { ...process.env, DORI_CONFIG: join(state.dir, "missing.json"), DORI_STATE_DIR: state.dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(err.trim()).toBe('no started work "00000000-0000-0000-0000-000000000000"');
});
