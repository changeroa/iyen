import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { HerdrSession, operationText } from "../src/runtime/herdr.ts";
import { connectObserver, type Observer } from "../src/runtime/observer.ts";
import { prepareBackend, resolveCodexBinary, retireBackend, type Bootstrap } from "../src/runtime/session-host.ts";
import { socketDir } from "../src/ipc.ts";
import { RpcError } from "../src/runtime/protocol.ts";
import { withState } from "./fakes.ts";
const harness = () => {
 const calls:string[][]=[],reads:string[]=[];
 let turns:any[]=[],goal:any=null,status:any={type:"idle"},agentThread="t1",failGoal=false,failStatus=false,accept=true;
 const clock={at:0,now:()=>clock.at,sleep:async(ms:number)=>{clock.at+=ms;}};
 const observer:Observer={close(){},async read(method){reads.push(method);if(method==="thread/goal/get"){if(failGoal)throw new Error("goal unknown");return {goal} as any;}if(method==="thread/read"){if(failStatus)throw new Error("status failed");return {thread:{id:"t1",status}} as any;}if(method==="thread/turns/list")return {data:turns,nextCursor:null} as any;throw new Error(method);}};
 const run=async(argv:readonly string[])=>{
  calls.push([...argv]);const [,group,action]=argv;
  if(group==="agent"&&action==="prompt"){
   const text=argv[4]!;
   if(text==="/goal pause")goal={...goal,status:"paused"};
   else if(text==="/goal resume")goal={...goal,status:"active"};
   else if(accept)turns=[{id:"receipt-turn",status:"completed",items:[{type:"userMessage",content:[{type:"text",text}]}]}];
  }
  if(group==="agent"&&action==="send-keys"&&argv[4]==="esc"){turns=turns.map(t=>({...t,status:"interrupted"}));status={type:"idle"};}
  return {code:0,err:"",out:JSON.stringify({result:{agent:{agent:"codex",pane_id:"p1",name:"test-agent",agent_status:"idle",agent_session:{agent:"codex",kind:"id",value:agentThread}}}})};
 };
 const session=new HerdrSession(observer,run,{...defaultConfig().runtime,rpcTimeoutMs:200},"p1","test-agent",clock);session.threadId="t1";
 return {session,observer,calls,reads,setTurns:(v:any[])=>turns=v,setGoal:(v:any)=>goal=v,setStatus:(v:any)=>status=v,drift:()=>agentThread="other",failGoal:()=>failGoal=true,failStatus:()=>failStatus=true,noReceipt:()=>accept=false,run};
};
test("Herdr prompt acknowledgement is not a receipt; missing exact user marker fails closed without replay",async()=>{
 const h=harness();h.noReceipt();await expect(h.session.input("task","op1")).rejects.toThrow("receipt unknown");
 expect(h.calls.filter(a=>a[2]==="prompt")).toHaveLength(1);
});
test("exact persisted user-message receipt survives fast completion and needs no later status read",async()=>{
 const h=harness();expect(await h.session.input("literal $(x) `x`","op1")).toEqual({turnId:"receipt-turn"});
 h.failStatus();expect(h.calls.find(a=>a[2]==="prompt")?.[4]).toBe(operationText("literal $(x) `x`","op1"));
 expect(h.reads.filter(r=>r==="thread/read")).toHaveLength(1);
});
test("assistant echo or another user prompt is not operation evidence; duplicate receipts are rejected",async()=>{
 const h=harness();h.noReceipt();h.setTurns([{id:"wrong",status:"completed",items:[{type:"agentMessage",text:operationText("task","op")},{type:"userMessage",content:[{type:"text",text:"other"}]}]}]);
 await expect(h.session.input("task","op")).rejects.toThrow("receipt unknown");
 h.setTurns([1,2].map(n=>({id:String(n),status:"completed",items:[{type:"userMessage",content:[{type:"text",text:operationText("task","op")}]}]})));
 await expect(h.session.input("task","op")).rejects.toThrow("Duplicate");
});
test("known receipt is returned without sending the prompt twice",async()=>{
 const h=harness();await h.session.input("task","op");expect(await h.session.input("task","op")).toEqual({turnId:"receipt-turn"});expect(h.calls.filter(a=>a[2]==="prompt")).toHaveLength(1);
});
test("notLoaded and changed TUI thread identity never become idle or accept work",async()=>{
 const h=harness();h.setStatus({type:"notLoaded"});await expect(h.session.inspect()).rejects.toThrow("affinity");
 h.drift();await expect(h.session.input("task","op")).rejects.toThrow("identity changed");expect(h.calls.some(a=>a[2]==="prompt")).toBe(false);
});
test("native goal pause precedes escape and confirms original turn stopped, then resume preserves goal budget",async()=>{
 const h=harness();h.setGoal({status:"active",objective:"task",tokenBudget:42});h.setStatus({type:"active",activeFlags:[]});h.setTurns([{id:"active",status:"inProgress",items:[]}]);
 expect(await h.session.hold("automatic")).toMatchObject({state:"idle",goal:{status:"paused",tokenBudget:42}});
 const controls=h.calls.filter(a=>a[2]==="prompt"||a[2]==="send-keys");expect(controls.map(a=>a[4])).toEqual(["/goal pause","esc"]);
 expect(await h.session.release("automatic")).toMatchObject({goal:{status:"active",tokenBudget:42}});
});
test("unknown goal state holds dispatch without sending escape or claiming inactive",async()=>{
 const h=harness();h.failGoal();await expect(h.session.hold("user")).rejects.toThrow("goal unknown");expect(h.session.held).toBe(true);expect(h.calls.some(a=>a[2]==="send-keys")).toBe(false);
});
test("changed or budget-limited goal is never silently reactivated",async()=>{
 const h=harness();h.session.held=true;h.session.goalWasActive=true;h.session.pausedGoal={status:"active",objective:"original",tokenBudget:10};
 for(const goal of [{status:"paused",objective:"replacement",tokenBudget:10},{status:"budgetLimited",objective:"original",tokenBudget:10}]){h.setGoal(goal);await expect(h.session.release("user")).rejects.toThrow("goal changed");}
 expect(h.session.held).toBe(true);expect(h.calls.some(a=>a[4]==="/goal resume")).toBe(false);
});
test("observer uses Unix WebSocket and refuses mutation methods at runtime",async()=>{
 const state=withState(),methods:string[]=[];const socket=join(socketDir(state.dir),"observer.sock");
 const server=Bun.serve({unix:socket,fetch(req,s){if(s.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,data){const m=JSON.parse(String(data));methods.push(m.method);if(m.id)ws.send(JSON.stringify({id:m.id,result:{goal:null}}));}}});
 try{const observer=await connectObserver(socket,500);expect(await observer.read<{goal:null}>("thread/goal/get",{threadId:"t"})).toEqual({goal:null});await expect(observer.read("turn/start" as any,{})).rejects.toThrow("mutation prohibited");observer.close();expect(methods).not.toContain("turn/start");}finally{server.stop(true);state.done();}
});
test("bare and absolute configured binaries resolve to an executable without recursive shim",()=>{
 const state=withState();try{const bin=join(state.dir,"codex");writeFileSync(bin,"#!/bin/sh\nexit 0\n");chmodSync(bin,0o700);expect(resolveCodexBinary("codex",state.dir)).toBe(realpathSync(bin));expect(resolveCodexBinary(bin)).toBe(realpathSync(bin));}finally{state.done();}
});
test("backend inherits established settings/auth without copying or replacing them, and scopes only Dori overrides",()=>{
 const state=withState();try{
  const source=join(state.dir,"source-home");mkdirSync(source);writeFileSync(join(source,"config.toml"),'[mcp_servers.user_tool]\ncommand="preserve-me"\n');writeFileSync(join(source,"auth.json"),"refreshed-auth-marker");
  const client=join(state.dir,"clients/lane");mkdirSync(client,{recursive:true});
  const config={...defaultConfig(),runtime:{...defaultConfig().runtime,binary:process.execPath,settingsHome:source,roles:{lead:{model:"test",effort:"medium"},lane:{model:"test",effort:"medium"}}}};
  const boot:Bootstrap={key:"lane",role:"lane",instance:"i",generation:1,hostToken:"HOST_SECRET",laneToken:"LANE_SECRET",cwd:state.dir,pane:"p",blocked:false,config};
  const prepared=prepareBackend(state.dir,boot);expect(prepared.home).toBe(source);expect(readFileSync(join(source,"auth.json"),"utf8")).toBe("refreshed-auth-marker");expect(readFileSync(join(source,"config.toml"),"utf8")).toContain("preserve-me");
  const args=prepared.args.join(" ");expect(args).toContain("mcp_servers.dori_runtime=");expect(args).not.toContain("HOST_SECRET");expect(args).not.toContain("LANE_SECRET");expect(args).not.toContain("mcp_servers.user_tool");
  expect(readFileSync(join(client,"codex"),"utf8")).toContain(`exec '${prepared.binary}'`);
 }finally{state.done();}
});

test("stop receipt waits for owned backend exit, and a timeout remains unconfirmed",async()=>{
 let resolveExit!:(code:number)=>void,killed=false,done=false;const exited=new Promise<number>(r=>resolveExit=r);
 const stop=retireBackend({kill(){killed=true;},exited},200).then(()=>{done=true;});
 await Bun.sleep(5);expect(killed).toBe(true);expect(done).toBe(false);resolveExit(0);await stop;expect(done).toBe(true);
 await expect(retireBackend({kill(){},exited:new Promise(()=>{})},5)).rejects.toThrow("exit unconfirmed");
});

test("first-launch identity may precede materialization; startup retries observation without replaying handshake",async()=>{
 const state=withState();try{
  const h=harness(),read=h.observer.read;let first=true,polls=0,metadataTransient=true,mcpTransient=true;
  const rollout=join(state.dir,"rollout.jsonl");writeFileSync(rollout,JSON.stringify({type:"session_meta",payload:{id:"t1"}})+"\n"+JSON.stringify({type:"turn_context",payload:{turn_id:"receipt-turn",approval_policy:"on-request",sandbox_policy:{type:"workspace-write"}}})+"\n");
  h.session.threadId="";
  h.observer.read=async(method,params)=>{
   if(method==="model/list")return {data:[{model:"test",supportedReasoningEfforts:[{reasoningEffort:"medium"}]}],nextCursor:null} as any;
   if(method==="mcpServerStatus/list"&&mcpTransient){mcpTransient=false;throw new RpcError("MCP metadata not ready");}
   if(method==="mcpServerStatus/list")return {data:[{name:"dori_runtime",runtimeStatus:"connected",tools:{control:{}}}]} as any;
   if(method==="thread/read"&&metadataTransient){metadataTransient=false;throw new RpcError("thread metadata flush pending");}
   if(method==="thread/read")return {thread:{id:"t1",path:rollout,cwd:state.dir,modelProvider:"openai",model:"test",reasoningEffort:"medium",status:{type:"idle"}}} as any;
   if(method==="thread/turns/list"&&first){first=false;throw new RpcError("thread t1 is not materialized yet; first user message pending");}
   if(method==="thread/turns/list"&&++polls<4){const result:any=await read(method,params);return {...result,data:result.data.map((t:any)=>({...t,status:"inProgress"}))};}
   return read(method,params);
  };
  await h.session.open(state.dir,{model:"test",effort:"medium"},"unix:///test.sock","instance1");
  expect(polls).toBeGreaterThanOrEqual(4);expect(h.session.threadId).toBe("t1");expect(h.calls.filter(a=>a[2]==="prompt")).toHaveLength(1);expect(h.calls.find(a=>a[2]==="prompt")?.[4]).toContain("Do not execute a task");
 }finally{state.done();}
});

test("effective handshake policy gate rejects a widened sandbox and wrong rollout identity",async()=>{
 const {verifyTurnPolicy}=await import("../src/runtime/policy.ts");const state=withState();try{
  const file=join(state.dir,"owned.jsonl"),config={...defaultConfig().runtime,sandbox:"read-only" as const,approvalPolicy:"never" as const};
  const write=(id:string,sandbox:string)=>writeFileSync(file,JSON.stringify({type:"session_meta",payload:{id}})+"\n"+JSON.stringify({type:"turn_context",payload:{turn_id:"turn",approval_policy:"never",sandbox_policy:{type:sandbox}}})+"\n");
  write("thread","danger-full-access");await expect(verifyTurnPolicy(file,"thread","turn",config)).rejects.toThrow("policy mismatch");
  write("other","read-only");await expect(verifyTurnPolicy(file,"thread","turn",config)).rejects.toThrow("identity mismatch");
  write("thread","read-only");await verifyTurnPolicy(file,"thread","turn",config);
 }finally{state.done();}
});
