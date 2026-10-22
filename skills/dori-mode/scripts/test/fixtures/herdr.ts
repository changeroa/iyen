#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, openSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir=process.env.DORI_STATE_DIR!,args=process.argv.slice(2);
const file=join(dir,"fixture-panes.json");const panes=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):[];
if(args[0]==="--version")console.log("fixture-herdr");
else if(args[0]==="tab"&&args[1]==="create"){
 const id=crypto.randomUUID();panes.push({pane_id:`p-${id}`,tab_id:`t-${id}`,workspace_id:args.includes("--workspace")?args[args.indexOf("--workspace")+1]:undefined});writeFileSync(file,JSON.stringify(panes));console.log(JSON.stringify({result:{root_pane:panes.at(-1),tab_id:panes.at(-1).tab_id}}));
}else if(args[0]==="pane"&&args[1]==="run"){
 const fd=openSync(join(dir,"fixture-host.log"),"a");const p=spawn("/bin/sh",["-c",args[3]!],{detached:true,stdio:["ignore",fd,fd],env:process.env});p.unref();appendFileSync(join(dir,"fixture-pids"),String(p.pid)+"\n");
}else if(args[0]==="pane"&&args[1]==="list")console.log(JSON.stringify({result:{panes}}));
else if(args[1]==="close")writeFileSync(file,JSON.stringify(panes.filter((p:any)=>p.pane_id!==args[2]&&p.tab_id!==args[2])));
