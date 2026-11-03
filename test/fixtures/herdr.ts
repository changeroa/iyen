#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../src/journal.ts";
const dir=process.env.DORI_STATE_DIR!,args=process.argv.slice(2),file=join(dir,"fixture-panes.json");
const panes:any[]=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):[];
const save=()=>writeFileSync(file,JSON.stringify(panes));
const output=(result:any)=>console.log(JSON.stringify({result}));
const target=args[2],pane=panes.find(p=>p.pane_id===target||p.name===target);
const option=(name:string)=>args[args.indexOf(name)+1];
const rpc=async(endpoint:string,method:string,params:any)=>{
 const ws=new WebSocket(endpoint.replace("unix://","ws+unix://"));
 await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error("fixture connection"));});
 let n=0;const call=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++n;ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id===id){if(m.error)reject(new Error(m.error.message));else resolve(m.result);}};ws.send(JSON.stringify({id,method,params}));});
 try {await call("initialize",{});return await call(method,params);}finally{ws.close();}
};
appendFileSync(join(dir,"fixture-herdr-calls.jsonl"),JSON.stringify(args)+"\n");
if(args[0]==="--version")console.log("fixture-herdr");
else if(args[0]==="tab"&&args[1]==="create"){
 const id=crypto.randomUUID();panes.push({pane_id:`p-${id}`,tab_id:`t-${id}`,workspace_id:args.includes("--workspace")?option("--workspace"):undefined});save();output({root_pane:panes.at(-1),tab_id:panes.at(-1).tab_id});
}else if(args[0]==="agent"&&args[1]==="start"){
 const p=panes.find(p=>p.pane_id===option("--pane"));const a=args.slice(args.indexOf("--")+1);p.name=target;p.agent="codex";p.agent_status="idle";p.interactive_ready=true;p.endpoint=a[a.indexOf("--remote")+1];
 const resumed=a[0]==="resume"?a[1]:undefined;
 const {thread}=await rpc(p.endpoint,resumed?"thread/resume":"thread/start",{threadId:resumed,cwd:a[a.indexOf("--cd")+1]});p.thread=thread.id;p.agent_session=undefined;save();output({agent:p});
}else if(args[0]==="agent"&&args[1]==="get")output({agent:pane});
else if(args[0]==="agent"&&args[1]==="list")output({agents:panes.filter(p=>p.agent)});
else if(args[0]==="agent"&&args[1]==="read")console.log("OpenAI Codex TUI fixture");
else if(args[0]==="agent"&&args[1]==="prompt"){
 const text=args[3]!;
 const externalPath=join(dir,"external-state.json");
 if(existsSync(externalPath)){
  const state=JSON.parse(readFileSync(externalPath,"utf8")),active=state.turns.filter((t:any)=>t.status==="inProgress");
  if(pane.agent_status!=="working"||pane.agent_session?.value!==state.thread.id||state.thread.status.type!=="active"||state.thread.status.activeFlags.length||active.length!==1)throw new Error("fixture steer requires verified running turn");
  active[0].items.push({type:"userMessage",content:[{type:"text",text}]});atomicJson(externalPath,state);
 }else if(text==="/goal pause"||text==="/goal resume")await rpc(pane.endpoint,"thread/goal/set",{threadId:pane.thread,status:text.endsWith("pause")?"paused":"active"});
 else await rpc(pane.endpoint,"turn/start",{threadId:pane.thread,input:[{type:"text",text}]});
 output({agent:pane});
}else if(args[0]==="agent"&&args[1]==="send-keys"){
 if(args[3]==="ctrl+d"){await rpc(pane.endpoint,"thread/unload",{threadId:pane.thread});delete pane.agent;delete pane.name;delete pane.agent_session;}
 else await rpc(pane.endpoint,"turn/interrupt",{threadId:pane.thread});save();output({});
}else if(args[0]==="pane"&&args[1]==="report-agent-session"){
 pane.agent_session={agent:"codex",kind:"id",value:option("--agent-session-id")};save();output({});
}else if(args[0]==="pane"&&args[1]==="get")output({pane});
else if(args[0]==="pane"&&args[1]==="run"){if(!args[3]?.startsWith("export CODEX_HOME="))throw new Error("session-host must never occupy the pane");output({});}
else if(args[0]==="pane"&&args[1]==="list")output({panes});
else if(args[1]==="close"){writeFileSync(file,JSON.stringify(panes.filter(p=>p.pane_id!==target&&p.tab_id!==target)));output({});}
else throw new Error(`Unsupported fixture Herdr: ${args[0]} ${args[1]}`);
