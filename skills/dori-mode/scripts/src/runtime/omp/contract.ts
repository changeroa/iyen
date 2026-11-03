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
  capabilities: { inspect: true; input: boolean; durableReceipts: boolean; durableFailures: boolean; hold: boolean; release: boolean; stop: boolean; goals: boolean; interactions?: boolean };
  eventSequence: number;
};
export type OmpOperation = { status: "absent" }
  | { status: "reserved" | "attempted" | "unknown"; operationId: string; payloadHash: string }
  | { status: "received"; receipt: OmpReceipt };
export type OmpMethod = "inspect" | "failures" | "input" | "operation" | "hold" | "release" | "stop" | "interactions" | "interaction-respond" | "interaction-response-status";
export type OmpRequest = { protocol: 1; id: string; token: string; target: OmpIdentity; method: OmpMethod; params: Record<string, unknown> };
export type OmpResponse = { protocol: 1; id: string; identity: OmpIdentity } & (
  { result: unknown; error?: never } | { error: { code: string; message: string; attempted: boolean }; result?: never });
export type OmpController = {
  inspect(): Promise<OmpSnapshot>;
  interactions(): Promise<NativeUserInteraction[]>;
  interactionRespond(requestId: string, response: NativeInteractionResponse, operationId: string): Promise<NativeInteractionReceipt>;
  interactionResponseStatus(operationId: string): Promise<NativeInteractionStatus>;
  failures(after: number, limit?: number): Promise<OmpFailurePage>;
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
    object(caps) && exactKeys(caps, ["inspect", "input", "durableReceipts", "durableFailures", "hold", "release", "stop", "goals"], ["interactions"]) && caps.inspect === true &&
    Object.values(caps).every(v => typeof v === "boolean");
}
export function parseRequest(value: unknown): OmpRequest {
  if (!object(value) || !exactKeys(value, ["protocol", "id", "token", "target", "method", "params"]) || value.protocol !== 1 ||
    !nonempty(value.id) || !nonempty(value.token) || !validIdentity(value.target) || !object(value.params) ||
    !["inspect", "failures", "input", "operation", "hold", "release", "stop", "interactions", "interaction-respond", "interaction-response-status"].includes(value.method as string)) throw new OmpError("invalid-request", "Invalid OMP request", false);
  const p = value.params, method = value.method;
  const fields = method === "inspect" || method === "interactions" ? [] : method === "interaction-respond" ? ["operationId", "requestId", "response"] : method === "interaction-response-status" ? ["operationId"] : method === "failures" ? ["after", "limit"] : method === "input" ? ["operationId", "text", "payloadHash"] : method === "operation" ? ["operationId", "payloadHash"] : method === "stop" ? ["operationId"] : ["operationId", "origin"];
  if (!exactKeys(p, fields) || (!["inspect", "interactions", "failures"].includes(method as string) && !nonempty(p.operationId)) ||
    (method === "interaction-respond" && (!nonempty(p.requestId) || !validInteractionResponse(p.response))) ||
    (method === "failures" && !validFailureRequest(p.after, p.limit)) ||
    ((method === "input" || method === "operation") && !hash(p.payloadHash)) ||
    (method === "input" && (typeof p.text !== "string" || payloadHash(p.text) !== p.payloadHash)) ||
    ((method === "hold" || method === "release") && !["user", "automatic"].includes(p.origin as string))) throw new OmpError("invalid-params", "Invalid OMP parameters", false);
  return value as OmpRequest;
}

export type OmpFailure = {
  sequence: number; failureId: string; sourceInstanceId: string; sourceGeneration: number; executionId: string;
  phase: "model" | "compaction"; category: "authentication" | "usage-limit" | "configuration" | "runtime"; observedAt: string;
};
export type OmpFailurePage = {
  streamId: string; sessionId: string; sessionFile: string; laneKey: string; role: "managed-lane";
  after: number; through: number; highWatermark: number; hasMore: boolean; records: OmpFailure[];
};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const validFailureRequest = (after: unknown, limit: unknown): boolean =>
  Number.isSafeInteger(after) && (after as number) >= 0 && Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100;
export function validateFailureRecord(value: unknown, streamId: string, sequence?: number): value is OmpFailure {
  return uuid(streamId) && object(value) && exactKeys(value, ["sequence", "failureId", "sourceInstanceId", "sourceGeneration", "executionId", "phase", "category", "observedAt"]) &&
    Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && (sequence === undefined || value.sequence === sequence) &&
    value.failureId === `omp-failure:${streamId}:${value.sequence}` && nonempty(value.sourceInstanceId) && value.sourceInstanceId.length <= 256 &&
    Number.isSafeInteger(value.sourceGeneration) && (value.sourceGeneration as number) >= 0 && nonempty(value.executionId) && value.executionId.length <= 512 &&
    ["model", "compaction"].includes(value.phase as string) && ["authentication", "usage-limit", "configuration", "runtime"].includes(value.category as string) &&
    typeof value.observedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) &&
    Number.isFinite(Date.parse(value.observedAt)) && new Date(value.observedAt).toISOString() === value.observedAt;
}
export function validateFailurePage(value: unknown, target: Pick<OmpIdentity, "sessionId" | "sessionFile" | "laneKey" | "role">, after: number, limit = 100): value is OmpFailurePage {
  if (!validFailureRequest(after, limit) || !object(value) || !exactKeys(value, ["streamId", "sessionId", "sessionFile", "laneKey", "role", "after", "through", "highWatermark", "hasMore", "records"]) ||
    !uuid(value.streamId) || target.role !== "managed-lane" || value.role !== target.role || value.sessionId !== target.sessionId || value.sessionFile !== target.sessionFile || value.laneKey !== target.laneKey ||
    value.after !== after || !Number.isSafeInteger(value.highWatermark) || (value.highWatermark as number) < after || !Array.isArray(value.records) || value.records.length > limit) return false;
  const count = Math.min(limit, (value.highWatermark as number) - after);
  return value.records.length === count && value.through === after + count && value.hasMore === ((value.through as number) < (value.highWatermark as number)) &&
    value.records.every((row, index) => validateFailureRecord(row, value.streamId as string, after + index + 1));
}

export type NativeUserInteraction = {
  id: string; sessionId: string; kind: "ask" | "select" | "confirm" | "input" | "editor" | "approval" | "plan-review";
  title: string; message?: string;
  questions?: { id: string; question: string; header?: string; options: { label: string; description?: string; preview?: string }[]; multi?: boolean; recommended?: number }[];
  options?: { id: string; label: string; description?: string; disabled?: boolean }[];
  placeholder?: string; defaultValue?: string; secret?: boolean;
  tiers?: { role: string; provider: string; model: string; thinkingLevel?: string }[];
  sourceEntryId?: string; sourceOperationHash?: string; toolCallId?: string; createdAt: string; expiresAt?: string;
};
export type NativeInteractionResponse = { kind: "cancel" } | {
  kind: "submit"; answers?: { id: string; selectedOptions: string[]; customInput?: string; note?: string }[];
  value?: string | boolean; choice?: string; feedback?: string; role?: string;
};
export type NativeInteractionReceipt = { status: "applied" | "stale"; requestId: string; operationId: string; responseHash: string };
export type NativeInteractionStatus = { status: "missing" | "pending" | "applied" | "stale"; requestId?: string; operationId: string; responseHash?: string };
export type NativeUserInteractions = {
  list(): NativeUserInteraction[];
  respond(requestId: string, response: NativeInteractionResponse, operationId: string): Promise<NativeInteractionReceipt>;
  responseStatus(operationId: string): NativeInteractionStatus;
};
const strings = (v: Record<string, unknown>, keys: string[]): boolean => keys.every(k => v[k] === undefined || typeof v[k] === "string");
const unique = (values: string[]): boolean => new Set(values).size === values.length;
export function validInteraction(value: unknown, sessionId: string): value is NativeUserInteraction {
  if (!object(value) || !exactKeys(value, ["id", "sessionId", "kind", "title", "createdAt"],
    ["message", "questions", "options", "placeholder", "defaultValue", "secret", "tiers", "sourceEntryId", "sourceOperationHash", "toolCallId", "expiresAt"]) ||
    !nonempty(value.id) || value.sessionId !== sessionId || !["ask", "select", "confirm", "input", "editor", "approval", "plan-review"].includes(value.kind as string) ||
    typeof value.title !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) ||
    !strings(value, ["message", "placeholder", "defaultValue", "sourceEntryId", "toolCallId"]) ||
    (value.sourceOperationHash !== undefined && !hash(value.sourceOperationHash)) || (value.secret !== undefined && typeof value.secret !== "boolean")) return false;
  if (value.sourceEntryId !== undefined && !nonempty(value.sourceEntryId)) return false;
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions) || !value.questions.length || !value.questions.every(q => object(q) &&
      exactKeys(q, ["id", "question", "options"], ["header", "multi", "recommended"]) && nonempty(q.id) && typeof q.question === "string" &&
      strings(q, ["header"]) && (q.multi === undefined || typeof q.multi === "boolean") && Array.isArray(q.options) &&
      q.options.every(o => object(o) && exactKeys(o, ["label"], ["description", "preview"]) && nonempty(o.label) && strings(o, ["description", "preview"])) &&
      unique(q.options.map((o: { label: string }) => o.label)) &&
      (q.recommended === undefined || (Number.isSafeInteger(q.recommended) && (q.recommended as number) >= 0 && (q.recommended as number) < q.options.length)))) return false;
    if (!unique(value.questions.map(q => q.id))) return false;
  }
  if (value.options !== undefined && (!Array.isArray(value.options) || !value.options.every(o => object(o) &&
    exactKeys(o, ["id", "label"], ["description", "disabled"]) && nonempty(o.id) && typeof o.label === "string" && strings(o, ["description"]) &&
    (o.disabled === undefined || typeof o.disabled === "boolean")) || !unique(value.options.map(o => o.id)))) return false;
  if (value.tiers !== undefined && (!Array.isArray(value.tiers) || !value.tiers.every(t => object(t) &&
    exactKeys(t, ["role", "provider", "model"], ["thinkingLevel"]) && nonempty(t.role) && nonempty(t.provider) && nonempty(t.model) && strings(t, ["thinkingLevel"])) ||
    !unique(value.tiers.map(t => t.role)))) return false;
  return (value.secret === true || value.kind !== "ask" || Array.isArray(value.questions)) &&
    (value.secret === true || !["select", "approval", "plan-review"].includes(value.kind as string) || (Array.isArray(value.options) && value.options.length > 0));
}
export function validInteractionResponse(value: unknown): value is NativeInteractionResponse {
  if (!object(value)) return false;
  if (value.kind === "cancel") return exactKeys(value, ["kind"]);
  return value.kind === "submit" && exactKeys(value, ["kind"], ["answers", "value", "choice", "feedback", "role"]) &&
    strings(value, ["choice", "feedback", "role"]) && (value.value === undefined || typeof value.value === "string" || typeof value.value === "boolean") &&
    (value.answers === undefined || (Array.isArray(value.answers) && value.answers.every(a => object(a) &&
      exactKeys(a, ["id", "selectedOptions"], ["customInput", "note"]) && nonempty(a.id) && Array.isArray(a.selectedOptions) &&
      a.selectedOptions.every(v => typeof v === "string") && unique(a.selectedOptions) && strings(a, ["customInput", "note"]))));
}
/** Validate against the currently open request, never a reconstructed/default choice. */
export function assertInteractionAnswer(request: NativeUserInteraction, response: NativeInteractionResponse): void {
  const invalid = () => { throw new OmpError("invalid-interaction-answer", "Answer does not match the offered native request", false); };
  if (!validInteractionResponse(response) || request.secret) return invalid();
  if (response.kind === "cancel") return;
  const fields = request.kind === "ask" ? ["answers"] : request.kind === "confirm" || request.kind === "input" || request.kind === "editor" ? ["value"] :
    request.kind === "plan-review" ? ["choice", "feedback", "role"] : ["choice"];
  if (!exactKeys(response as unknown as Record<string, unknown>, ["kind"], fields)) return invalid();
  if (request.kind === "ask") {
    if (!response.answers || response.answers.length !== request.questions!.length) return invalid();
    request.questions!.forEach((q, i) => {
      const a = response.answers![i]!;
      if (a.id !== q.id || (!q.multi && a.selectedOptions.length + Number(!!a.customInput?.trim()) !== 1) ||
        a.selectedOptions.some(label => !q.options.some(o => o.label === label))) invalid();
    });
  } else if (request.kind === "confirm") {
    if (typeof response.value !== "boolean") return invalid();
  } else if (request.kind === "input" || request.kind === "editor") {
    if (typeof response.value !== "string") return invalid();
  } else {
    if (!request.options?.some(o => o.id === response.choice && !o.disabled)) return invalid();
    if (request.kind === "approval" && !/^(once|session|deny|grant:.+:(once|always))$/.test(response.choice!)) return invalid();
    if (request.kind === "plan-review") {
      if (!["execute", "compact", "keep", "refine", "save"].includes(response.choice!)) return invalid();
      if (response.choice === "refine" && !response.feedback?.trim()) return invalid();
      if (response.feedback?.trim() && response.choice !== "refine") return invalid();
      const approves = ["execute", "compact", "keep"].includes(response.choice!);
      if (response.role !== undefined && (!approves || !request.tiers?.some(t => t.role === response.role))) return invalid();
      if (approves && request.tiers?.length && !response.role) return invalid();
    }
  }
}
export function validInteractionStatus(value: unknown, operationId: string): value is NativeInteractionStatus {
  return object(value) && exactKeys(value, ["status", "operationId"], ["requestId", "responseHash"]) && value.operationId === operationId &&
    ["missing", "pending", "applied", "stale"].includes(value.status as string) &&
    (value.requestId === undefined || nonempty(value.requestId)) && (value.responseHash === undefined || hash(value.responseHash)) &&
    (!["applied", "stale"].includes(value.status as string) || (nonempty(value.requestId) && hash(value.responseHash)));
}
