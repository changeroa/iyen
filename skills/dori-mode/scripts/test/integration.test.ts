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
test("CLI daemon and isolated session-hosts launch, pause, resume, close and reopen the same Codex thread",async()=>{
 const state=withState();let daemon:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const bin=join(state.dir,"bin");mkdirSync(bin);symlinkSync(join(import.meta.dir,"fixtures/herdr.ts"),join(bin,"herdr"));
  const config={...defaultConfig(),stateDir:state.dir,defaultCwd:state.dir,closeAfterMin:0.01,guard:{...defaultConfig().guard,memFreeMinPct:0,diskFreeMinGb:0},runtime:{...defaultConfig().runtime,binary:join(import.meta.dir,"fixtures/codex.ts"),startupTimeoutMs:10000,rpcTimeoutMs:3000}};
  const cfgPath=join(state.dir,"config.json");atomicJson(cfgPath,config);await Bun.write(join(state.dir,"brief.md"),"fixture task");await Bun.write(join(state.dir,"ready.json"),'{"ready":true}');
  const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,HOME:state.dir,DORI_CONFIG:cfgPath,DORI_STATE_DIR:state.dir};
  daemon=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"serve"],{env,stdout:"pipe",stderr:"pipe"});
  const logs=new Response(daemon.stdout as ReadableStream).text();const errs=new Response(daemon.stderr as ReadableStream).text();
  await waitFor(async()=>existsSync(join(state.dir,"control.json")),Boolean);
  const token=readJson<{token:string}>(join(state.dir,"control.json")).token;
  const call=(action:string,args:any={})=>ipc<any>(serviceSocket(state.dir),token,action,args,20000);
  await waitFor(()=>call("status"),Array.isArray);
  const lead=await call("lead");expect(lead.startup).toStartWith("STARTUP_OK");
  const launched=await call("launch",{key:"test-lane",title:"Test",brief:join(state.dir,"brief.md"),done:`file ${join(state.dir,"ready.json")} json:.ready=true`,cwd:state.dir,operationId:"launch-1"});
  expect(launched.startup).toStartWith("STARTUP_OK");const threadId=launched.lane.runtime.threadId;
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
  ].map(x=>JSON.stringify(x)).join("\n")+"\n");mcp.stdin.end();
  const replies=(await new Response(mcp.stdout).text()).trim().split("\n").map(x=>JSON.parse(x));
  expect(await mcp.exited).toBe(0);expect(replies.find(x=>x.id===2)?.result.isError).toBe(false);expect(replies.find(x=>x.id===3)?.result.isError).toBe(true);
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
  expect(existsSync(join(state.dir,".omo"))).toBe(false);
  daemon.kill("SIGTERM");await daemon.exited;
  expect(await errs).toBe("");expect(await logs).toContain("DORI_SERVICE_READY");
 }finally{
  daemon?.kill();
  if(existsSync(join(state.dir,"fixture-pids")))for(const raw of readFileSync(join(state.dir,"fixture-pids"),"utf8").trim().split("\n")){try{process.kill(-Number(raw),"SIGTERM");}catch{}}
  await Bun.sleep(100);state.done();
 }
},30000);
