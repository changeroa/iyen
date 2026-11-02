import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const OMP_PROTOCOL = 1 as const;
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
export type OmpIdentity = {
  kind: "omp"; sessionId: string; sessionFile: string; cwd: string; paneId: string; terminalId: string;
  instanceId: string; generation: number; role: "attached-lead" | "managed-lane";
  laneKey: string; protocol: 1; runtimeVersion: string;
};
export type OmpTarget = OmpIdentity & { socketPath: string; tokenFile: string };
export type OmpExtensionBootstrap = {
  protocol: 1; registryDir: string; role: "attached-lead" | "managed-lane"; laneKey: string;
  expectedCwd: string; expectedPaneId: string; expectedTerminalId: string;
  expectedSessionId?: string; expectedSessionFile?: string;
  service?: { contextFile: string; configFile: string; stateDir: string; cliPath: string; bunBinary: string };
};
export type OmpGoal = { status: "active" | "paused"; objective: string; tokenBudget: number | null } | null;
export type OmpReceipt = { operationId: string; payloadHash: string; sessionId: string; sessionFile: string; entryId: string; receiptId: string };
export type OmpSnapshot = {
  identity: OmpIdentity;
  state: "starting" | "idle" | "running" | "waiting_approval" | "waiting_input" | "pausing" | "recovering" | "failed" | "stopped";
  held: boolean; activeRunId?: string; goal: OmpGoal; model: string; provider: string; effort?: string;
  capabilities: { inspect: true; input: boolean; durableReceipts: boolean; hold: boolean; release: boolean; stop: boolean; goals: boolean };
  eventSequence: number;
};
export type OmpOperation = { status: "absent" }
  | { status: "reserved" | "attempted" | "unknown"; operationId: string; payloadHash: string }
  | { status: "received"; receipt: OmpReceipt };
export type OmpMethod = "inspect" | "input" | "operation" | "hold" | "release" | "stop";
export type OmpRequest = { protocol: 1; id: string; token: string; target: OmpIdentity; method: OmpMethod; params: Record<string, unknown> };
export type OmpResponse = { protocol: 1; id: string; identity: OmpIdentity } & (
  { result: unknown; error?: never } | { error: { code: string; message: string; attempted: boolean }; result?: never });
export type OmpController = {
  inspect(): Promise<OmpSnapshot>;
  input(text: string, operationId: string): Promise<{ receipt: OmpReceipt }>;
  operation(operationId: string, text: string): Promise<OmpOperation>;
  hold(origin: "user" | "automatic", operationId: string): Promise<OmpSnapshot>;
  release(origin: "user" | "automatic", operationId: string): Promise<OmpSnapshot>;
  /** Acknowledges shutdown intent only; the host must independently prove process exit. */
  stop(operationId: string): Promise<{ stopping: true }>;
  close(): void;
};
/** attempted=false is a verified pre-submit refusal; undefined is transport uncertainty. */
export class OmpError extends Error {
  constructor(readonly code: string, message: string, readonly attempted?: boolean) { super(message); this.name = "OmpError"; }
}
export const payloadHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const markedText = (text: string, operationId: string): string => `${text}\n\n[DORI_OPERATION:${payloadHash(operationId)}]`;
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
export const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
const identityKeys = ["kind", "sessionId", "sessionFile", "cwd", "paneId", "terminalId", "instanceId", "generation", "role", "laneKey", "protocol", "runtimeVersion"] as const;
export function identityOf(target: OmpIdentity): OmpIdentity {
  return Object.fromEntries(identityKeys.map(key => [key, target[key]])) as OmpIdentity;
}
export function validIdentity(value: unknown): value is OmpIdentity {
  return object(value) && exactKeys(value, identityKeys) && value.kind === "omp" && value.protocol === 1 &&
    typeof value.sessionId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.sessionId) &&
    ["sessionFile", "cwd", "paneId", "terminalId", "instanceId", "laneKey", "runtimeVersion"].every(key => nonempty(value[key])) &&
    isAbsolute(value.sessionFile as string) && isAbsolute(value.cwd as string) &&
    Number.isSafeInteger(value.generation) && (value.generation as number) >= 0 &&
    (value.role === "attached-lead" || value.role === "managed-lane");
}
export function sameIdentity(a: OmpIdentity, b: OmpIdentity): boolean { return identityKeys.every(key => a[key] === b[key]); }
export function assertIdentity(value: unknown, expected?: OmpIdentity): asserts value is OmpIdentity {
  if (!validIdentity(value) || (expected && !sameIdentity(value, expected))) throw new OmpError("identity-mismatch", "OMP exact session identity mismatch; outcome unknown");
}
export function validReceipt(value: unknown, target: OmpIdentity, operationId: string, digest: string): value is OmpReceipt {
  return object(value) && exactKeys(value, ["operationId", "payloadHash", "sessionId", "sessionFile", "entryId", "receiptId"]) &&
    value.operationId === operationId && value.payloadHash === digest && value.sessionId === target.sessionId &&
    value.sessionFile === target.sessionFile && nonempty(value.entryId) && value.receiptId === `omp-entry:${target.sessionId}:${value.entryId}`;
}
export function validSnapshot(value: unknown, target: OmpIdentity): value is OmpSnapshot {
  if (!object(value) || !exactKeys(value, ["identity", "state", "held", "goal", "model", "provider", "capabilities", "eventSequence"], ["activeRunId", "effort"]) ||
    !validIdentity(value.identity) || !sameIdentity(value.identity, target) || typeof value.held !== "boolean" ||
    !["starting", "idle", "running", "waiting_approval", "waiting_input", "pausing", "recovering", "failed", "stopped"].includes(value.state as string) ||
    typeof value.model !== "string" || typeof value.provider !== "string" || !Number.isSafeInteger(value.eventSequence) || (value.eventSequence as number) < 0 ||
    (value.activeRunId !== undefined && !nonempty(value.activeRunId)) || (value.effort !== undefined && !nonempty(value.effort))) return false;
  const goal = value.goal, caps = value.capabilities;
  return (goal === null || (object(goal) && exactKeys(goal, ["status", "objective", "tokenBudget"]) && ["active", "paused"].includes(goal.status as string) &&
    nonempty(goal.objective) && (goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget) && (goal.tokenBudget as number) > 0)))) &&
    object(caps) && exactKeys(caps, ["inspect", "input", "durableReceipts", "hold", "release", "stop", "goals"]) && caps.inspect === true &&
    Object.values(caps).every(v => typeof v === "boolean");
}
export function parseRequest(value: unknown): OmpRequest {
  if (!object(value) || !exactKeys(value, ["protocol", "id", "token", "target", "method", "params"]) || value.protocol !== 1 ||
    !nonempty(value.id) || !nonempty(value.token) || !validIdentity(value.target) || !object(value.params) ||
    !["inspect", "input", "operation", "hold", "release", "stop"].includes(value.method as string)) throw new OmpError("invalid-request", "Invalid OMP request", false);
  const p = value.params, method = value.method;
  const fields = method === "inspect" ? [] : method === "input" ? ["operationId", "text", "payloadHash"] : method === "operation" ? ["operationId", "payloadHash"] : method === "stop" ? ["operationId"] : ["operationId", "origin"];
  if (!exactKeys(p, fields) || (method !== "inspect" && !nonempty(p.operationId)) ||
    ((method === "input" || method === "operation") && !hash(p.payloadHash)) ||
    (method === "input" && (typeof p.text !== "string" || payloadHash(p.text) !== p.payloadHash)) ||
    ((method === "hold" || method === "release") && !["user", "automatic"].includes(p.origin as string))) throw new OmpError("invalid-params", "Invalid OMP parameters", false);
  return value as OmpRequest;
}
