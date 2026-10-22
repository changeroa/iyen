import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Registry, type Lane } from "../src/registry.ts";
import { Mailbox } from "../src/mailbox.ts";
import { withState } from "./fakes.ts";
let state:ReturnType<typeof withState>;
beforeEach(()=>state=withState());afterEach(()=>state.done());
const lane:Lane={key:"state-lane",title:"one",thread:"none",brief:"/b",done:"closed a/b#1",openedAt:new Date().toISOString()};
test("concurrent registry mutations preserve both updates and stale snapshots are rejected",async()=>{
 const r=new Registry(state.dir);await r.write(lane);const stale=(await r.read(lane.key))!;
 await Promise.all([r.update(lane.key,l=>({...l,title:"two"})),r.update(lane.key,l=>({...l,thread:"chat:1"}))]);
 expect(await r.read(lane.key)).toMatchObject({title:"two",thread:"chat:1",revision:3});await expect(r.write({...stale,title:"lost"})).rejects.toThrow("Revision conflict");
});
test("journal restores missing snapshots and quarantines partial final records",async()=>{
 const r=new Registry(state.dir);r.enableJournal(state.dir);await r.write(lane);await r.update(lane.key,l=>({...l,title:"latest"}));
 unlinkSync(r.path(lane.key));appendFileSync(join(state.dir,"journal/events.jsonl"),'{"type":');
 const recovered=new Registry(state.dir);recovered.enableJournal(state.dir);
 expect((await recovered.read(lane.key))?.title).toBe("latest");expect(statSync(recovered.path(lane.key)).mode & 0o777).toBe(0o600);
});
test("registry rejects traversal keys",async()=>{
 const r=new Registry(state.dir);await expect(r.read("../../secret")).rejects.toThrow("Invalid lane key");
});
test("mailbox timeout persists unknown across restart without automatic duplicate delivery",async()=>{
 let calls=0;const m=new Mailbox(state.dir,"inbox");m.put({id:"one",target:"lane",text:"work",state:"queued",at:"now"});
 await expect(m.deliver("one",async()=>{calls++;throw new Error("lost response");})).rejects.toThrow();
 const restarted=new Mailbox(state.dir,"inbox");await expect(restarted.deliver("one",async()=>{calls++;return {};})).rejects.toThrow("unknown");expect(calls).toBe(1);
});
test("mailbox duplicate success returns receipt and rejects ID reuse for another input",async()=>{
 const m=new Mailbox(state.dir,"inbox");const row={id:"one",target:"lane",text:"work",state:"queued" as const,at:"now"};m.put(row);
 expect(await m.deliver("one",async()=>({turnId:"t1"}))).toMatchObject({state:"sent",turnId:"t1"});
 expect(await m.deliver("one",async()=>{throw new Error("must not execute");})).toMatchObject({turnId:"t1"});
 expect(()=>m.put({...row,text:"different"})).toThrow("different content");
});
