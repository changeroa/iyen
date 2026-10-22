#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("codex-cli 0.163.0"); process.exit(0); }
const dir = join(process.env.DORI_STATE_DIR!, "fixture-codex"); mkdirSync(dir,{recursive:true});
let threadId="",goal:any=null;
const send=(m:unknown)=>process.stdout.write(JSON.stringify(m)+"\n");
let pending="";
for await(const chunk of Bun.stdin.stream()) {
 pending+=new TextDecoder().decode(chunk);
 while(pending.includes("\n")) {
  const end=pending.indexOf("\n"),line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;
  const m=JSON.parse(line);if(m.id===undefined)continue;
  let result:any={};
  if(m.method==="initialize")result={userAgent:"fixture"};
  else if(m.method==="model/list")result={data:[{id:"test",model:"test",isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"medium"}]}],nextCursor:null};
  else if(m.method==="thread/start" || m.method==="thread/resume") {
   threadId=m.params.threadId??crypto.randomUUID();
   if(m.method==="thread/resume" && !existsSync(join(dir,threadId))) {send({id:m.id,error:{code:-1,message:"thread missing"}});continue;}
   writeFileSync(join(dir,threadId),"thread");result={thread:{id:threadId,sessionId:"distinct-session",status:{type:"idle"}},modelProvider:"openai",model:"test"};
  } else if(m.method==="thread/read")result={thread:{id:threadId,status:{type:"idle"}}};
  else if(m.method==="thread/goal/get")result={goal};
  else if(m.method==="thread/goal/set"){goal={...goal,...m.params};result={goal};}
  else if(m.method==="thread/turns/list")result={data:[],nextCursor:null};
  else if(m.method==="turn/start"){
   const id=crypto.randomUUID();result={turn:{id,status:"completed"}};
   send({method:"turn/started",params:{threadId,turn:{id,status:"inProgress"}}});
   send({method:"turn/completed",params:{threadId,turn:{id,status:"completed"}}});
  } else if(m.method==="account/read")result={account:{type:"fixture"}};
  send({id:m.id,result});
 }
}
