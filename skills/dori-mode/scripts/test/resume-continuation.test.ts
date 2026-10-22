import { afterEach, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { DoriService } from "../src/service.ts";
import { atomicJson } from "../src/journal.ts";
import { hostSocket } from "../src/ipc.ts";
import { bootstrapPath } from "../src/runtime/session-host.ts";
import { CodexSession } from "../src/runtime/codex.ts";
import { RpcClient } from "../src/runtime/protocol.ts";
import type { Lane } from "../src/registry.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const setup = async (options: {running?: boolean; goal?: boolean; unknown?: boolean} = {}) => {
  const state = withState(); cleanups.push(state.done);
  let running = options.running ?? true, goal = options.goal ? "active" : null;
  let starts = 0, interrupts = 0;
  const rpc = new RpcClient({send: line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result: any = {};
    switch (message.method) {
      case "thread/read": result = {thread:{id:"thread1",status:running?{type:"active",activeFlags:[]}:{type:"idle"}}}; break;
      case "thread/goal/get": result = {goal:goal?{status:goal,objective:"work",tokenBudget:null}:null}; break;
      case "thread/goal/set": goal = message.params.status; result = {goal:{status:goal}}; break;
      case "thread/turns/list": result = {data:[{id:starts?"continued":"turn1",status:"inProgress"}],nextCursor:null}; break;
      case "turn/interrupt": interrupts++; running = false; break;
      case "turn/start": starts++; if (options.unknown) return; running = true; result = {turn:{id:"continued",status:"inProgress"}}; break;
      case "turn/steer": result = {turnId:"continued"}; break;
    }
    queueMicrotask(() => rpc.feed(JSON.stringify({id:message.id,result})+"\n"));
  },close:()=>{}},30);
  cleanups.push(() => rpc.disconnect());
  const config = {...defaultConfig(),stateDir:state.dir};
  const session = new CodexSession(rpc,config.runtime); session.threadId = "thread1";
  const server = Bun.serve({unix:hostSocket(state.dir,"resume-lane"),async fetch(request) {
    try {
      const {action,args} = await request.json() as any;
      const result = action === "inspect" ? await session.inspect() : action === "hold" ? await session.hold(args.origin) : action === "release" ? await session.release(args.origin) : await session.input(args.text,args.operationId);
      return Response.json({result});
    } catch (error) { return Response.json({error:String(error)},{status:409}); }
  }});
  cleanups.push(() => server.stop(true));
  atomicJson(bootstrapPath(state.dir,"resume-lane"),{hostToken:"fixture"});
  const lane: Lane = {key:"resume-lane",role:"lane",title:"Task",thread:"chat:task",brief:"",done:"",openedAt:new Date().toISOString(),
    runtime:{kind:"codex",threadId:"thread1",state:running?"running":"idle",hostInstanceId:"fixture",generation:1,binaryVersion:config.runtime.requiredVersion}};
  const service = new DoriService(config,fakeRunner(newWorld())); await service.registry.write(lane);
  const call = (action:string) => service.handle(action,{key:lane.key},{role:"admin"});
  return {service,config,session,call,key:lane.key,starts:()=>starts,interrupts:()=>interrupts};
};

test("goal-less running task resumes once through a durable continuation after restart", async () => {
  const h = await setup(); expect((await h.call("pause")).code).toBe(0);
  const paused = await h.service.registry.read(h.key);
  expect(paused?.pausedContinuation?.interruptedTurnId).toBe("turn1"); expect(h.interrupts()).toBe(1);
  const restarted = new DoriService(h.config,fakeRunner(newWorld()));
  expect((await restarted.handle("resume",{key:h.key},{role:"admin"})).code).toBe(0);
  const pending = restarted.inbox.list()[0]!;
  expect(pending).toMatchObject({id:paused!.pausedContinuation!.id,state:"queued",target:h.key});
  expect(pending.text).toContain("Do not replay the original request");
  await restarted.tick();
  expect(h.starts()).toBe(1); expect(restarted.inbox.get(pending.id)?.state).toBe("sent");
  expect((await restarted.handle("resume",{key:h.key},{role:"admin"})).code).toBe(2);
  await restarted.tick(); expect(h.starts()).toBe(1);
});

test("idle pause/resume and native-goal resume do not start an extra turn", async () => {
  for (const options of [{running:false},{goal:true}]) {
    const h = await setup(options);
    expect((await h.call("pause")).code).toBe(0); expect((await h.call("resume")).code).toBe(0);
    await h.service.tick(); expect(h.starts()).toBe(0); expect(h.service.inbox.list()).toHaveLength(0);
    if (options.goal) expect((await h.session.inspect()).goal?.status).toBe("active");
  }
});

test("automatic release never queues owner continuation", async () => {
  const h = await setup(); await h.call("pause");
  await h.service.deps.runtime.release(h.key,"automatic");
  await h.service.tick(); expect(h.starts()).toBe(0); expect(h.service.inbox.list()).toHaveLength(0);
});

test("ambiguous continuation delivery remains unknown across restart without replay", async () => {
  const h = await setup({unknown:true}); await h.call("pause"); await h.call("resume");
  await h.service.tick(); expect(h.starts()).toBe(1);
  expect(h.service.inbox.list()[0]?.state).toBe("unknown");
  const restarted = new DoriService(h.config,fakeRunner(newWorld()));
  await restarted.tick(); expect(h.starts()).toBe(1);
  expect(restarted.inbox.list()[0]?.state).toBe("unknown");
});

test("a crash after enqueue but before clearing the barrier reuses the same continuation", async () => {
  const h = await setup(); await h.call("pause");
  const queue = h.service.deps.queueInput!;
  h.service.deps.queueInput = async (...args) => { await queue(...args); throw new Error("crash after enqueue"); };
  expect((await h.call("resume")).code).toBe(3);
  expect((await h.service.registry.read(h.key))?.dispatchBlocked).toBe(true);
  const pendingId = h.service.inbox.list()[0]?.id;
  const restarted = new DoriService(h.config,fakeRunner(newWorld()));
  expect((await restarted.handle("resume",{key:h.key},{role:"admin"})).code).toBe(0);
  expect(restarted.inbox.list().map(row=>row.id)).toEqual([pendingId!]);
  await restarted.tick(); expect(h.starts()).toBe(1);
});
