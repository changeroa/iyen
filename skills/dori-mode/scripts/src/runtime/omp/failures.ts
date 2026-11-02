import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { OmpError, exactKeys, object, payloadHash, validFailureRequest, validateFailurePage, validateFailureRecord,
  type OmpController, type OmpFailure, type OmpFailurePage, type OmpIdentity } from "./contract.ts";
import { durableJson, privateDirectory, readPrivateJson } from "./receipts.ts";

type Binding = Pick<OmpIdentity, "sessionId" | "sessionFile" | "laneKey" | "role">;
const bindingOf = (target: Binding): Binding => ({ sessionId: target.sessionId, sessionFile: target.sessionFile, laneKey: target.laneKey, role: target.role });
const sameBinding = (value: unknown, target: Binding): boolean => object(value) && exactKeys(value, ["sessionId", "sessionFile", "laneKey", "role"]) &&
  Object.entries(bindingOf(target)).every(([key, expected]) => value[key] === expected);
const unavailable = (): OmpError => new OmpError("failure-channel-unavailable", "OMP durable failure channel unavailable; reconciliation required", false);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
type Journal = { version: 1; streamId: string; binding: Binding; nextSequence: number; records: OmpFailure[] };
/** Append-only, session-bound history. Every write fsyncs both the file and its directory. */
export class FailureJournal {
  private data!: Journal;
  private failed = false;
  constructor(readonly path: string, readonly target: OmpIdentity) {
    try {
      if (target.role !== "managed-lane") throw unavailable();
      privateDirectory(dirname(path));
      let saved: unknown;
      try { saved = readPrivateJson(path, MAX_JOURNAL_BYTES); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (saved === undefined) {
        this.data = { version: 1, streamId: randomUUID(), binding: bindingOf(target), nextSequence: 1, records: [] }; this.persist();
      } else {
        if (!object(saved) || !exactKeys(saved, ["version", "streamId", "binding", "nextSequence", "records"]) || saved.version !== 1 || !sameBinding(saved.binding, target) ||
          !Array.isArray(saved.records) || saved.nextSequence !== saved.records.length + 1) throw unavailable();
        // Page validation also authenticates an empty journal's stream UUID.
        const probe = { ...bindingOf(target), streamId: saved.streamId, after: 0, through: Math.min(100, saved.records.length), highWatermark: saved.records.length, hasMore: saved.records.length > 100, records: saved.records.slice(0, 100) };
        if (!validateFailurePage(probe, target, 0) || !saved.records.every((row, i) => validateFailureRecord(row, saved.streamId as string, i + 1))) throw unavailable();
        const executions = new Set<string>();
        for (const row of saved.records as OmpFailure[]) { const key = this.key(row); if (executions.has(key)) throw unavailable(); executions.add(key); }
        this.data = saved as Journal;
      }
    } catch { this.failed = true; throw unavailable(); }
  }
  get available(): boolean { return !this.failed; }
  invalidate(): void { this.failed = true; }
  private key(row: Pick<OmpFailure, "sourceInstanceId" | "sourceGeneration" | "executionId" | "phase">): string {
    return JSON.stringify([row.sourceInstanceId, row.sourceGeneration, row.executionId, row.phase]);
  }
  private persist(): void {
    try {
      // Exhaustion is a hard fence; never discard unseen history.
      if (Buffer.byteLength(JSON.stringify(this.data)) + 1 > MAX_JOURNAL_BYTES) throw unavailable();
      durableJson(this.path, this.data);
    } catch { this.failed = true; throw unavailable(); }
  }
  append(executionId: string, phase: OmpFailure["phase"], category: OmpFailure["category"]): void {
    if (this.failed) throw unavailable();
    const source = { sourceInstanceId: this.target.instanceId, sourceGeneration: this.target.generation, executionId, phase };
    if (this.data.records.some(row => this.key(row) === this.key(source))) return;
    const sequence = this.data.nextSequence;
    const record: OmpFailure = { ...source, sequence, failureId: `omp-failure:${this.data.streamId}:${sequence}`, category, observedAt: new Date().toISOString() };
    if (!validateFailureRecord(record, this.data.streamId, sequence)) { this.failed = true; throw unavailable(); }
    this.data.records.push(record); this.data.nextSequence++; this.persist();
  }
  page(after: number, limit = 100): OmpFailurePage {
    if (this.failed) throw unavailable();
    if (!validFailureRequest(after, limit)) throw new OmpError("invalid-params", "Invalid OMP failure cursor", false);
    const highWatermark = this.data.nextSequence - 1;
    if (after > highWatermark) throw unavailable();
    const records = this.data.records.slice(after, after + limit), through = after + records.length;
    return structuredClone({ ...this.data.binding, role: "managed-lane", streamId: this.data.streamId, after, through, highWatermark, hasMore: through < highWatermark, records });
  }
}
/** Only fixed categories leave the native event boundary. Native text never enters storage. */
export function failureCategory(error: unknown): OmpFailure["category"] {
  if (typeof error !== "string") return "runtime";
  if (/authentication|unauthorized|invalid.api.key|invalid.api_key|401\b/i.test(error)) return "authentication";
  if (/quota|rate.limit|usage.limit|429\b|insufficient.credit/i.test(error)) return "usage-limit";
  if (/configuration|unknown.model|model.not.found|invalid.model|missing.provider/i.test(error)) return "configuration";
  return "runtime";
}
export type OmpFailureEvent = { method: "runtime/failure"; params: { runtime: "omp"; streamId: string; sessionId: string; sessionFile: string; laneKey: string; failure: OmpFailure } };
type Cursor = { version: 1; binding: Binding; streamId: string; after: number };
/** Separate from ephemeral host checkpoints. Saving a cursor is only allowed after service ACK. */
export const failureCursorPath = (stateDir: string, target: Binding): string => join(stateDir, "hosts", "omp-failure-cursors", `${payloadHash(JSON.stringify(bindingOf(target)))}.json`);
export async function drainOmpFailures(controller: Pick<OmpController, "failures">, target: Binding, cursorPath: string,
  accept: (event: OmpFailureEvent) => Promise<unknown>, maxPages = 1): Promise<number> {
  if (target.role !== "managed-lane" || !Number.isSafeInteger(maxPages) || maxPages < 1) throw unavailable();
  let cursor: Cursor | undefined;
  try {
    const saved = readPrivateJson(cursorPath);
    if (!object(saved) || !exactKeys(saved, ["version", "binding", "streamId", "after"]) || saved.version !== 1 || !sameBinding(saved.binding, target) || !validFailureRequest(saved.after, 100)) throw unavailable();
    cursor = saved as Cursor;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable(); }
  let delivered = 0;
  for (let i = 0; i < maxPages; i++) {
    const after = cursor?.after ?? 0, page = await controller.failures(after, 100);
    if (!validateFailurePage(page, target, after) || (cursor && page.streamId !== cursor.streamId)) throw unavailable();
    if (!cursor) { cursor = { version: 1, binding: bindingOf(target), streamId: page.streamId, after: 0 }; durableJson(cursorPath, cursor); }
    for (const failure of page.records) {
      const ack = await accept({ method: "runtime/failure", params: { runtime: "omp", streamId: page.streamId, sessionId: target.sessionId, sessionFile: target.sessionFile, laneKey: target.laneKey, failure } });
      if (!object(ack) || ack.accepted !== true) throw unavailable();
      cursor = { ...cursor, after: failure.sequence };
      durableJson(cursorPath, cursor); delivered++;
    }
    if (!page.hasMore) break;
  }
  return delivered;
}
