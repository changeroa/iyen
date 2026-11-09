import { isDeepStrictEqual } from "node:util";
import { Journal } from "./journal.ts";
import { iso, type Clock } from "./run.ts";

export const requiredText = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 128 * 1024) throw new Error(`${name} must be nonempty text (max 128 KiB)`);
  return value;
};
export type RecordEvent<T> = { eventId: string; at: string; payload: T };
/** Service-owned append-only records. No scheduling or execution follows an append. */
export class Records<T> {
  readonly journal: Journal;
  constructor(dir: string, readonly clock: Clock) { this.journal = new Journal(dir); }
  list(): RecordEvent<T>[] { return this.journal.read(); }
  existing(eventId: string, payload: T): RecordEvent<T> | undefined {
    requiredText(eventId, "eventId");
    const prior = this.list().find(event => event.eventId === eventId);
    if (prior && !isDeepStrictEqual(prior.payload, JSON.parse(JSON.stringify(payload)))) throw new Error("Event ID reused with different content");
    return prior;
  }
  append(eventId: string, payload: T): RecordEvent<T> {
    const prior = this.existing(eventId, payload);
    if (prior) return prior;
    const event = { eventId, at: iso(this.clock), payload: JSON.parse(JSON.stringify(payload)) as T };
    this.journal.append(event);
    return event;
  }
}
