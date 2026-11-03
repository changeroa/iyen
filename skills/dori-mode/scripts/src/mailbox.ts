import { join } from "node:path";
import { existsSync } from "node:fs";
import { atomicJson, SerialQueue } from "./journal.ts";
import { readJson } from "./ipc.ts";
import { fill, type ArgvTemplate } from "./config.ts";
import type { Runner } from "./run.ts";
import type { OmpReceipt, OmpTarget } from "./runtime/omp/contract.ts";
export type OmpMailProvenance = { target: OmpTarget; attachmentInstanceId: string; attachmentGeneration: number };
export type MailAbandonment = {
  operationId: string; evidence: string; at: string;
  original: Omit<Mail, "abandonment">;
  epoch: { hostInstanceId: string; generation: number; target: OmpTarget };
  outcome: "pending" | "received" | "abandoned";
  delivery: "not-attempted" | "unknown";
  completedAt?: string; processStoppedAt?: string;
};
export type Mail = { id: string; target: string; text: string; state: "queued" | "sending" | "sent" | "unknown" | "abandoned"; abandonment?: MailAbandonment; turnId?: string; receiptKind?: "omp-session-entry"; receipt?: OmpReceipt; ompProvenance?: OmpMailProvenance; thread?: string; source?: string; sourceMessageId?: string; ownerUser?: string; metadata?: unknown; at: string; attachmentInstance?: string };
// Only a pre-submission refusal can return mail to queued. Any attempted send
// remains unknown until reconciled, even if the transport reports failure.
export class DeliveryDeferred extends Error {}
export class Mailbox {
  private rows: Record<string, Mail>;
  private queue = new SerialQueue();
  private path: string;
  constructor(dir: string, readonly name: string) {
    this.path = join(dir, `${name}.json`); this.rows = existsSync(this.path) ? readJson(this.path) : {};
    for (const row of Object.values(this.rows)) if (row.state === "sending") row.state = "unknown";
    atomicJson(this.path, this.rows);
  }
  list(): Mail[] { return Object.values(this.rows); }
  get(id: string): Mail | undefined { return this.rows[id]; }
  put(mail: Mail): Mail {
    if (this.name !== "inbox" && (mail.state === "abandoned" || mail.abandonment)) throw new Error("Abandoned input cannot be copied to another mailbox");
    const existing = this.rows[mail.id];
    if (existing) {
      if (existing.text !== mail.text || existing.target !== mail.target) throw new Error("Operation ID reused with different content");
      return existing;
    }
    const next = { ...this.rows, [mail.id]: mail };
    atomicJson(this.path, next); this.rows = next; return mail;
  }
  mark(id: string, patch: Partial<Mail>): Mail {
    if (!this.rows[id]) throw new Error("Unknown mail");
    if (this.rows[id]!.state === "abandoned") throw new Error("Abandoned mail is immutable; never replay");
    const intent = this.rows[id]!.abandonment;
    if (intent && (!patch.abandonment || patch.abandonment.operationId !== intent.operationId || patch.abandonment.evidence !== intent.evidence ||
      !((patch.state === "sent" && patch.abandonment.outcome === "received") || (patch.state === "abandoned" && patch.abandonment.outcome === "abandoned")))) {
      throw new Error("Mail abandonment intent fences mutation; never replay");
    }
    const row = { ...this.rows[id]!, ...patch, id }, next = { ...this.rows, [id]: row };
    // A failed write must not make a retry believe an assignment or receipt was
    // persisted. Publish the in-memory state only after durable replacement.
    atomicJson(this.path, next); this.rows = next; return row;
  }
  async deliver(id: string, action: (row: Mail) => Promise<{ turnId?: string }>): Promise<Mail> {
    return this.queue.run(id, async () => {
      const row = this.rows[id]; if (!row) throw new Error("Unknown mail");
      if (row.state === "sent") return row;
      if (row.state === "abandoned" || row.abandonment) throw new Error("Mail abandonment fences delivery; never replay");
      if (row.state !== "queued") throw new Error("Delivery unknown; reconcile before retry");
      this.mark(id, { state: "sending" });
      try { const result = await action(row); return this.mark(id, { state: "sent", ...result }); }
      catch (error) { this.mark(id, { state: error instanceof DeliveryDeferred ? "queued" : "unknown" }); throw error; }
    });
  }
}
export const postHook = async (box: Mailbox, run: Runner, id: string, hook: ArgvTemplate, values: Record<string, string>): Promise<void> => {
  box.put({ id, target: values.thread ?? "none", text: values.text ?? "", state: "queued", at: new Date().toISOString() });
  await box.deliver(id, async () => {
    const result = await run(fill(hook, values), { timeoutMs: 120000 });
    if (result.code !== 0) throw new Error("Hook delivery unknown");
    return {};
  });
};
