import { RpcClient } from "./protocol.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { Goal } from "./types.ts";

// There is deliberately no general RPC escape hatch on this interface. The TUI
// is the sole writer; even resuming an unloaded thread here would violate that.
export type ObserverMethod = "thread/read" | "thread/goal/get" | "thread/turns/list" | "thread/loaded/list" | "model/list" | "mcpServerStatus/list";
export type Observer = { read<T = any>(method: ObserverMethod, params: unknown): Promise<T>; close(): void };
const reads = new Set<ObserverMethod>(["thread/read", "thread/goal/get", "thread/turns/list", "thread/loaded/list", "model/list", "mcpServerStatus/list"]);
export const connectObserver = async (socket: string, timeoutMs: number): Promise<Observer> => {
  // Codex's Unix listener is WebSocket, not NDJSON. Bun supports ws+unix.
  const ws = new WebSocket(`ws+unix://${socket}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Observer connection timed out")); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Observer connection failed")); };
  });
  const rpc = new RpcClient({ send: line => ws.send(line.trimEnd()), close: () => ws.close() }, timeoutMs);
  ws.onmessage = event => rpc.feed(String(event.data) + "\n");
  ws.onclose = () => rpc.disconnect();
  // Never answer a server request on the observer connection.
  try {
    await rpc.request("initialize", { clientInfo: { name: "dori-readonly-observer", version: "0.3.0" }, capabilities: null });
    rpc.notify("initialized");
  } catch (error) { rpc.disconnect(); throw error; }
  return { read: (method, params) => {
    if (!reads.has(method)) return Promise.reject(new Error("Observer mutation prohibited"));
    return rpc.request(method, params);
  }, close: () => rpc.disconnect() };
};

export const readTurns = async (observer: Observer, threadId: string): Promise<Turn[]> => {
  const turns: Turn[] = []; let cursor: string | null = null;
  do {
    const page: { data: Turn[]; nextCursor: string | null } = await observer.read("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full" });
    turns.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return turns;
};
export const readLoadedThreads = async (observer: Observer): Promise<string[]> => {
  const threads: string[] = []; let cursor: string | null = null;
  do {
    const page: { data: string[]; nextCursor: string | null } = await observer.read("thread/loaded/list", { cursor, limit: 100 });
    threads.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return threads;
};
export const receipt = async (observer: Observer, threadId: string, text: string): Promise<string | undefined> => {
  const matches = (await readTurns(observer, threadId)).filter(turn => turn.items.some(item => item.type === "userMessage" &&
    item.content.filter(part => part.type === "text").map(part => part.text).join("\n") === text));
  if (matches.length > 1) throw new Error("Duplicate operation receipts; reconcile before continuing");
  return matches[0]?.id;
};
export const readGoal = (observer: Observer, threadId: string): Promise<{ goal: Goal | null }> => observer.read("thread/goal/get", { threadId });
