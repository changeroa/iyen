import { join } from "node:path";
import { atomicText } from "./journal.ts";
import { Records, requiredText, type RecordEvent } from "./records.ts";
import type { Clock } from "./run.ts";

export const requestStatuses = ["received", "active", "waiting", "completed", "cancelled"] as const;
export type RequestStatus = typeof requestStatuses[number];
export type RequestEntry = { requestId: string; title: string; request: string; source: string; nextAction: string; status: RequestStatus; notes?: string; outcome?: string };
type RequestEvent = { kind: "record"; entry: RequestEntry } | { kind: "update"; requestId: string; patch: Partial<Pick<RequestEntry, "nextAction" | "status" | "notes" | "outcome">> };
export type RequestView = RequestEntry & { createdAt: string; updatedAt: string; history: RecordEvent<RequestEvent>[] };
export class RequestWorklog {
  readonly records: Records<RequestEvent>;
  readonly markdown: string;
  constructor(stateDir: string, clock: Clock) {
    this.records = new Records(join(stateDir, "worklog"), clock);
    this.markdown = join(stateDir, "worklog", "requests.md");
  }
  list(): RequestView[] {
    const views = new Map<string, RequestView>();
    for (const event of this.records.list()) {
      const p = event.payload;
      if (p.kind === "record") views.set(p.entry.requestId, { ...p.entry, createdAt: event.at, updatedAt: event.at, history: [event] });
      else {
        const before = views.get(p.requestId);
        if (!before) throw new Error("Worklog update without request");
        views.set(p.requestId, { ...before, ...p.patch, updatedAt: event.at, history: [...before.history, event] });
      }
    }
    return [...views.values()];
  }
  read(requestId: string): RequestView {
    const view = this.list().find(entry => entry.requestId === requestId);
    if (!view) throw new Error("Unknown request");
    return view;
  }
  record(eventId: string, input: Omit<RequestEntry, "status">): RequestView {
    for (const field of ["requestId", "title", "request", "source", "nextAction"] as const) requiredText(input[field], field);
    const entry: RequestEntry = { requestId: input.requestId, title: input.title, request: input.request, source: input.source, nextAction: input.nextAction, status: "received" };
    const payload: RequestEvent = { kind: "record", entry };
    if (!this.records.existing(eventId, payload) && this.list().some(row => row.requestId === entry.requestId)) throw new Error("Request already recorded; use update");
    this.records.append(eventId, payload); this.render(); return this.read(entry.requestId);
  }
  update(eventId: string, requestId: string, patch: Partial<Pick<RequestEntry, "nextAction" | "status" | "notes" | "outcome">>): RequestView {
    requiredText(requestId, "requestId");
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as typeof patch;
    if (!Object.keys(clean).length || Object.keys(clean).some(key => !["nextAction", "status", "notes", "outcome"].includes(key))) throw new Error("Explicit worklog update required");
    for (const [field, value] of Object.entries(clean)) requiredText(value, field);
    if (clean.status && !requestStatuses.includes(clean.status)) throw new Error("Invalid request status");
    const payload: RequestEvent = { kind: "update", requestId, patch: clean };
    if (!this.records.existing(eventId, payload)) {
      const current = this.read(requestId);
      if (["completed", "cancelled"].includes(clean.status ?? "") && !(clean.outcome ?? current.outcome)?.trim()) throw new Error("Completion or cancellation requires an outcome");
    }
    this.records.append(eventId, payload); this.render(); return this.read(requestId);
  }
  /** Rebuildable view; an error here never removes or repeats the committed event. */
  render(): string {
    const text = "# Request commitments\n\nThis is a derived view of events.jsonl, not an execution queue.\n\n" + this.list().map(row =>
      `## ${row.title}\n\nRequest: ${row.requestId}\nSource: ${row.source}\nStatus: ${row.status}\n\n${row.request}\n\nNext action: ${row.nextAction}\n\n` +
      row.history.filter(event => event.payload.kind === "update" && event.payload.patch.notes).map(event => `${event.at}: ${(event.payload as Extract<RequestEvent, {kind:"update"}>).patch.notes}\n\n`).join("") +
      (row.outcome ? `Outcome: ${row.outcome}\n\n` : "")).join("");
    atomicText(this.markdown, text); return this.markdown;
  }
}
