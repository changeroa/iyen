import { RpcClient, RpcError } from "./protocol.ts";
import { isAbsolute } from "node:path";
import type { Thread } from "./generated/v2/Thread.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { Goal } from "./types.ts";

// There is deliberately no general RPC escape hatch on this interface. The TUI
// is the sole writer; even resuming an unloaded thread here would violate that.
export type ObserverMethod = "thread/read" | "thread/goal/get" | "thread/turns/list" | "thread/loaded/list" | "model/list" | "mcpServerStatus/list";
export type Observer = { read<T = any>(method: ObserverMethod, params: unknown): Promise<T>; close(): void };
const reads = new Set<ObserverMethod>(["thread/read", "thread/goal/get", "thread/turns/list", "thread/loaded/list", "model/list", "mcpServerStatus/list"]);
export class ObserverCompatibilityError extends Error {
  readonly code = "runtime-incompatible";
  constructor() { super("Shared Codex runtime lacks required read capabilities or returned an incompatible response; delivery is held."); }
}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const requireShape: (valid: unknown) => asserts valid = valid => { if (!valid) throw new ObserverCompatibilityError(); };
const turnStatuses = new Set(["completed", "interrupted", "failed", "inProgress"]);
const inputTypes = new Set(["text", "image", "localImage", "audio", "localAudio", "skill", "mention"]);
const goalStatuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
const PAGE_SIZE = 100, MAX_PAGES = 100, MAX_ENTRIES = PAGE_SIZE * MAX_PAGES;

const validateTurn = (turn: unknown): void => {
  requireShape(record(turn) && nonempty(turn.id) && turnStatuses.has(turn.status) && Array.isArray(turn.items) && turn.items.length <= MAX_ENTRIES);
  // Older releases omit itemsView. A declared partial view cannot establish
  // that an operation receipt is absent, even if its visible items look valid.
  requireShape(turn.itemsView === undefined || turn.itemsView === "full");
  for (const item of turn.items) {
    requireShape(record(item) && nonempty(item.type));
    if (item.type === "userMessage") {
      requireShape(Array.isArray(item.content) && item.content.length <= MAX_ENTRIES);
      for (const part of item.content) requireShape(record(part) && inputTypes.has(part.type) && (part.type !== "text" || typeof part.text === "string"));
    }
  }
};
const validatePage = (value: unknown): Record<string, any> => {
  requireShape(record(value) && Array.isArray(value.data) && value.data.length <= PAGE_SIZE &&
    (value.nextCursor === null || nonempty(value.nextCursor)));
  return value;
};
// Validate only the fields used for routing and receipts, tolerating additive
// response fields and new item kinds that cannot be mistaken for user input.
const validateRead = (method: ObserverMethod, value: unknown): void => {
  if (method === "thread/read") {
    requireShape(record(value) && record(value.thread));
    const thread = value.thread;
    requireShape(nonempty(thread.id) && typeof thread.cwd === "string" && isAbsolute(thread.cwd) && record(thread.status));
    requireShape(["notLoaded", "idle", "systemError", "active"].includes(thread.status.type));
    if (thread.status.type === "active") requireShape(Array.isArray(thread.status.activeFlags) &&
      thread.status.activeFlags.every((flag: unknown) => flag === "waitingOnApproval" || flag === "waitingOnUserInput"));
    requireShape((thread.model == null || nonempty(thread.model)) && (thread.reasoningEffort == null || nonempty(thread.reasoningEffort)));
  } else if (method === "thread/turns/list") {
    for (const turn of validatePage(value).data) validateTurn(turn);
  } else if (method === "thread/loaded/list") {
    requireShape(validatePage(value).data.every(nonempty));
  } else if (method === "thread/goal/get") {
    requireShape(record(value) && (value.goal === null || record(value.goal)));
    if (value.goal !== null) requireShape(goalStatuses.has(value.goal.status) && typeof value.goal.objective === "string" &&
      (value.goal.tokenBudget === null || (typeof value.goal.tokenBudget === "number" && Number.isSafeInteger(value.goal.tokenBudget) && value.goal.tokenBudget >= 0)));
  }
};
const checkedRead = async <T>(observer: Pick<Observer, "read">, method: ObserverMethod, params: unknown): Promise<T> => {
  let value: unknown;
  try { value = await observer.read(method, params); }
  catch (error) {
    if (error instanceof ObserverCompatibilityError || error instanceof RpcError && (error.code === -32601 || error.code === -32602)) throw new ObserverCompatibilityError();
    // RPC diagnostics can contain server-supplied private data. Preserve codes
    // for managed-session readiness retries, never the server's message.
    throw new RpcError("Codex observer read unavailable", error instanceof RpcError ? error.code : undefined);
  }
  validateRead(method, value);
  return value as T;
};
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
    return checkedRead({ read: (readMethod, readParams) => rpc.request(readMethod, readParams) }, method, params);
  }, close: () => rpc.disconnect() };
};

const readPages = async <T>(observer: Observer, method: "thread/turns/list" | "thread/loaded/list", params: object, identity: (entry: T) => string): Promise<T[]> => {
  const entries: T[] = [], cursors = new Set<string>(), identities = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page: { data: T[]; nextCursor: string | null } = await checkedRead(observer, method, { ...params, cursor, limit: PAGE_SIZE });
    for (const entry of page.data) {
      const id = identity(entry);
      requireShape(!identities.has(id)); identities.add(id); entries.push(entry);
    }
    requireShape(entries.length <= MAX_ENTRIES);
    if (page.nextCursor === null) return entries;
    requireShape(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new ObserverCompatibilityError();
};
export const readThread = (observer: Observer, threadId: string): Promise<{ thread: Thread }> => checkedRead(observer, "thread/read", { threadId });
export const readTurns = (observer: Observer, threadId: string): Promise<Turn[]> =>
  readPages<Turn>(observer, "thread/turns/list", { threadId, sortDirection: "desc", itemsView: "full" }, turn => turn.id);
export const readLoadedThreads = (observer: Observer): Promise<string[]> => readPages<string>(observer, "thread/loaded/list", {}, id => id);
export const receiptInTurns = (turns: Turn[], text: string): string | undefined => {
  for (const turn of turns) validateTurn(turn);
  const matches = turns.flatMap(turn => turn.items.filter(item => item.type === "userMessage" &&
    item.content.every(part => part.type === "text") && item.content.map(part => part.type === "text" ? part.text : "").join("\n") === text).map(() => turn));
  if (matches.length > 1) throw new Error("Duplicate operation receipts; reconcile before continuing");
  if (matches[0] && (typeof matches[0].id !== "string" || !matches[0].id.trim())) throw new Error("Missing turn receipt identity");
  return matches[0]?.id;
};
export const receipt = async (observer: Observer, threadId: string, text: string): Promise<string | undefined> => receiptInTurns(await readTurns(observer, threadId), text);
export const readGoal = async (observer: Observer, threadId: string): Promise<{ goal: Goal | null }> => {
  const value = await observer.read<{ goal: Goal | null }>("thread/goal/get", { threadId });
  validateRead("thread/goal/get", value);
  return value;
};
// Goal observation is optional only for borrowed sessions. Managed sessions
// continue to require goal reads for their pause/resume safety contract.
export const readOptionalGoal = async (observer: Observer, threadId: string): Promise<{ goal: Goal | null; available: boolean }> => {
  try { return { ...await readGoal(observer, threadId), available: true }; }
  catch { return { goal: null, available: false }; }
};
