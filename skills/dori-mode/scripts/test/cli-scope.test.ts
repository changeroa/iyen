import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { serviceSocket } from "../src/ipc.ts";
import { withState } from "./fakes.ts";

test("missing, malformed and revoked scoped contexts cannot enter local CLI handlers or create their side effects", async () => {
 const state=withState();
 try {
  const marker=join(state.dir,"local-side-effect"),script=join(state.dir,"side-effect.ts"),cfgPath=join(state.dir,"config.json"),context=join(state.dir,"context.json");
  await Bun.write(script,`await Bun.write(${JSON.stringify(marker)}, "executed"); console.log("transcript");`);
  mkdirSync(join(state.dir,"Library")); // Bun may create its own macOS cache root.
  atomicJson(cfgPath,{...defaultConfig(),stateDir:state.dir,defaultCwd:state.dir,heavyMaxLoad:999999,hooks:{transcribe:[process.execPath,script]}});
  const env={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,HOME:state.dir,DORI_STATE_DIR:state.dir,DORI_CONFIG:cfgPath,DORI_CONTEXT:context};
  const commands=[
   ["migrate","--apply"], ["session-host","--state-dir",state.dir,"--key","worker"], ["session-host-start","--state-dir",state.dir,"--key","worker"],
   ["serve"], ["doctor"], ["heavy","test","--",process.execPath,script], ["transcribe","fixture.wav"],
   ["send","slack","--to","fixture","--text","no external send"], ["presence","slack"], ["inbound","slack"],
  ];
  for (const form of ["missing","malformed","revoked"]) {
   if(form==="malformed")await Bun.write(context,"{");
   if(form==="revoked")atomicJson(context,{token:"revoked-generation",key:"lead",stateDir:state.dir});
   const before=readdirSync(state.dir).sort();
   for(const args of commands){
    const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args],{env,stdout:"pipe",stderr:"pipe",timeout:1000});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code).toBe(1);expect(out).toBe("");expect(err).toContain(`Scoped context cannot invoke local command ${args[0]}`);
   }
   expect(readdirSync(state.dir).sort()).toEqual(before);
  }
  expect(existsSync(marker)).toBe(false);expect(existsSync(join(state.dir,"hosts"))).toBe(false);expect(existsSync(join(state.dir,"heavy"))).toBe(false);
  expect(existsSync(join(state.dir,"service.lock"))).toBe(false);expect(existsSync(join(state.dir,"control.json"))).toBe(false);expect(existsSync(serviceSocket(state.dir))).toBe(false);
  for(const command of ["serve","status"]){
   const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),command],{env:{...env,DORI_CONTEXT:""},stdout:"pipe",stderr:"pipe",timeout:1000});
   const err=await new Response(child.stderr).text();expect(await child.exited).toBe(1);expect(err).toContain(command==="serve"?"Scoped context cannot invoke local command":"admin fallback prohibited");
  }
  const help=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"help"],{env,stdout:"pipe",stderr:"pipe"});
  const helpText=await new Response(help.stdout).text();expect(await help.exited).toBe(0);expect(helpText).toContain("scoped service commands");expect(helpText).toContain("lead-detach");expect(helpText).not.toMatch(/migrate|session-host|serve|transcribe/);
 }finally{state.done();}
},10000);
