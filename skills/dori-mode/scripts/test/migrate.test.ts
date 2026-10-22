import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/migrate.ts";
import { atomicJson } from "../src/journal.ts";
import { withState } from "./fakes.ts";
let state:ReturnType<typeof withState>;
beforeEach(()=>state=withState());afterEach(()=>state.done());
const oldLane={key:"old-lane",title:"old",thread:"chat:1",session:"legacy-session",pane:"old:p1",brief:"/old-brief",done:"closed a/b#1",openedAt:"2026-01-01T00:00:00Z",status:"paused",pausedFrom:"not-done",claim:{at:"2026-01-01T01:00:00Z",evidence:"old evidence"}};
const setup=()=>{const path=join(state.dir,"config.json");atomicJson(path,{stateDir:state.dir,agentCommand:["legacy-agent"],sessionsDir:"/legacy/sessions"});atomicJson(join(state.dir,"lanes/old-lane.json"),oldLane);return path;};
test("migration dry run leaves configuration and registry byte-for-byte unchanged",async()=>{
 const path=setup();const before=readFileSync(path,"utf8"),lane=readFileSync(join(state.dir,"lanes/old-lane.json"),"utf8");
 const report:any=await migrate(false,path);expect(report.dryRun).toBe(true);expect(readFileSync(path,"utf8")).toBe(before);expect(readFileSync(join(state.dir,"lanes/old-lane.json"),"utf8")).toBe(lane);
});
test("active migration requires stopped-source confirmation and preserves status, thread, claim and legacy ID",async()=>{
 const path=setup();await expect(migrate(true,path)).rejects.toThrow("handoff-file");const brief=join(state.dir,"handoff.md");await Bun.write(brief,"Remaining work and evidence");
 const result:any=await migrate(true,path,{stoppedConfirmed:true,lanes:{"old-lane":brief}});
 const migrated=JSON.parse(readFileSync(join(state.dir,"lanes/old-lane.json"),"utf8"));
 expect(migrated).toMatchObject({schemaVersion:2,status:"paused",pausedFrom:"not-done",thread:"chat:1",legacy:{sessionId:"legacy-session"},dispatchBlocked:true,holdReason:"recovery",claim:oldLane.claim});expect(migrated.runtime.threadId).toBeUndefined();expect(migrated.pane).toBeUndefined();expect(existsSync(result.backup)).toBe(true);
 expect(await migrate(true,path)).toMatchObject({applied:false});
 // Backup lies beside the state directory and is created by this test.
 const {rmSync}=await import("node:fs");rmSync(result.backup,{recursive:true,force:true});
});
