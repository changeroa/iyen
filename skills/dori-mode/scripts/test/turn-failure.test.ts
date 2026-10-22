import { afterEach, beforeEach, expect, test } from "bun:test";
import { DoriService } from "../src/service.ts";
import { defaultConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { turnFailure } from "../src/turn-failure.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
let service: DoriService;
const lead: Lane = { key: "lead", role: "lead", title: "Lead", thread: "none", brief: "", done: "", openedAt: new Date().toISOString(),
  runtime: { kind: "codex", threadId: "thread1", state: "idle", hostInstanceId: "host1", generation: 1, binaryVersion: "0.163.0" } };
beforeEach(() => {
  state = withState(); world = newWorld();
  service = new DoriService({...defaultConfig(), stateDir: state.dir, hooks: {threadReply: ["notify", "{thread}", "{text}"]}}, fakeRunner(world));
});
afterEach(() => state.done());
const fail = (lane: Lane) => service.handle("host-event", {key:lane.key,instance:"host1",runtime:lane.runtime,
  event:{method:"turn/completed",params:{threadId:"thread1",turn:{id:"turn1",status:"failed",error:{codexErrorInfo:"unauthorized",message:"Authorization: Bearer sk-raw-secret\ncommand dump",additionalDetails:"private hostname"}}}}}, {role:"host",key:lane.key});

test("a healthy lead host's failed turn produces one sanitized notice in the originating thread after its receipt", async () => {
  await service.registry.write(lead);
  service.inbox.put({id:"owner1",target:"lead",thread:"slack:owner-thread",text:"task",state:"sending",at:new Date().toISOString()});
  await fail(lead); await service.notifyFailures();
  expect(service.outbox.list()).toHaveLength(0);
  service.inbox.mark("owner1",{state:"sent",turnId:"turn1"});
  await Promise.all([service.notifyFailures(),service.notifyFailures()]);
  await fail(lead);
  await service.handle("host-heartbeat",{key:"lead",instance:"host1",runtime:{...lead.runtime,state:"idle"}},{role:"host",key:"lead"});
  await service.notifyFailures();
  expect(service.outbox.list()).toHaveLength(1);
  expect(service.outbox.list()[0]).toMatchObject({target:"slack:owner-thread",state:"sent"});
  expect(service.outbox.list()[0]?.text).toContain("Check Codex authentication");
  expect(world.calls.filter(argv => argv[0] === "notify")).toHaveLength(1);
  expect(service.inbox.list()).toHaveLength(1); // no task replay or synthetic task input
  expect(JSON.stringify({failures:service.failures.list(),notices:service.outbox.list()})).not.toMatch(/sk-raw-secret|command dump|private hostname|Authorization/);
});

test("a lane failure queues exactly one actionable lead notice across restart and duplicate events", async () => {
  const lane = {...lead,key:"worker",role:"lane" as const,thread:"slack:work"};
  await service.registry.write(lane); await fail(lane); await service.notifyFailures();
  service = new DoriService(service.config, fakeRunner(world));
  await fail(lane); await service.notifyFailures();
  expect(service.inbox.list()).toHaveLength(1);
  expect(service.inbox.list()[0]).toMatchObject({target:"lead",thread:"slack:work",state:"queued"});
  expect(service.inbox.list()[0]?.text).toContain("Lane worker: Codex task failed");
  expect(service.outbox.list()).toHaveLength(0);
  expect(world.calls).toHaveLength(0);
});

test("an uncertain failure notice is retained and never blindly resent", async () => {
  service = new DoriService(service.config, async () => ({code:1,out:"",err:"failed"}));
  await service.registry.write(lead);
  service.inbox.put({id:"owner1",target:"lead",thread:"slack:owner-thread",turnId:"turn1",text:"task",state:"sent",at:new Date().toISOString()});
  await fail(lead); await service.notifyFailures();
  expect(service.outbox.list()[0]?.state).toBe("unknown");
  const retryWorld = newWorld(); service = new DoriService(service.config,fakeRunner(retryWorld));
  await fail(lead); await service.notifyFailures();
  expect(retryWorld.calls).toHaveLength(0);
  expect(service.outbox.list()[0]?.state).toBe("unknown");
});

test("failure metadata classifies errors without retaining raw details", () => {
  for (const [info,category] of [["usageLimitExceeded","usage-limit"],["badRequest","configuration"],["sandboxError","tools"],["unknown","runtime"]]) {
    expect(turnFailure({codexErrorInfo:info,additionalDetails:"secret"}).category).toBe(category!);
  }
});
