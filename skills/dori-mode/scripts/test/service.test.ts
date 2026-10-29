import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { DoriService } from "../src/service.ts";
import { readJson } from "../src/ipc.ts";
import { atomicJson } from "../src/journal.ts";
import { bootstrapPath } from "../src/runtime/session-host.ts";
import { operationText } from "../src/runtime/herdr.ts";
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
async function externalFixture(notifications = false) {
 const { ExternalSessionError, sharedDaemon } = await import("../src/runtime/external-current-session.ts");
 const threadId="11111111-1111-4111-8111-111111111111", pane="test:pane", socketPath=join(state.dir,"exact-daemon.sock");
 let version="0.200.0", offline=false, identity=threadId, reportedSocket=socketPath, accept=true;
 let threadStatus:any={type:"idle"}, agentStatus="idle";
 const calls:string[][]=[],turns:any[]=[];
 const observer={close(){},async read<T>(method:string):Promise<T>{
  return (method==="thread/read"?{thread:{id:threadId,cwd:state.dir,status:threadStatus}}:method==="thread/loaded/list"?{data:[threadId],nextCursor:null}:method==="thread/turns/list"?{data:turns,nextCursor:null}:{goal:null}) as T;
 }};
 const runner:import("../src/run.ts").Runner=async argv=>{
  calls.push([...argv]);
  if(argv[0]==="notify")return {code:0,err:"",out:""};
  if(argv[1]==="app-server") {if(offline)throw new Error("Bearer secret-token /private/socket");return {code:0,err:"",out:JSON.stringify({status:"running",cliVersion:version,appServerVersion:version,socketPath:reportedSocket})};}
  if(argv[1]==="queue"&&argv[2]==="--help")return {code:0,err:"",out:"queue --thread <ID> --message <TEXT>"};
  if(argv[0]==="herdr"&&argv[2]==="prompt"){
   if(accept)turns[0].items.push({type:"userMessage",content:[{type:"text",text:argv[4]}]});
   return {code:0,err:"",out:"submitted"};
  }
  if(argv[0]==="herdr"){
   const agent={agent:"codex",pane_id:pane,agent_status:agentStatus,agent_session:{agent:"codex",kind:"id",value:identity}};
   return {code:0,err:"",out:JSON.stringify({result:argv[2]==="list"?{agents:[agent]}:{agent}})};
  }
  if(argv[1]==="queue"){turns.push({id:`turn-${turns.length}`,status:"completed",items:[{type:"userMessage",content:[{type:"text",text:argv[5]}]}]});return {code:0,err:"",out:"queued"};}
  throw new Error("Unexpected mutation");
 };
 const transport:import("../src/service.ts").ExternalTransport={connect:async()=>observer,observe:async(run,config,attachment,action)=>{
  const daemon=await sharedDaemon(run,attachment.binary,config);
  if(daemon.socketPath!==attachment.socketPath)throw new ExternalSessionError("identity-unverified","Shared Codex daemon affinity changed; explicit attachment required.");
  if(daemon.binaryVersion!==attachment.binaryVersion)throw new ExternalSessionError("runtime-version-changed","Shared Codex runtime version changed; verified reconnection required.");
  return action(observer);
 }};
 const config={...s.config,runtime:{...s.config.runtime,binary:process.execPath,rpcTimeoutMs:80},hooks:notifications?{threadReply:["notify","{thread}","{text}"]}:{}};
 atomicJson(join(state.dir,"control.json"),{token:"admin"});
 s=new DoriService(config,runner,transport); const clock=fakeClock(Date.now());s.deps.clock=clock;
 const args={threadId,pane,cwd:state.dir};
 await s.handle("lead-attach",args,{role:"admin"});
 const attachment=()=>readJson<any>(join(state.dir,"attachments/lead.json"));
 return {args,calls,clock,config,runner,transport,attachment,turns,
  busy(){threadStatus={type:"active",activeFlags:[]};agentStatus="working";turns.push({id:"running-turn",status:"inProgress",items:[]});},
  status(value:string){agentStatus=value;if(value==="idle"||value==="done"){threadStatus={type:"idle"};for(const turn of turns)turn.status="completed";}},
  waiting(flag:string){threadStatus={type:"active",activeFlags:[flag]};},noReceipt(){accept=false;},
  version(v:string){version=v;},offline(v=true){offline=v;},identity(v=threadId){identity=v;},socket(v:string){reportedSocket=v;},
  prompts:()=>calls.filter(argv=>argv[0]==="herdr"&&argv[2]==="prompt"),queues:()=>calls.filter(argv=>argv[1]==="queue"&&argv[2]!=="--help")};
}

test("working Slack intake is durable before tick and steers the same active turn once across restart",async()=>{
 const h=await externalFixture(true);h.busy();
 const event={id:"slack:C:123.456",user:"owner",thread:"slack:C/100.000",text:"continue while working"},id=`inbound:test:${event.thread}:${event.id}`;
 await s.receive("test",event);expect(s.inbox.get(id)).toMatchObject({state:"queued",attachmentInstance:h.attachment().instance});
 expect(h.prompts()).toHaveLength(0);await s.tick();
 expect(s.inbox.get(id)).toMatchObject({state:"sent",turnId:"running-turn"});expect(h.turns[0].status).toBe("inProgress");
 expect(await s.deps.runtime.inspect("lead")).toMatchObject({state:"running",activeTurnId:"running-turn"});
 expect(h.prompts()).toHaveLength(1);expect(h.queues()).toHaveLength(0);
 expect(h.prompts()[0]?.[4]).toBe(operationText("Owner message in slack:C/100.000:\nSource message ID: slack:C:123.456\ncontinue while working",id));
 expect(s.inbox.get(id)?.thread).toBe(event.thread);expect(s.outbox.list()).toEqual([]);expect(h.calls.filter(argv=>argv[0]==="notify")).toEqual([]);
 s=new DoriService(h.config,h.runner,h.transport);await s.receive("test",event);await s.tick();
 expect(s.inbox.get(id)).toMatchObject({state:"sent",turnId:"running-turn"});expect(h.prompts()).toHaveLength(1);
});

test("concurrent working input retries produce one TUI submission and one exact receipt",async()=>{
 const h=await externalFixture();h.busy();const args={key:"lead",text:"one submission",operationId:"concurrent-working"},caller={role:"admin" as const};
 expect(await Promise.all([s.handle("input",args,caller),s.handle("input",args,caller)])).toEqual([{turnId:"running-turn"},{turnId:"running-turn"}]);
 expect(h.prompts()).toHaveLength(1);expect(h.queues()).toHaveLength(0);expect(h.turns[0].items).toHaveLength(1);expect(h.turns[0].status).toBe("inProgress");
});

for(const secondThread of ["slack:owner","slack:other"])test(`shared-turn Herdr status changes post no prose with reply destinations ${secondThread}`,async()=>{
 const h=await externalFixture(true);h.busy();const instance=h.attachment().instance;
 for(const [operationId,thread] of [["first-progress","slack:owner"],["second-progress",secondThread]] as const){
  expect(await s.handle("input",{key:"lead",text:operationId,operationId,thread},{role:"admin"})).toEqual({turnId:"running-turn"});
  expect(s.inbox.get(operationId)).toMatchObject({target:"lead",state:"sent",attachmentInstance:instance,turnId:"running-turn",thread});
 }
 expect(await s.deps.runtime.inspect("lead")).toMatchObject({state:"running",activeTurnId:"running-turn"});
 expect(h.turns[0].items).toHaveLength(2);expect(h.turns[0].status).toBe("inProgress");
 for(const status of ["working","blocked","idle","done"]){
  h.status(status);s=new DoriService(h.config,h.runner,h.transport);await s.tick();
  expect(h.calls.filter(argv=>argv[0]==="notify")).toEqual([]);expect(s.outbox.list()).toEqual([]);
 }
});

test("worker Herdr status changes post no prose while the lead is attached",async()=>{
 const world=newWorld(),config={...s.config,hooks:{threadReply:["notify","{thread}","{text}"]}};
 const agent={pane_id:"worker:pane",workspace_id:"w",agent:"codex",agent_status:"working",agent_session:{agent:"codex",kind:"id",value:"t1"}};
 world.panes=[agent];
 await s.registry.write({...lane,pane:agent.pane_id});
 await s.registry.write({...lane,key:"lead",role:"lead",thread:"none",runtime:{...lane.runtime!,backend:"external-current-session"}});
 for(const status of ["working","blocked","idle","done"]){
  agent.agent_status=status;s=new DoriService(config,fakeRunner(world));
  s.deps.runtime.inspect=async()=>({threadId:"t1",state:"idle",goal:null});
  await s.tick();expect(world.calls.filter(argv=>argv[0]==="notify")).toEqual([]);expect(s.outbox.list()).toEqual([]);
 }
});

test("ingress with no lead stays durable and silent; explicit replies still send once",async()=>{
 const world=newWorld(),config={...s.config,hooks:{threadReply:["notify","{thread}","{text}"]}};
 s=new DoriService(config,fakeRunner(world));
 const event={id:"slack:C:123.456",thread:"slack:C/100.000",user:"owner",text:"saved request"},id=`inbound:test:${event.thread}:${event.id}`;
 await s.receive("test",event);s=new DoriService(config,fakeRunner(world));await s.receive("test",event);
 expect(s.inbox.list()).toHaveLength(1);expect(s.inbox.get(id)).toMatchObject({target:"lead",state:"queued",thread:event.thread});
 expect(s.outbox.list()).toEqual([]);expect(world.calls.filter(argv=>argv[0]==="notify")).toEqual([]);
 const reply={thread:event.thread,text:"I received your request.",operationId:"skill-reply"};
 expect(await s.handle("reply",reply,{role:"admin"})).toEqual({sent:true});
 s=new DoriService(config,fakeRunner(world));await s.handle("reply",reply,{role:"admin"});
 expect(world.calls.filter(argv=>argv[0]==="notify")).toEqual([["notify",event.thread,reply.text]]);
 expect(s.outbox.list()).toEqual([expect.objectContaining({id:"skill-reply",target:event.thread,text:reply.text,state:"sent"})]);
 expect(s.inbox.get(id)?.state).toBe("queued");
});

for(const delivery of ["queued","sent","unknown"] as const)test(`retries of pre-metadata ingress preserve ${delivery} operation content and delivery state`,async()=>{
 const world=newWorld(),config={...s.config,hooks:{threadReply:["notify","{thread}","{text}"]}};
 const event={id:"slack:C:123.456",thread:"slack:C/100.000",user:"owner",text:"original request"},id=`inbound:test:${event.thread}:${event.id}`;
 const original={id,target:"lead",thread:event.thread,text:`Owner message in ${event.thread}:\n${event.text}`,source:"test",state:delivery,at:"2026-10-01",attachmentInstance:"old-instance"};
 s.inbox.put(original);s=new DoriService(config,fakeRunner(world));await s.receive("test",event);
 expect(s.inbox.get(id)).toEqual(original);expect(s.outbox.list()).toEqual([]);expect(world.calls).toEqual([]);
 await expect(s.receive("test",{...event,text:"changed request"})).rejects.toThrow("different content");
});

for(const condition of ["held","detached","offline"] as const)test(`ingress remains durable and silent when the attached lead is ${condition}`,async()=>{
 const h=await externalFixture(true);h.busy();
 if(condition==="held")await s.registry.update("lead",current=>({...current,dispatchBlocked:true,holdReason:"owner-pause",runtime:{...current.runtime!,held:true}}));
 if(condition==="detached")await s.handle("lead-detach",{threadId:h.args.threadId},{role:"admin"});
 if(condition==="offline")h.offline();
 const event={id:`slack:C:${condition}`,thread:"slack:C/100.000",user:"owner",text:"save for later"},id=`inbound:test:${event.thread}:${event.id}`;
 await s.receive("test",event);await s.tick();
 expect(s.inbox.get(id)).toMatchObject({state:"queued",thread:event.thread,attachmentInstance:h.attachment().instance});
 expect(s.outbox.list()).toEqual([]);expect(h.calls.filter(argv=>argv[0]==="notify")).toEqual([]);
 expect(h.prompts()).toEqual([]);expect(h.queues()).toEqual([]);
});

for(const holdReason of ["owner-pause","done-review"] as const)test(`working intake preserves ${holdReason}`,async()=>{
 const h=await externalFixture();h.busy();await s.registry.update("lead",lane=>({...lane,dispatchBlocked:true,holdReason,runtime:{...lane.runtime!,held:true}}));
 expect(await s.handle("input",{key:"lead",text:"saved",operationId:"held-working"},{role:"admin"})).toMatchObject({queued:true});
 await s.tick();expect(s.inbox.get("held-working")?.state).toBe("queued");expect(h.prompts()).toHaveLength(0);expect(h.queues()).toHaveLength(0);
 expect(await s.registry.read("lead")).toMatchObject({dispatchBlocked:true,holdReason});
});

for(const flag of ["waitingOnApproval","waitingOnUserInput"])test(`working intake remains queued during ${flag}`,async()=>{
 const h=await externalFixture();h.busy();h.waiting(flag);
 expect(await s.handle("input",{key:"lead",text:"saved",operationId:"waiting-working"},{role:"admin"})).toMatchObject({queued:true});
 await s.tick();expect(s.inbox.get("waiting-working")?.state).toBe("queued");expect(h.prompts()).toHaveLength(0);expect(h.queues()).toHaveLength(0);
});

test("working dispatch preserves excluded, old-generation and uncertain mail boundaries",async()=>{
 const h=await externalFixture();h.busy();const saved=h.attachment();saved.excludedInboxIds.push("history");atomicJson(join(state.dir,"attachments/lead.json"),saved);
 for(const id of ["history","old","unknown","sending","current"])s.inbox.put({id,target:"lead",text:id,state:id==="unknown"||id==="sending"?id:"queued",attachmentInstance:id==="old"?"old-instance":saved.instance,at:"2020-01-01"});
 await s.tick();expect(s.inbox.get("current")).toMatchObject({state:"sent",turnId:"running-turn"});
 for(const id of ["history","old"])expect(s.inbox.get(id)?.state).toBe("queued");
 expect(s.inbox.get("unknown")?.state).toBe("unknown");expect(s.inbox.get("sending")?.state).toBe("sending");expect(h.prompts()).toHaveLength(1);expect(h.queues()).toHaveLength(0);
});

test("unconfirmed working submission becomes unknown and restart cannot replay either transport",async()=>{
 const h=await externalFixture();h.busy();h.noReceipt();
 await expect(s.handle("input",{key:"lead",text:"uncertain",operationId:"working-unknown"},{role:"admin"})).rejects.toThrow("receipt unknown");
 expect(s.inbox.get("working-unknown")?.state).toBe("unknown");
 s=new DoriService(h.config,h.runner,h.transport);await s.tick();
 await expect(s.handle("input",{key:"lead",text:"uncertain",operationId:"working-unknown"},{role:"admin"})).rejects.toThrow("Delivery unknown");
 expect(h.prompts()).toHaveLength(1);expect(h.queues()).toHaveLength(0);
});

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
