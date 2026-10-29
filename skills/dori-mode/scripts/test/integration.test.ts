import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { ipc, readJson, serviceSocket, socketDir } from "../src/ipc.ts";
import { connectObserver } from "../src/runtime/observer.ts";
import { operationText } from "../src/runtime/herdr.ts";
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
  const launched=await call("launch",{key:"test-lane",title:"Test",brief:join(state.dir,"brief.md"),done:`file ${join(state.dir,"ready.json")} json:.ready=true`,cwd:state.dir,operationId:"launch-1"});
  expect(launched.startup).toStartWith("STARTUP_OK");const threadId=launched.lane.runtime.threadId;
  const createdPanes=JSON.parse(readFileSync(join(state.dir,"fixture-panes.json"),"utf8"));
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

test("current-session CLI attaches a busy existing lead, scopes controls, delivers ingress, restarts and detaches without terminating its daemon", async () => {
 const state=withState();let daemon:ReturnType<typeof Bun.spawn>|undefined;
 const threadId="11111111-1111-4111-8111-111111111111",socketPath=join(socketDir(state.dir),"shared.sock"),statePath=join(state.dir,"external-state.json");
 const server=Bun.serve({unix:socketPath,fetch(req,s){if(s.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,raw){
  const m=JSON.parse(String(raw));if(m.id===undefined)return;const snapshot=readJson<any>(statePath);
  const result=m.method==="initialize"?{}:m.method==="thread/read"?{thread:snapshot.thread}:m.method==="thread/loaded/list"?{data:[threadId],nextCursor:null}:m.method==="thread/goal/get"?{goal:null}:m.method==="thread/turns/list"?{data:snapshot.turns,nextCursor:null}:undefined;
  if(result===undefined)ws.send(JSON.stringify({id:m.id,error:{code:-1,message:"observer mutation prohibited"}}));else ws.send(JSON.stringify({id:m.id,result}));
 }}});
 try {
  atomicJson(statePath,{socketPath,thread:{id:threadId,cwd:state.dir,model:"existing-model",reasoningEffort:"high",status:{type:"active",activeFlags:[]}},turns:[{id:"activation-turn",status:"inProgress",items:[]}]});
  atomicJson(join(state.dir,"fixture-panes.json"),[{pane_id:"current:p",tab_id:"current:t",workspace_id:"current",agent:"codex",agent_status:"working",agent_session:{agent:"codex",kind:"id",value:threadId}}]);
  const bin=join(state.dir,"bin");mkdirSync(bin);symlinkSync(join(import.meta.dir,"fixtures/herdr.ts"),join(bin,"herdr"));
  const config={...defaultConfig(),stateDir:state.dir,defaultCwd:state.dir,runtime:{...defaultConfig().runtime,binary:join(import.meta.dir,"fixtures/external-codex.ts"),rpcTimeoutMs:2000}};
  const cfgPath=join(state.dir,"config.json");atomicJson(cfgPath,config);
  const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,HOME:state.dir,DORI_STATE_DIR:state.dir,DORI_CONFIG:cfgPath};
  const cli=join(import.meta.dir,"../src/cli.ts");
  const start=async()=>{
   daemon=Bun.spawn([process.execPath,cli,"serve"],{env,stdout:"pipe",stderr:"pipe"});
   const out=new Response(daemon.stdout as ReadableStream).text(),err=new Response(daemon.stderr as ReadableStream).text();
   await waitFor(async()=>existsSync(join(state.dir,"control.json")),Boolean);
   await waitFor(()=>ipc(serviceSocket(state.dir),readJson<any>(join(state.dir,"control.json")).token,"status"),Array.isArray);
   return {out,err};
  };
  const exec=async(argv:string[],extraEnv:Record<string,string>={})=>{
   const p=Bun.spawn(argv,{env:{...env,...extraEnv},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   return {out,err,code};
  };
  let logs=await start();
  const attached=await exec([process.execPath,cli,"lead-attach","--thread-id",threadId,"--pane","current:p","--cwd",state.dir]);expect(attached.code).toBe(0);
  const first=JSON.parse(attached.out),bridge=first.bridge;expect(first.lead).toMatchObject({identityVerified:true,readiness:"busy",runtime:{model:"existing-model",effort:"high",threadId}});
  const scoped=await exec([bridge,"status","lead"]);expect(scoped.code).toBe(0);expect(JSON.parse(scoped.out).bridge).toBe(bridge);
  const repeat=await exec([process.execPath,cli,"lead","--thread-id",threadId,"--pane","current:p","--cwd",state.dir]);expect(repeat.code).toBe(0);expect(JSON.parse(repeat.out)).toMatchObject({reused:true,bridge});
  const saved=readJson<any>(join(state.dir,"attachments/lead.json")),token=readJson<any>(join(state.dir,"control.json")).token;
  const call=(action:string,args:any={})=>ipc<any>(serviceSocket(state.dir),token,action,args,15000);
  const workId=crypto.randomUUID(),work=await exec([bridge,"work","start","--title","Attached direct work","--tag","docs","--operation-id",workId]);expect(work.code).toBe(0);expect(JSON.parse(work.out).work.id).toBe(workId);
  const stopped=await exec([bridge,"work","stop",workId]);expect(stopped.code).toBe(0);expect(JSON.parse(stopped.out).work.elapsedSec).toBeGreaterThanOrEqual(0);
  const forged=join(state.dir,"forged.json");atomicJson(forged,{key:"lead",stateDir:state.dir});
  expect((await exec([process.execPath,cli,"status"],{DORI_CONTEXT:forged})).code).toBe(1);
  expect((await exec([bridge,"lead-attach","--thread-id",threadId,"--pane","current:p","--cwd",state.dir])).code).toBe(1);
  await call("input",{key:"lead",text:"literal owner message",thread:"chat:owner",operationId:"ingress"});
  const mail=await waitFor(()=>call("mail-list"),v=>v.inbox.find((m:any)=>m.id==="ingress")?.state==="sent");
  const delivered=mail.inbox.find((m:any)=>m.id==="ingress");expect(delivered.turnId).toBe("activation-turn");
  expect(readJson<any>(statePath).turns.find((t:any)=>t.id===delivered.turnId).items[0].content[0].text).toBe(operationText("literal owner message","ingress"));
  expect(readJson<any>(statePath).turns).toHaveLength(1);expect(readJson<any>(statePath).turns[0].status).toBe("inProgress");
  expect(readJson<any[]>(join(state.dir,"fixture-panes.json"))[0].agent_status).toBe("working");
  expect(await call("input",{key:"lead",text:"literal owner message",thread:"chat:owner",operationId:"ingress"})).toEqual({turnId:"activation-turn"});
  daemon!.kill("SIGTERM");await daemon!.exited;expect(await logs.err).toBe("");expect(await logs.out).toContain("DORI_SERVICE_READY");
  logs=await start();expect(JSON.parse((await exec([bridge,"status","lead"])).out)).toMatchObject({identityVerified:true,readiness:"busy",bridge});
  const snapshot=readJson<any>(statePath);snapshot.thread.status={type:"idle"};snapshot.turns[0].status="completed";atomicJson(statePath,snapshot);
  const idlePanes=readJson<any[]>(join(state.dir,"fixture-panes.json"));idlePanes[0].agent_status="idle";atomicJson(join(state.dir,"fixture-panes.json"),idlePanes);
  await call("input",{key:"lead",text:"fixture-fail-auth",thread:"chat:failure",operationId:"failed-owner-input"});
  const failedMail=await waitFor(()=>call("mail-list"),v=>v.outbox.some((m:any)=>m.target==="chat:failure"));
  expect(failedMail.outbox.filter((m:any)=>m.target==="chat:failure")).toHaveLength(1);expect(failedMail.outbox.find((m:any)=>m.target==="chat:failure").text).toContain("Check Codex authentication");
  expect(failedMail.failures.filter((m:any)=>m.turnId===failedMail.inbox.find((m:any)=>m.id==="failed-owner-input").turnId)).toHaveLength(1);
  expect(JSON.stringify(failedMail.failures)).not.toContain("fixture-secret");
  const stop=await exec([bridge,"lead-detach","--thread-id",threadId]);expect(stop.code).toBe(0);expect(JSON.parse(stop.out)).toMatchObject({detached:true});
  expect((await exec([bridge,"status"])).code).toBe(1);await expect(ipc(serviceSocket(state.dir),saved.token,"status")).rejects.toThrow("Forbidden");
  const deniedMarker=join(state.dir,"denied-local-command");
  for(const args of [["heavy","denied","--",process.execPath,"-e",`await Bun.write(${JSON.stringify(deniedMarker)},"executed")`],
    ["session-host","--state-dir",state.dir,"--key","denied-worker"],["session-host-start","--state-dir",state.dir,"--key","denied-worker"],["migrate","--apply"],["serve"],["transcribe","fixture.wav"],["send","slack","--to","fixture","--text","no send"]]){
   const denied=await exec([bridge,...args]);expect(denied.code).toBe(1);expect(denied.err).toContain(`Scoped context cannot invoke local command ${args[0]}`);
  }
  expect(existsSync(deniedMarker)).toBe(false);expect(existsSync(join(state.dir,"hosts/denied-worker.error.json"))).toBe(false);expect(existsSync(join(state.dir,"heavy"))).toBe(false);
  const scopedHelp=await exec([bridge,"help"]);expect(scopedHelp.code).toBe(0);expect(scopedHelp.out).toContain("lead-detach");expect(scopedHelp.out).not.toContain("migrate");
  const second=JSON.parse((await exec([process.execPath,cli,"lead-attach","--thread-id",threadId,"--pane","current:p","--cwd",state.dir])).out);expect(second.bridge).not.toBe(bridge);expect((await exec([bridge,"status"])).code).toBe(1);
  await call("lead-detach",{threadId});
  const observer=await connectObserver(socketPath,500);try{expect((await observer.read<any>("thread/read",{threadId})).thread.id).toBe(threadId);}finally{observer.close();}
  const calls=readFileSync(join(state.dir,"external-codex-calls.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  expect(calls.filter(a=>a[0]==="queue"&&a[1]!=="--help")).toHaveLength(1);expect(calls.every(a=>a.join(" ")==="app-server daemon version"||a[0]==="queue")).toBe(true);
  const herdrCalls=readFileSync(join(state.dir,"fixture-herdr-calls.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));expect(herdrCalls.every(a=>a[0]==="agent"&&["get","prompt"].includes(a[1]))).toBe(true);expect(herdrCalls.filter(a=>a[1]==="prompt")).toEqual([["agent","prompt","current:p",operationText("literal owner message","ingress")]]);
  daemon!.kill("SIGTERM");await daemon!.exited;expect(await logs.err).toBe("");
 }finally{daemon?.kill();if(daemon)await daemon.exited;server.stop(true);state.done();}
},30000);


for (const upgradeVersion of ["0.165.0", "0.999.0"]) test(`CLI 163 attachment automatically survives compatible ${upgradeVersion} upgrade and interrupted binding restart`, async () => {
 const state = withState(); let daemon: ReturnType<typeof Bun.spawn> | undefined;
 const threadId = "11111111-1111-4111-8111-111111111111", socketPath = join(socketDir(state.dir), "shared.sock"), statePath = join(state.dir, "external-state.json");
 const server = Bun.serve({ unix: socketPath, fetch(req, s) { if (s.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
  const m = JSON.parse(String(raw)); if (m.id === undefined) return; const snapshot = readJson<any>(statePath);
  const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread: snapshot.thread } : m.method === "thread/loaded/list" ? { data: [threadId], nextCursor: null } : m.method === "thread/goal/get" ? { goal: null } : m.method === "thread/turns/list" ? { data: snapshot.turns, nextCursor: null } : undefined;
  ws.send(JSON.stringify(result === undefined ? { id: m.id, error: { code: -1, message: "mutation refused" } } : { id: m.id, result }));
 } } });
 try {
  atomicJson(statePath, { socketPath, serverVersion: "0.163.0", thread: { id: threadId, cwd: state.dir, status: { type: "active", activeFlags: ["waitingOnApproval"] } }, turns: [{ id: "busy", status: "inProgress", items: [] }] });
  atomicJson(join(state.dir, "fixture-panes.json"), [{ pane_id: "current:p", tab_id: "current:t", workspace_id: "current", agent: "codex", agent_status: "working", agent_session: { agent: "codex", kind: "id", value: threadId } }]);
  const bin = join(state.dir, "bin"); mkdirSync(bin); symlinkSync(join(import.meta.dir, "fixtures/herdr.ts"), join(bin, "herdr"));
  const binaries: string[] = [];
  for (const version of ["0.163.0", upgradeVersion]) {
   const binary = join(bin, `codex-${version}`);
   await Bun.write(binary, `#!/usr/bin/env bun\nprocess.env.DORI_EXTERNAL_FIXTURE_VERSION = ${JSON.stringify(version)};\nawait import(${JSON.stringify(join(import.meta.dir, "fixtures/external-codex.ts"))});\n`); chmodSync(binary, 0o700); binaries.push(realpathSync(binary));
  }
  const externalLink = join(bin, "external-codex"); symlinkSync(binaries[0]!, externalLink);
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, runtime: { ...defaultConfig().runtime, binary: binaries[0]!, externalBinary: externalLink, rpcTimeoutMs: 2000 } };
  const cfgPath = join(state.dir, "config.json"); atomicJson(cfgPath, config);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: state.dir, DORI_STATE_DIR: state.dir, DORI_CONFIG: cfgPath };
  const cli = join(import.meta.dir, "../src/cli.ts"), attachmentPath = join(state.dir, "attachments/lead.json");
  const call = (action: string, args: any = {}, token = readJson<any>(join(state.dir, "control.json")).token) => ipc<any>(serviceSocket(state.dir), token, action, args, 15000);
  const start = async () => {
   daemon = Bun.spawn([process.execPath, cli, "serve"], { env, stdout: "pipe", stderr: "pipe" });
   const logs = { out: new Response(daemon.stdout as ReadableStream).text(), err: new Response(daemon.stderr as ReadableStream).text() };
   await waitFor(async () => existsSync(join(state.dir, "control.json")), Boolean);
   await waitFor(() => call("status"), Array.isArray); return logs;
  };
  const stop = async (logs: { out: Promise<string>; err: Promise<string> }) => { daemon!.kill("SIGTERM"); await daemon!.exited; expect(await logs.err).toBe(""); };
  const attach = () => call("lead-attach", { threadId, pane: "current:p", cwd: state.dir });
  let logs = await start(); await attach(); const saved = readJson<any>(attachmentPath);
  await call("input", { key: "lead", text: "accepted before upgrade", thread: "chat:owner", operationId: "upgrade-mail" });
  const snapshot = readJson<any>(statePath); snapshot.serverVersion = upgradeVersion; atomicJson(statePath, snapshot);
  expect(await call("status", { key: "lead" })).toMatchObject({ readiness: "held", runtime: { external: { holdReason: { code: "runtime-version-changed" } } } });
  // The stable external command now resolves a different release; managed binary stays163.
  unlinkSync(externalLink); symlinkSync(binaries[1]!, externalLink);
  const rebound = await waitFor(() => call("status", { key: "lead" }, saved.token), row => row.readiness === "busy" && row.runtime.binaryVersion === upgradeVersion);
  expect(rebound).toMatchObject({ bridge: saved.bridge, runtime: { hostInstanceId: saved.instance, generation: saved.generation } });
  expect(readJson<any>(attachmentPath)).toMatchObject({ token: saved.token, instance: saved.instance, generation: saved.generation, excludedInboxIds: saved.excludedInboxIds, binary: binaries[1]!, binaryVersion: upgradeVersion });
  expect(readJson<any>(cfgPath).runtime).toMatchObject({ binary: binaries[0]!, requiredVersion: "0.163.0" });
  expect((await call("mail-list")).inbox.find((row: any) => row.id === "upgrade-mail").state).toBe("queued");
  await stop(logs);
  // Seed the exact durable crash boundary: intent committed, attachment updated,
  // registry still names the prior binary. Journal persists the intent on restart.
  const { Registry } = await import("../src/registry.ts"); const registry = new Registry(state.dir); registry.enableJournal(state.dir);
  await registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason: "recovery", runtime: { ...lane.runtime!, binaryVersion: "0.163.0", held: true, state: "recovering", external: { ...lane.runtime!.external!, binary: binaries[0]!, rebind: { binary: binaries[1]!, binaryVersion: upgradeVersion }, holdReason: { code: "rebind-interrupted", message: "Attached runtime rebind incomplete; explicitly reattach to finish reconnection.", at: new Date().toISOString() } } } }));
  logs = await start();
  expect(await waitFor(() => call("status", { key: "lead" }, saved.token), row => row.readiness === "busy")).toMatchObject({ runtime: { binaryVersion: upgradeVersion } });
  expect((await call("mail-list")).inbox.find((row: any) => row.id === "upgrade-mail").state).toBe("queued");
  snapshot.thread.status = { type: "idle" }; snapshot.turns[0].status = "completed"; atomicJson(statePath, snapshot);
  const panes = readJson<any[]>(join(state.dir, "fixture-panes.json")); panes[0].agent_status = "idle"; atomicJson(join(state.dir, "fixture-panes.json"), panes);
  const mail = await waitFor(() => call("mail-list"), value => value.inbox.find((row: any) => row.id === "upgrade-mail")?.state === "sent");
  const delivered = mail.inbox.find((row: any) => row.id === "upgrade-mail"); expect(delivered.turnId).toBeTruthy();
  await stop(logs); logs = await start();
  expect(await call("status", { key: "lead" }, saved.token)).toMatchObject({ readiness: "ready", runtime: { binaryVersion: upgradeVersion } });
  expect((await call("mail-list")).inbox.find((row: any) => row.id === "upgrade-mail").turnId).toBe(delivered.turnId);
  const calls = readFileSync(join(state.dir, "external-codex-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(args => args[0] === "queue" && args[1] !== "--help")).toHaveLength(1); expect(calls.every(args => args[0] === "queue" || args.join(" ") === "app-server daemon version")).toBe(true);
  await stop(logs);
 } finally { daemon?.kill(); if (daemon) await daemon.exited; server.stop(true); state.done(); }
}, 30000);
