import { expect, test } from "bun:test";
import { RpcClient, type RpcMessage } from "../src/runtime/protocol.ts";
import { CodexSession, safeEnvironment } from "../src/runtime/codex.ts";
import { defaultConfig } from "../src/config.ts";

const harness = (handle: (msg: RpcMessage) => unknown, timeout = 200) => {
 const sent: RpcMessage[] = []; let closed = false;
 const rpc = new RpcClient({ send: line => { const msg = JSON.parse(line); sent.push(msg); if (msg.id !== undefined && msg.method) queueMicrotask(() => { const result = handle(msg); if (result !== undefined) rpc.feed(JSON.stringify({id:msg.id,result})+"\n"); }); }, close: () => {closed=true;} },timeout);
 return {rpc,sent,closed:()=>closed};
};
test("RPC correlates out-of-order responses, split frames and server requests independently", async () => {
 const h=harness(()=>undefined); const events: string[]=[];
 h.rpc.onNotification=m=>events.push(m.method!); h.rpc.onRequest=m=>events.push(String(m.id));
 const a=h.rpc.request("a",{}),b=h.rpc.request("b",{});
 h.rpc.feed('{"id":2,"res'); h.rpc.feed('ult":"second"}\n{"method":"event"}\n{"id":"s1","method":"approval"}\n{"id":1,"result":"first"}\n');
 expect(await a).toBe("first");expect(await b).toBe("second");expect(events).toEqual(["event","s1"]);h.rpc.disconnect();
});
test("ambiguous timeout never retries a mutation", async () => {
 const h=harness(()=>undefined,10);
 await expect(h.rpc.request("turn/start",{})).rejects.toThrow("unknown");expect(h.sent).toHaveLength(1);h.rpc.disconnect();
});
test("malformed transport rejects outstanding operations and closes transport", async () => {
 const h=harness(()=>undefined);const pending=h.rpc.request("thread/start",{});
 h.rpc.feed('not-json\n');await expect(pending).rejects.toThrow("Invalid JSON");expect(h.closed()).toBe(true);
});
const sessionHarness = () => {
 let running=true,goal="active",waiting=false;const calls:string[]=[];
 const h=harness(m=>{
  calls.push(m.method!);
  if(m.method==="thread/read")return {thread:{id:"t1",status:running?{type:"active",activeFlags:waiting?["waitingOnApproval"]:[]}:{type:"idle"}}};
  if(m.method==="thread/goal/get")return {goal:{objective:"task",status:goal,tokenBudget:300}};
  if(m.method==="thread/goal/set"){goal=m.params.status;return {goal:{status:goal}};}
  if(m.method==="thread/turns/list")return {data:[{id:"turn1",status:running?"inProgress":"interrupted"}],nextCursor:null};
  if(m.method==="turn/interrupt"){running=false;return {};}
  if(m.method==="turn/steer")return {turnId:"turn1"};
  if(m.method==="turn/start")return {turn:{id:"turn2",status:"completed"}};
  return {};
 });
 const session=new CodexSession(h.rpc,{...defaultConfig().runtime,rpcTimeoutMs:50});session.threadId="t1";
 return {...h,session,calls,setWaiting:()=>{waiting=true;}};
};
test("Codex pause deactivates goal before interrupt and reads back stopped state", async()=>{
 const h=sessionHarness();const snap=await h.session.hold("user");
 expect(snap.state).toBe("idle");expect(snap.goal?.status).toBe("paused");
 expect(h.calls.indexOf("thread/goal/set")).toBeLessThan(h.calls.indexOf("turn/interrupt"));
 const goalRequest=h.sent.find(m=>m.method==="thread/goal/set");expect(goalRequest?.params).toEqual({threadId:"t1",status:"paused",origin:"user"});
 await expect(h.session.input("new work","m1")).rejects.toThrow("held");
 await h.session.release("user");expect(h.session.held).toBe(false);h.rpc.disconnect();
});
test("active input steers the observed turn and preserves literal shell characters",async()=>{
 const h=sessionHarness();expect(await h.session.input("`literal` $(literal)","m2")).toEqual({turnId:"turn1"});
 expect(h.sent.find(m=>m.method==="turn/steer")?.params.expectedTurnId).toBe("turn1");
 expect(h.sent.some(m=>m.method==="turn/start")).toBe(false);h.rpc.disconnect();
});
test("approval waiting blocks normal input and stale approval IDs cannot be reused",async()=>{
 const h=sessionHarness();h.setWaiting();await expect(h.session.input("yes","m3")).rejects.toThrow("waiting_approval");
 h.rpc.feed(JSON.stringify({id:"a1",method:"item/fileChange/requestApproval",params:{threadId:"t1",turnId:"turn1"}})+"\n");
 expect(()=>h.session.answer("a1",{decision:"acceptForSession"})).toThrow("one-shot");
 h.session.answer("a1",{decision:"decline"});expect(()=>h.session.answer("a1",{decision:"accept"})).toThrow("Expired");h.rpc.disconnect();
});
test("Codex child environment excludes messenger credentials and host capability",()=>{
 const env=safeEnvironment({PATH:"/bin",HOME:"/home/test",DORI_SLACK_TOKEN:"private",DORI_LANE_TOKEN:"scoped",UNRELATED_SECRET:"private"});
 expect(env).toEqual({PATH:"/bin",HOME:"/home/test",DORI_LANE_TOKEN:"scoped"});
});
test("permission approvals cannot grant access absent from the pending request",()=>{
 const h=sessionHarness();h.rpc.feed(JSON.stringify({id:"p1",method:"item/permissions/requestApproval",params:{threadId:"t1",permissions:{network:{enabled:true},fileSystem:{read:["/allowed"],write:null}}}})+"\n");
 expect(()=>h.session.answer("p1",{permissions:{fileSystem:{read:["/elsewhere"]}}})).toThrow("exceeds");
 h.session.answer("p1",{permissions:{network:{enabled:true}},scope:"turn"});
 expect(h.sent.at(-1)?.result).toEqual({permissions:{network:{enabled:true}},scope:"turn"});h.rpc.disconnect();
});
