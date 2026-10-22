#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
process.on("uncaughtException",error=>{writeFileSync(join(process.env.DORI_STATE_DIR!,"fixture-backend-error.json"),JSON.stringify({message:error.message,argv:process.argv,home:process.env.CODEX_HOME,path:process.env.PATH,state:process.env.DORI_STATE_DIR}));process.exit(1);});
process.on("unhandledRejection",error=>{writeFileSync(join(process.env.DORI_STATE_DIR!,"fixture-backend-error.json"),JSON.stringify({message:String(error),argv:process.argv,home:process.env.CODEX_HOME,path:process.env.PATH,state:process.env.DORI_STATE_DIR}));process.exit(1);});
if (process.argv.includes("--version")) { console.log("codex-cli 0.163.0"); process.exit(0); }
const home = process.env.CODEX_HOME ?? process.env.DORI_STATE_DIR!;
const dir = join(home, "fixture-codex"); mkdirSync(dir,{recursive:true});
const states = new Map<string,any>();
const overrides:any={};for(let i=2;i<process.argv.length;i++)if(process.argv[i]==="-c"){Object.assign(overrides,Bun.TOML.parse(process.argv[++i]!));}
let defaultThread = "";
const get = (id: string) => !id ? undefined : states.get(id) ?? (existsSync(join(dir,id)) ? JSON.parse(readFileSync(join(dir,id),"utf8")) : undefined);
const save = (t: any) => { states.set(t.id,t); writeFileSync(join(dir,t.id),JSON.stringify(t)); };
const handle = (m:any,send:(m:any)=>void) => {
 if(m.id===undefined)return;
 const p=m.params??{},id=p.threadId??defaultThread;let t=get(id),result:any={};
 if(m.method==="initialize")result={userAgent:"fixture"};
 else if(m.method==="model/list")result={data:[{id:"test",model:"test",isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"medium"}]}],nextCursor:null};
 else if(m.method==="thread/start" || m.method==="thread/resume") {
  if(m.method==="thread/resume"&&!t){send({id:m.id,error:{code:-1,message:"thread missing"}});return;}
  t??={id:crypto.randomUUID(),cwd:p.cwd,model:"test",reasoningEffort:"medium",modelProvider:"openai",status:{type:"idle"},turns:[],goal:null};
  t.path??=join(dir,`${t.id}.jsonl`);if(!existsSync(t.path))writeFileSync(t.path,JSON.stringify({type:"session_meta",payload:{id:t.id}})+"\n");
  t.status={type:"idle"};defaultThread=t.id;save(t);result={thread:t,modelProvider:"openai",model:"test"};
 }else if(m.method==="thread/loaded/list")result={data:[...states.values()].filter(t=>t.status.type!=="notLoaded").map(t=>t.id),nextCursor:null};
 else if(m.method==="thread/read")result={thread:t};
 else if(m.method==="thread/goal/get")result={goal:t?.goal??null};
 else if(m.method==="thread/goal/set"){t.goal={...t.goal,...p};save(t);result={goal:t.goal};}
 else if(m.method==="thread/turns/list")result={data:t?.turns??[],nextCursor:null};
 else if(m.method==="mcpServerStatus/list")result={data:[{name:"dori_runtime",runtimeStatus:"connected",tools:{control:{}}}],nextCursor:null};
 else if(m.method==="turn/start"){
  const turnId=crypto.randomUUID(),text=p.input?.map((x:any)=>x.text).join("\n")??"";
  const failed=text.startsWith("fixture-fail-auth");
  const turn={id:turnId,status:failed?"failed":"completed",items:[{type:"userMessage",content:[{type:"text",text}]}],error:failed?{codexErrorInfo:"unauthorized",message:"fixture auth failure"}:null};
  t.turns.unshift(turn);t.status={type:"idle"};save(t);result={turn};
  appendFileSync(t.path,JSON.stringify({type:"turn_context",payload:{turn_id:turnId,approval_policy:overrides.approval_policy??"on-request",sandbox_policy:{type:overrides.sandbox_mode??"workspace-write"}}})+"\n");
  send({method:"turn/started",params:{threadId:t.id,turn:{id:turnId,status:"inProgress"}}});
  send({method:"turn/completed",params:{threadId:t.id,turn}});
 }else if(m.method==="turn/interrupt"){for(const turn of t.turns)if(turn.status==="inProgress")turn.status="interrupted";t.status={type:"idle"};save(t);}
 else if(m.method==="thread/unload"){t.status={type:"notLoaded"};save(t);}
 else if(m.method==="account/read")result={account:{type:"fixture"}};
 send({id:m.id,result});
};
const listen=process.argv.indexOf("--listen"),endpoint=listen>=0?process.argv[listen+1]:"stdio://";
if(endpoint?.startsWith("unix://")) {
 appendFileSync(join(process.env.DORI_STATE_DIR!,"fixture-pids"),String(process.pid)+"\n");
 const server=Bun.serve({unix:endpoint.slice(7),fetch(req,server){if(server.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,data){handle(JSON.parse(String(data)),m=>ws.send(JSON.stringify(m)));}}});
 process.on("SIGTERM",()=>{server.stop(true);process.exit(0);});
}else{
 let pending="";for await(const chunk of Bun.stdin.stream()) {pending+=new TextDecoder().decode(chunk);while(pending.includes("\n")){const at=pending.indexOf("\n"),line=pending.slice(0,at);pending=pending.slice(at+1);if(line.trim())handle(JSON.parse(line),m=>process.stdout.write(JSON.stringify(m)+"\n"));}}
}
