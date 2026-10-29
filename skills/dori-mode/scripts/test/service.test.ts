import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { DoriService } from "../src/service.ts";
import { readJson } from "../src/ipc.ts";
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

test("TUI blocked transitions notify lead once, resolve durable notice, and permit a fresh notice",async()=>{
 await s.registry.write(lane);
 const event={id:"tui:t1:1",method:"tui/inputRequired",params:{pane:"w:p1",turnId:"turn1",message:"Inspect real TUI"}};
 const host={role:"host" as const,key:lane.key};
 await s.handle("host-event",{key:lane.key,instance:"host1",runtime:lane.runtime,event},host);
 await s.handle("host-event",{key:lane.key,instance:"host1",runtime:lane.runtime,event},host);
 expect(s.outbox.list()).toHaveLength(1);expect(s.inbox.list()).toHaveLength(1);
 await s.handle("host-event",{key:lane.key,instance:"host1",runtime:lane.runtime,event:{method:"tui/inputResolved",params:{requestId:event.id}}},host);
 expect(s.outbox.list()[0]?.state).toBe("sent");
 await s.handle("host-event",{key:lane.key,instance:"host1",runtime:lane.runtime,event:{...event,id:"tui:t1:2"}},host);
 expect(s.outbox.list()).toHaveLength(2);expect(s.inbox.list()).toHaveLength(2);
});
test("a live thread owner prevents recovery before creating a tab or touching runtime intent",async()=>{
 const world=newWorld();world.panes=[{pane_id:"other",workspace_id:"w",agent:"codex",agent_session:{value:"t1"}} as any];s=new DoriService(s.config,fakeRunner(world));await s.registry.write(lane);
 await expect(s.handle("recover",{key:lane.key},{role:"admin"})).rejects.toThrow("live TUI");
 expect(world.calls.some(a=>a[0]==="herdr"&&a[1]==="tab"&&a[2]==="create")).toBe(false);
 expect((await s.registry.read(lane.key))?.runtime?.threadId).toBe("t1");
});
test("legacy private-RPC sessions require an explicit preserved new-session handoff",async()=>{
 await s.registry.write({...lane,pane:"w:p1"});await expect(s.boot((await s.registry.read(lane.key))!)).rejects.toThrow("new-session");
 await expect(s.handle("recover",{key:lane.key,newSession:true,handoff:"summary"},{role:"lead",key:"lead"})).rejects.toThrow("operator");
});

test("explicit operator handoff archives legacy control state, preserves old identity and queues new session held",async()=>{
 const world=newWorld(),base=fakeRunner(world);
 s=new DoriService(s.config,async(argv,opts)=>argv[0]==="herdr"&&argv[1]==="tab"&&argv[2]==="create"?{code:0,err:"",out:JSON.stringify({result:{root_pane:{pane_id:"new-pane",tab_id:"new-tab"},tab_id:"new-tab"}})}:base(argv,opts));
 await s.registry.write({...lane,pane:"old-pane"});atomicJson(bootstrapPath(state.dir,lane.key),{instance:"host1",hostToken:"old-token"});
 s.inbox.put({id:"uncertain",target:lane.key,text:"unknown side effect",state:"unknown",at:new Date().toISOString()});
 await s.handle("recover",{key:lane.key,newSession:true,handoff:"Confirmed A; B remains uncertain",operationId:"migration1"},{role:"admin"});
 const current=(await s.registry.read(lane.key))!;
 expect(current.runtimeHistory?.[0]?.threadId).toBe("t1");expect(current.runtime?.threadId).toBeUndefined();expect(current.runtime?.backend).toBe("herdr-tui");expect(current.dispatchBlocked).toBe(true);
 expect(s.inbox.get("migration1")).toMatchObject({state:"queued",target:lane.key});expect(s.inbox.get("migration1")?.text).toContain("Confirmed A");expect(s.inbox.get("uncertain")?.state).toBe("unknown");
 expect(await Bun.file(join(state.dir,"hosts/history/service-lane-1-t1/service-lane.json")).json()).toMatchObject({instance:"host1"});
});

// A read-only observer transport keeps recovery tests in process; socket-level
// protocol coverage belongs to the external-session and integration fixtures.
async function externalFixture() {
 const { ExternalSessionError, sharedDaemon } = await import("../src/runtime/external-current-session.ts");
 const threadId="11111111-1111-4111-8111-111111111111", pane="test:pane", socketPath=join(state.dir,"exact-daemon.sock");
 let version="0.200.0", offline=false, identity=threadId, reportedSocket=socketPath;
 const calls:string[][]=[],turns:any[]=[];
 const observer={close(){},async read<T>(method:string):Promise<T>{
  return (method==="thread/read"?{thread:{id:threadId,cwd:state.dir,status:{type:"idle"}}}:method==="thread/loaded/list"?{data:[threadId],nextCursor:null}:method==="thread/turns/list"?{data:turns,nextCursor:null}:{goal:null}) as T;
 }};
 const runner:import("../src/run.ts").Runner=async argv=>{
  calls.push([...argv]);
  if(argv[1]==="app-server") {if(offline)throw new Error("Bearer secret-token /private/socket");return {code:0,err:"",out:JSON.stringify({status:"running",cliVersion:version,appServerVersion:version,socketPath:reportedSocket})};}
  if(argv[1]==="queue"&&argv[2]==="--help")return {code:0,err:"",out:"queue --thread <ID> --message <TEXT>"};
  if(argv[0]==="herdr")return {code:0,err:"",out:JSON.stringify({result:{agent:{agent:"codex",pane_id:pane,agent_status:"idle",agent_session:{agent:"codex",kind:"id",value:identity}}}})};
  if(argv[1]==="queue"){turns.push({id:`turn-${turns.length}`,status:"completed",items:[{type:"userMessage",content:[{type:"text",text:argv[5]}]}]});return {code:0,err:"",out:"queued"};}
  throw new Error("Unexpected mutation");
 };
 const transport:import("../src/service.ts").ExternalTransport={connect:async()=>observer,observe:async(run,config,attachment,action)=>{
  const daemon=await sharedDaemon(run,attachment.binary,config);
  if(daemon.socketPath!==attachment.socketPath)throw new ExternalSessionError("identity-unverified","Shared Codex daemon affinity changed; explicit attachment required.");
  if(daemon.binaryVersion!==attachment.binaryVersion)throw new ExternalSessionError("runtime-version-changed","Shared Codex runtime version changed; verified reconnection required.");
  return action(observer);
 }};
 const config={...s.config,runtime:{...s.config.runtime,binary:process.execPath},hooks:{}};
 atomicJson(join(state.dir,"control.json"),{token:"admin"});
 s=new DoriService(config,runner,transport); const clock=fakeClock(Date.now());s.deps.clock=clock;
 const args={threadId,pane,cwd:state.dir};
 await s.handle("lead-attach",args,{role:"admin"});
 const attachment=()=>readJson<any>(join(state.dir,"attachments/lead.json"));
 return {args,calls,clock,config,runner,transport,attachment,version(v:string){version=v;},offline(v=true){offline=v;},identity(v=threadId){identity=v;},socket(v:string){reportedSocket=v;},queues:()=>calls.filter(argv=>argv[1]==="queue"&&argv[2]!=="--help")};
}

test("automatic upgrade reconnect preserves capability and exclusions and delivers only eligible queued mail once",async()=>{
 const h=await externalFixture(),old=h.attachment();
 s.inbox.put({id:"history",target:"lead",text:"old history",state:"queued",at:"2020-01-01"});
 old.excludedInboxIds.push("history");atomicJson(join(state.dir,"attachments/lead.json"),old);
 for(const mailState of ["queued","unknown","sending"] as const)s.inbox.put({id:mailState,target:"lead",text:mailState,state:mailState,at:"2020-01-01",attachmentInstance:old.instance});
 h.version("0.201.0");
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"ready",runtime:{binaryVersion:"0.201.0"}});
 for(const key of ["instance","generation","token","bridge","socketPath","threadId","pane","cwd","excludedInboxIds"])expect(h.attachment()[key]).toEqual(old[key]);
 expect(await s.authorize(old.token)).toMatchObject({instance:old.instance});expect(h.queues()).toHaveLength(0);
 await s.tick();expect(s.inbox.get("queued")?.state).toBe("sent");expect(s.inbox.get("history")?.state).toBe("queued");expect(s.inbox.get("unknown")?.state).toBe("unknown");expect(s.inbox.get("sending")?.state).toBe("sending");expect(h.queues()).toHaveLength(1);
 s=new DoriService(h.config,h.runner,h.transport);await s.tick();expect(s.inbox.get("sending")?.state).toBe("unknown");expect(h.queues()).toHaveLength(1);
});

test("offline reconnect retries use durable capped backoff and unchanged polls cause no writes or discovery",async()=>{
 const h=await externalFixture(),old=h.attachment();h.offline();
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"held"});
 const held=(await s.registry.read("lead"))!,count=h.calls.length;
 await s.handle("status",{key:"lead"},{role:"admin"});expect(h.calls.length).toBe(count);expect(await s.registry.read("lead")).toEqual(held);
 for(let attempt=0;attempt<9;attempt++){
  h.clock.at+=120000;await s.handle("status",{key:"lead"},{role:"admin"});
  const retry=(await s.registry.read("lead"))!.runtime!.external!.reconnect!;
  expect(Date.parse(retry.nextAttemptAt)-h.clock.now()).toBeGreaterThan(0);expect(Date.parse(retry.nextAttemptAt)-h.clock.now()).toBeLessThanOrEqual(60000);
 }
 h.offline(false);h.clock.at+=120000;
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"ready"});expect(h.attachment().token).toBe(old.token);expect(h.queues()).toHaveLength(0);
});

test("identity replacement latches a manual hold even after the original session reappears",async()=>{
 const h=await externalFixture();h.identity("22222222-2222-4222-8222-222222222222");
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"held"});h.identity();h.clock.at+=120000;
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"held",identityVerified:true});
 expect((await s.registry.read("lead"))!.runtime!.external!.reconnectBlocked).toBe(true);
 await s.handle("lead-attach",h.args,{role:"admin"});expect((await s.registry.read("lead"))!.dispatchBlocked).toBe(false);expect(h.queues()).toHaveLength(0);
});

for(const holdReason of ["owner-pause","done-review"] as const)test(`automatic upgrade reconnect preserves ${holdReason}`,async()=>{
 const h=await externalFixture();await s.registry.update("lead",lane=>({...lane,dispatchBlocked:true,holdReason,runtime:{...lane.runtime!,held:true}}));
 h.version("0.201.0");await s.handle("status",{key:"lead"},{role:"admin"});h.clock.at+=120000;await s.tick();
 expect(await s.registry.read("lead")).toMatchObject({dispatchBlocked:true,holdReason});expect(h.queues()).toHaveLength(0);
});

test("interrupted binary rebind automatically repairs either durable side without replacing capability",async()=>{
 const h=await externalFixture(),old=h.attachment(),update=s.registry.update.bind(s.registry);let armed=true;
 s.registry.update=async(key,fn)=>{const result=await update(key,fn);if(armed&&result.runtime?.external?.rebind){armed=false;throw new Error("injected write failure");}return result;};
 h.version("0.201.0");await expect(s.handle("lead-attach",h.args,{role:"admin"})).rejects.toThrow("rebind is incomplete");
 expect(await s.authorize(old.token)).toMatchObject({instance:old.instance});
 s=new DoriService(h.config,h.runner,h.transport);await s.tick();
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"ready",runtime:{binaryVersion:"0.201.0"}});
 expect(h.attachment().token).toBe(old.token);expect(h.attachment().generation).toBe(old.generation);expect(h.queues()).toHaveLength(0);
});

test("health reports sanitized causes, queue age and ingress evidence without credentials",async()=>{
 const h=await externalFixture(),old=h.attachment();h.offline();await s.handle("status",{key:"lead"},{role:"admin"});
 s.inbox.put({id:"old",target:"lead",text:"private message",state:"queued",at:"2020-01-01"});s.inbox.put({id:"unknown-health",target:"lead",text:"private message",state:"unknown",at:"2020-01-01"});
 s.setIngressProcess("test","running");
 const health=await s.handle("health",{},{role:"admin"});
 expect(health).toMatchObject({schemaVersion:1,phase:"ready",pid:process.pid,replay:{records:expect.any(Number),lanes:expect.any(Number)},delivery:{state:"held",latestCause:{code:"runtime-unavailable"}},queue:{queued:1,unknown:1,oldestQueuedAgeMs:expect.any(Number)},ingress:[{id:"test",process:"running",connection:"unverified",lastAcceptedAt:null}]});
 expect(JSON.stringify(health)).not.toMatch(/secret-token|private message|Bearer|private\/socket/);expect(JSON.stringify(health)).not.toContain(old.token);
 const caller=await s.authorize(old.token);expect(await s.handle("health",{},caller)).toEqual(health);
 await expect(s.handle("health",{},{role:"lane",key:lane.key})).rejects.toThrow("Health requires");
});

test("failed normal observation followed by successful exact rebind is bounded to one recovery",async()=>{
 const h=await externalFixture();const {ExternalSessionError}=await import("../src/runtime/external-current-session.ts");let observations=0;
 h.transport.observe=async()=>{observations++;throw new ExternalSessionError("runtime-unavailable","Shared Codex observer unavailable; delivery is waiting for reconnection.");};
 expect(await s.handle("status",{key:"lead"},{role:"admin"})).toMatchObject({readiness:"ready"});
 expect(observations).toBe(1);expect(h.queues()).toHaveLength(0);
});
