import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { DoriService } from "../src/service.ts";
import { atomicJson } from "../src/journal.ts";
import { bootstrapPath } from "../src/runtime/session-host.ts";
import type { Lane } from "../src/registry.ts";
import { withState, fakeRunner, fakeClock, newWorld } from "./fakes.ts";
let state:ReturnType<typeof withState>;let s:DoriService;
beforeEach(()=>{state=withState();s=new DoriService({...defaultConfig(),stateDir:state.dir,ingress:[{id:"test",command:["fixture"],owners:["owner"]}]},fakeRunner(newWorld()));});afterEach(()=>state.done());
const lane:Lane={key:"service-lane",title:"test",thread:"chat:1",brief:"/b",done:"closed a/b#1",openedAt:new Date().toISOString(),runtime:{kind:"codex",threadId:"t1",state:"idle",hostInstanceId:"host1",generation:1,binaryVersion:"0.163.0"}};
test("lane capabilities cannot launch, approve or control other lanes",async()=>{
 await s.registry.write(lane);
 for(const action of ["launch","pause","approval-respond","mail-resolve"])await expect(s.handle(action,{key:lane.key},{role:"lane",key:lane.key})).rejects.toThrow("capability");
 await expect(s.handle("report",{key:"other",text:"x",kind:"done",eventId:"r1"},{role:"lane",key:lane.key})).rejects.toThrow("capability");
});
test("host registration rejects stale generations and identity changes",async()=>{
 await s.registry.write(lane);
 await expect(s.handle("host-register",{key:lane.key,instance:"host0",runtime:lane.runtime},{role:"host",key:lane.key})).rejects.toThrow("Stale");
 await expect(s.handle("host-register",{key:lane.key,instance:"host1",runtime:{...lane.runtime,threadId:"different"}},{role:"host",key:lane.key})).rejects.toThrow("identity mismatch");
});
test("inbound owner identity, stable ID and thread are required; duplicate events enqueue once",async()=>{
 await s.registry.write(lane);const event={id:"m1",thread:"chat:1",user:"owner",text:"work"};
 await expect(s.receive("test",{...event,user:"stranger"})).rejects.toThrow("Untrusted");
 await s.receive("test",event);await s.receive("test",event);expect(s.inbox.list()).toHaveLength(1);expect(s.inbox.list()[0]?.target).toBe(lane.key);
});
test("paused lane receives durable queued input without starting a turn",async()=>{
 await s.registry.write({...lane,dispatchBlocked:true,status:"paused"});
 expect(await s.handle("input",{key:lane.key,text:"later",operationId:"m1"},{role:"admin"})).toMatchObject({queued:true});expect(s.inbox.get("m1")?.state).toBe("queued");
});
test("closed lane messages route to lead with original lane identity",async()=>{
 await s.registry.write({...lane,status:"closed",closedAt:new Date().toISOString()});await s.receive("test",{id:"m2",thread:"chat:1",user:"owner",text:"follow up"});
 expect(s.inbox.list()[0]).toMatchObject({target:"lead"});expect(s.inbox.list()[0]?.text).toContain("closed lane service-lane");
});
test("reports are explicit durable events and duplicate IDs cannot change content",async()=>{
 await s.registry.write(lane);const args={key:lane.key,text:"built",kind:"milestone",eventId:"r1"};
 await s.handle("report",args,{role:"lane",key:lane.key});await s.handle("report",args,{role:"lane",key:lane.key});
 expect(s.inbox.list()).toHaveLength(1);expect((await s.registry.read(lane.key))?.report?.text).toBe("built");
 await expect(s.handle("report",{...args,text:"different"},{role:"lane",key:lane.key})).rejects.toThrow("different content");
});
test("host fail-closed barrier survives reconnection to service",async()=>{
 await s.registry.write(lane);
 await s.handle("host-heartbeat",{key:lane.key,instance:"host1",runtime:{...lane.runtime,held:true}},{role:"host",key:lane.key});
 expect(await s.registry.read(lane.key)).toMatchObject({dispatchBlocked:true,holdReason:"recovery"});
});
test("host checkpoint restores a thread created before registration ACK was lost",async()=>{
 await s.registry.write({...lane,pane:"w:p1",runtime:{...lane.runtime!,threadId:undefined}});
 atomicJson(bootstrapPath(state.dir,lane.key),{instance:"old-host",hostToken:"fixture"});
 atomicJson(join(state.dir,"hosts",`${lane.key}.runtime.json`),{instance:"old-host",threadId:"created-before-crash"});
 await s.boot((await s.registry.read(lane.key))!);
 expect((await s.registry.read(lane.key))?.runtime?.threadId).toBe("created-before-crash");
});
test("ambiguous thread creation without a checkpoint cannot silently create another thread",async()=>{
 await s.registry.write({...lane,pane:"w:p1",runtime:{...lane.runtime!,threadId:undefined}});
 atomicJson(bootstrapPath(state.dir,lane.key),{instance:"old-host",hostToken:"fixture"});
 await expect(s.boot((await s.registry.read(lane.key))!)).rejects.toThrow("Thread creation outcome unknown");
});

test("lead timers preserve exact timestamps and duration across service restart", async () => {
 const clock = fakeClock(Date.parse("2026-10-22T00:00:00Z")); s.deps.clock = clock;
 const caller = { role: "lead" as const, key: "lead" };
 const args = { title: "Direct lookup", tags: ["DOCS", "docs"], thread: "slack:C/1", operationId: crypto.randomUUID() };
 const started = await s.handle("work-start", args, caller);
 expect(started).toMatchObject({workThresholdSec:120,work:{id:args.operationId,startedAt:"2026-10-22T00:00:00.000Z",tags:["docs"]}});
 clock.at += 120_500;
 s = new DoriService(s.config, fakeRunner(newWorld())); s.deps.clock = clock;
 expect(await s.handle("work-start", args, caller)).toEqual(started);
 const stopped = await s.handle("work-stop", {id:started.work.id}, caller);
 expect(stopped).toMatchObject({workThresholdSec:120,work:{startedAt:"2026-10-22T00:00:00.000Z",endedAt:"2026-10-22T00:02:00.500Z",elapsedSec:120.5}});
 const history = await s.handle("work-similar", {tags:["docs"]}, caller);
 expect(history.matches).toEqual([{...stopped.work,source:"direct"}]);
 await expect(s.handle("work-stop", {id:started.work.id}, caller)).rejects.toThrow("already stopped");
});

test("timer actions reject lane capabilities and invalid input before writing", async () => {
 for (const action of ["work-start", "work-stop", "work-similar"]) {
   await expect(s.handle(action, {}, {role:"lane",key:lane.key})).rejects.toThrow("capability");
 }
 for (const args of [{title:5},{title:"Task",tags:[false]},{title:"Task",thread:7},{title:"Task",operationId:"../bad"}]) {
   await expect(s.handle("work-start", args, {role:"lead",key:"lead"})).rejects.toThrow();
 }
 await expect(s.handle("work-similar", {}, {role:"lead",key:"lead"})).rejects.toThrow("title or tag");
});

test("concurrent stops serialize so only one completes a timer", async () => {
 const result = await s.handle("work-start", {title:"Task",operationId:crypto.randomUUID()}, {role:"admin"});
 const results = await Promise.allSettled([1,2].map(() => s.handle("work-stop", {id:result.work.id}, {role:"admin"})));
 expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
 expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
});
