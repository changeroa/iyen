import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { ipc, readJson, serviceSocket } from "../src/ipc.ts";
import { startCodex } from "../src/runtime/codex.ts";
import { withState } from "./fakes.ts";
const waitFor = async<T>(fn:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T>=>{
 const end=Date.now()+15000;
 let last:unknown;
 do{try{const v=await fn();if(accept(v))return v;}catch(e){last=e;}await Bun.sleep(50);}while(Date.now()<end);
 throw new Error(`Timed out: ${String(last)}`);
};
test("CLI service and private backends manage visible Herdr agents with exact receipts, pause, close and same-thread reopen",async()=>{
 const state=withState();let daemon:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const bin=join(state.dir,"bin");mkdirSync(bin);symlinkSync(join(import.meta.dir,"fixtures/herdr.ts"),join(bin,"herdr"));
  const config={...defaultConfig(),stateDir:state.dir,defaultCwd:state.dir,leadWorkspace:"lead-space",laneWorkspace:"worker-space",closeAfterMin:0.01,guard:{...defaultConfig().guard,memFreeMinPct:0,diskFreeMinGb:0},runtime:{...defaultConfig().runtime,binary:join(import.meta.dir,"fixtures/codex.ts"),roles:{lead:{model:"test",effort:"medium"},lane:{model:"test",effort:"medium"}},startupTimeoutMs:10000,rpcTimeoutMs:3000,heartbeatIntervalMs:250,heartbeatTimeoutMs:5000}};
  const cfgPath=join(state.dir,"config.json");atomicJson(cfgPath,config);await Bun.write(join(state.dir,"brief.md"),"fixture task");await Bun.write(join(state.dir,"ready.json"),'{"ready":true}');
  const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,HOME:state.dir,DORI_CONFIG:cfgPath,DORI_STATE_DIR:state.dir};
  daemon=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"serve"],{env,stdout:"pipe",stderr:"pipe"});
  const logs=new Response(daemon.stdout as ReadableStream).text();const errs=new Response(daemon.stderr as ReadableStream).text();
  await waitFor(async()=>existsSync(join(state.dir,"control.json")),Boolean);
  const token=readJson<{token:string}>(join(state.dir,"control.json")).token;
  const call=(action:string,args:any={})=>ipc<any>(serviceSocket(state.dir),token,action,args,20000);
  await waitFor(()=>call("status"),Array.isArray);
  const lead=await call("lead");
  if(!lead.startup.startsWith("STARTUP_OK")) {
    const debug=(path:string)=>existsSync(join(state.dir,path))?readJson(join(state.dir,path)):null;
    throw new Error(JSON.stringify({startup:lead.startup,backendError:debug("fixture-backend-error.json"),phase:debug("hosts/lead.startup.json"),hostError:debug("hosts/lead.error.json")}));
  }
  expect(lead.startup).toStartWith("STARTUP_OK");
  const leadWrapper = join(state.dir,"clients/lead/dori");
  const leadMcp = async (action: string, args: any) => {
    const child = Bun.spawn([leadWrapper,"mcp-server"],{env:{PATH:env.PATH,HOME:state.dir},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"control",arguments:{action,args}}})+"\n");child.stdin.end();
    const response=JSON.parse((await new Response(child.stdout).text()).trim());
    expect(await child.exited).toBe(0);expect(response.result.isError).toBe(false);
    return JSON.parse(response.result.content[0].text);
  };
  const workArgs={title:"Direct docs lookup",tags:["docs"],thread:"chat:docs",operationId:crypto.randomUUID()};
  const timed=await leadMcp("work-start",workArgs);
  expect(timed.work.id).toBe(workArgs.operationId);expect(timed.work.startedAt).toBeTruthy();
  expect(await leadMcp("work-start",workArgs)).toEqual(timed);
  const finished=await leadMcp("work-stop",{id:timed.work.id});
  expect(finished.work.endedAt).toBeTruthy();expect(finished.work.elapsedSec).toBeGreaterThanOrEqual(0);
  const history=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"work","similar","--tag","docs"],{env,stdout:"pipe",stderr:"pipe"});
  expect(JSON.parse(await new Response(history.stdout).text()).matches[0].id).toBe(timed.work.id);expect(await history.exited).toBe(0);
  const missing=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"work","stop","00000000-0000-0000-0000-000000000000"],{env,stdout:"pipe",stderr:"pipe"});
  expect((await new Response(missing.stderr).text()).trim()).toBe('no started work "00000000-0000-0000-0000-000000000000"');expect(await missing.exited).toBe(1);
  await call("input",{key:"lead",text:"fixture-fail-auth",thread:"chat:failure",operationId:"failure-input"});
  const failedMail=await waitFor(()=>call("mail-list"),v=>v.outbox.some((m:any)=>m.target==="chat:failure"));
  expect(failedMail.outbox.filter((m:any)=>m.target==="chat:failure")).toHaveLength(1);
  expect(failedMail.outbox.find((m:any)=>m.target==="chat:failure").text).toContain("authentication");
  expect((await call("status",{key:"lead"})).runtime.hostInstanceId).toBe(lead.lane.runtime.hostInstanceId);
  const launched=await call("launch",{key:"test-lane",title:"Test",brief:join(state.dir,"brief.md"),done:`file ${join(state.dir,"ready.json")} json:.ready=true`,cwd:state.dir,operationId:"launch-1"});
  expect(launched.startup).toStartWith("STARTUP_OK");const threadId=launched.lane.runtime.threadId;
  const createdPanes=JSON.parse(readFileSync(join(state.dir,"fixture-panes.json"),"utf8"));
  expect(createdPanes.find((p:any)=>p.pane_id===lead.lane.pane).workspace_id).toBe("lead-space");
  expect(createdPanes.find((p:any)=>p.pane_id===launched.lane.pane).workspace_id).toBe("worker-space");
  expect(threadId).toBeTruthy();expect(threadId).not.toBe("distinct-session");
  const paneBefore=(await call("status",{key:"test-lane"})).pane;
  const tabCount=JSON.parse(readFileSync(join(state.dir,"fixture-panes.json"),"utf8")).length;
  await expect(call("recover",{key:"test-lane"})).rejects.toThrow("alive");
  expect((await call("status",{key:"test-lane"})).pane).toBe(paneBefore);
  expect(JSON.parse(readFileSync(join(state.dir,"fixture-panes.json"),"utf8")).length).toBe(tabCount);
  const wrapper = join(state.dir,"clients/test-lane/dori");
  const scoped = Bun.spawn([wrapper,"status"],{env:{PATH:env.PATH,HOME:state.dir},stdout:"pipe",stderr:"pipe"});
  const scopedOutput = await new Response(scoped.stdout).text();expect(await scoped.exited).toBe(0);expect(JSON.parse(scopedOutput).key).toBe("test-lane");
  const forbidden = Bun.spawn([wrapper,"pause","lead"],{env:{PATH:env.PATH,HOME:state.dir},stdout:"ignore",stderr:"pipe"});
  await new Response(forbidden.stderr).text();expect(await forbidden.exited).not.toBe(0);
  const mcp = Bun.spawn([wrapper,"mcp-server"],{env:{PATH:env.PATH,HOME:state.dir},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  mcp.stdin.write([
    {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26"}},
    {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"control",arguments:{action:"status",args:{}}}},
    {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"control",arguments:{action:"pause",args:{key:"lead"}}}},
    {jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"control",arguments:{action:"work-similar",args:{tags:["docs"]}}}},
    {jsonrpc:"2.0",id:5,method:"tools/list"},
  ].map(x=>JSON.stringify(x)).join("\n")+"\n");mcp.stdin.end();
  const replies=(await new Response(mcp.stdout).text()).trim().split("\n").map(x=>JSON.parse(x));
  expect(await mcp.exited).toBe(0);expect(replies.find(x=>x.id===2)?.result.isError).toBe(false);expect(replies.find(x=>x.id===3)?.result.isError).toBe(true);
  expect(replies.find(x=>x.id===4)?.result.isError).toBe(true);
  expect(replies.find(x=>x.id===5)?.result.tools[0].inputSchema.properties.action.enum).toContain("work-start");
  if(process.env.DORI_LIVE_PROTOCOL==="1") {
    mkdirSync(join(state.dir,"real-codex"));
    const actual=await startCodex(defaultConfig().runtime,{PATH:process.env.PATH,HOME:state.dir,CODEX_HOME:join(state.dir,"real-codex"),DORI_STATE_DIR:state.dir,DORI_CONTEXT:join(state.dir,"clients/test-lane/context.json"),DORI_CONFIG:join(state.dir,"clients/test-lane/config.json")});
    try {
      await actual.session.open(state.dir,{model:null,effort:null},"Protocol verification only; no task.");
      const status:any=await actual.session.rpc.request("mcpServerStatus/list",{threadId:actual.session.threadId,serverName:"dori_runtime"});
      const dori=status.data.find((x:any)=>x.name==="dori_runtime");
      expect(dori).toBeTruthy();expect(Object.keys(dori.tools)).toContain("control");
    }finally{actual.close();await actual.exited;}
  }
  expect((await call("pause",{key:"test-lane"})).code).toBe(0);
  expect(await call("input",{key:"test-lane",text:"queued",operationId:"input-1"})).toMatchObject({queued:true});
  expect((await call("resume",{key:"test-lane"})).code).toBe(0);
  await waitFor(()=>call("mail-list"),v=>v.inbox.find((m:any)=>m.id==="input-1")?.state==="sent");
  await call("claim-done",{key:"test-lane",evidence:"ready file"});
  expect((await call("close",{key:"test-lane"})).closed).toBe(true);
  await waitFor(()=>call("status",{key:"test-lane"}),v=>v.status==="closed");
  await Bun.sleep(100);
  await call("reopen",{key:"test-lane",text:"follow up",operationId:"input-2"});
  const reopened=await waitFor(()=>call("status",{key:"test-lane"}),v=>v.runtime.state!=="starting");
  await waitFor(()=>call("mail-list"),v=>v.inbox.find((m:any)=>m.id==="input-2")?.state==="sent");
  expect(reopened.runtime.threadId).toBe(threadId);expect(reopened.cycle).toBe(2);expect(reopened.claim).toBeUndefined();
  expect(JSON.parse(readFileSync(join(state.dir,"fixture-panes.json"),"utf8")).find((p:any)=>p.pane_id===reopened.pane).workspace_id).toBe("worker-space");
  expect(existsSync(join(state.dir,".omo"))).toBe(false);
  const herdrCalls=readFileSync(join(state.dir,"fixture-herdr-calls.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
  for(const command of ["start","prompt","get","read","send-keys"])expect(herdrCalls.some(a=>a[0]==="agent"&&a[1]===command)).toBe(true);
  expect(herdrCalls.filter(a=>a[0]==="pane"&&a[1]==="run").every(a=>a[3].startsWith("export CODEX_HOME="))).toBe(true);
  expect((await call("mail-list")).inbox.filter((m:any)=>m.id.startsWith("runtime-failed:"))).toHaveLength(0);
  daemon.kill("SIGTERM");await daemon.exited;
  expect(await errs).toBe("");expect(await logs).toContain("DORI_SERVICE_READY");
 }finally{
  daemon?.kill();
  for(const path of new Bun.Glob("hosts/*.pid.json").scanSync(state.dir)){try{process.kill(readJson<{pid:number}>(join(state.dir,path)).pid,"SIGTERM");}catch{}}
  if(existsSync(join(state.dir,"fixture-pids")))for(const raw of readFileSync(join(state.dir,"fixture-pids"),"utf8").trim().split("\n")){try{process.kill(Number(raw),"SIGTERM");}catch{}}
  await Bun.sleep(100);state.done();
 }
},30000);
