import { afterEach, beforeEach, expect, test } from "bun:test";
import { herdrProgressTick } from "../src/herdr-progress.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const lead: Lane = { key: "lead", role: "lead", title: "Iyen", thread: "none", pane: "w1:p1", brief: "", done: "",
  openedAt: "2026-10-25T00:00:00Z", runtime: { kind: "codex", backend: "external-current-session", threadId: "lead-thread",
    state: "idle", hostInstanceId: "lead-instance", generation: 1, binaryVersion: "0.164.0",
    external: { socketPath: "/tmp/lead.sock", binary: "/bin/codex", bridge: "/tmp/bridge" } } };
const lane: Lane = { key: "worker", role: "lane", title: "Work", thread: "slack:C/1", pane: "w1:p2", brief: "", done: "",
  openedAt: "2026-10-25T00:00:00Z", runtime: { kind: "codex", threadId: "worker-thread", state: "running",
    hostInstanceId: "worker-instance", generation: 1, binaryVersion: "0.163.0" } };

test("Herdr progress posts state transitions once to the registered thread, including after service restart", async () => {
  const world = newWorld();
  const agent = { pane_id: "w1:p2", workspace_id: "w1", agent: "codex", agent_status: "working",
    agent_session: { agent: "codex", kind: "id", value: "worker-thread" } };
  world.panes = [agent];
  const deps = depsFor(world, fakeClock(0), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const posted: { id: string; thread: string; text: string }[] = [];
  deps.post = async (id, _hook, values) => { posted.push({ id, thread: values.thread!, text: values.text! }); };
  await deps.registry.write(lead); await deps.registry.write(lane);
  await herdrProgressTick(deps); await herdrProgressTick(deps);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ thread: "slack:C/1", text: expect.stringContaining("작업 진행 중") });
  agent.agent_status = "blocked"; await herdrProgressTick(deps);
  agent.agent_status = "idle"; await herdrProgressTick(deps);
  agent.agent_status = "done"; await herdrProgressTick(deps);
  expect(posted).toHaveLength(3);
  expect((await deps.registry.read("worker"))?.lastReplyAt).toBe(0);
  expect(posted.map(row => row.id)).toEqual([
    "herdr-progress:worker:worker-instance:1", "herdr-progress:worker:worker-instance:2", "herdr-progress:worker:worker-instance:3",
  ]);
  const restarted = depsFor(world, fakeClock(0), state.dir, deps.config);
  restarted.post = deps.post;
  await herdrProgressTick(restarted);
  expect(posted).toHaveLength(3);
});

test("detached Iyen never queries Herdr, and mismatched pane identity cannot post", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w1:p2", workspace_id: "w1", agent: "codex", agent_status: "working",
    agent_session: { agent: "codex", kind: "id", value: "different-thread" } }];
  const deps = depsFor(world, fakeClock(0), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const posted: string[] = [];
  deps.post = async (_id, _hook, values) => { posted.push(values.text!); };
  await deps.registry.write(lane);
  await herdrProgressTick(deps);
  expect(world.calls).toHaveLength(0);
  await deps.registry.write(lead);
  await herdrProgressTick(deps);
  expect(posted).toHaveLength(0);
  await deps.registry.update("lead", current => ({ ...current, dispatchBlocked: true,
    runtime: { ...current.runtime!, state: "stopped", external: { ...current.runtime!.external!, detachedAt: "2026-10-25T01:00:00Z" } } }));
  world.calls.length = 0;
  await herdrProgressTick(deps);
  expect(world.calls).toHaveLength(0);
});

test("attached lead reports only turns mapped to an owner thread and recognizes a new turn", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", agent: "codex", agent_status: "working",
    agent_session: { agent: "codex", kind: "id", value: "lead-thread" } }];
  const deps = depsFor(world, fakeClock(0), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const posted: string[] = [];
  deps.post = async (_id, _hook, values) => { posted.push(`${values.thread}: ${values.text}`); };
  await deps.registry.write({ ...lead, runtime: { ...lead.runtime!, activeTurnId: "unmapped" } });
  await herdrProgressTick(deps, () => undefined);
  expect(posted).toHaveLength(0);
  await deps.registry.update("lead", current => ({ ...current, runtime: { ...current.runtime!, activeTurnId: "turn-1" } }));
  const threadForTurn = (id: string) => id === "turn-1" ? "slack:C/1" : id === "turn-2" ? "slack:C/2" : undefined;
  await herdrProgressTick(deps, threadForTurn);
  await deps.registry.update("lead", current => ({ ...current, runtime: { ...current.runtime!, activeTurnId: "turn-2" } }));
  await herdrProgressTick(deps, threadForTurn);
  expect(posted).toEqual(["slack:C/1: 이연: 작업 진행 중입니다.", "slack:C/2: 이연: 작업 진행 중입니다."]);
  world.panes[0]!.agent_status = "idle";
  await herdrProgressTick(deps, threadForTurn);
  expect(posted.at(-1)).toStartWith("slack:C/2: 이연: 현재 응답을 마쳤습니다.");
});
