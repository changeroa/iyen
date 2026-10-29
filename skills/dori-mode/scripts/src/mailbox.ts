import { join } from "node:path";
import { existsSync } from "node:fs";
import { atomicJson, SerialQueue } from "./journal.ts";
import { readJson } from "./ipc.ts";
import { fill, type ArgvTemplate } from "./config.ts";
import type { Runner } from "./run.ts";
export type Mail = { id: string; target: string; text: string; state: "queued" | "sending" | "sent" | "unknown"; turnId?: string; thread?: string; source?: string; at: string; attachmentInstance?: string };
// Only a pre-submission refusal can return mail to queued. Any attempted send
// remains unknown until reconciled, even if the transport reports failure.
export class DeliveryDeferred extends Error {}
export class Mailbox {
  private rows: Record<string, Mail>;
  private queue = new SerialQueue();
  private path: string;
  constructor(dir: string, name: string) {
    this.path = join(dir, `${name}.json`); this.rows = existsSync(this.path) ? readJson(this.path) : {};
    for (const row of Object.values(this.rows)) if (row.state === "sending") row.state = "unknown";
    atomicJson(this.path, this.rows);
  }
  list(): Mail[] { return Object.values(this.rows); }
  get(id: string): Mail | undefined { return this.rows[id]; }
  put(mail: Mail): Mail {
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
    const row = { ...this.rows[id]!, ...patch, id }, next = { ...this.rows, [id]: row };
    // A failed write must not make a retry believe an assignment or receipt was
    // persisted. Publish the in-memory state only after durable replacement.
    atomicJson(this.path, next); this.rows = next; return row;
  }
  async deliver(id: string, action: (row: Mail) => Promise<{ turnId?: string }>): Promise<Mail> {
    return this.queue.run(id, async () => {
      const row = this.rows[id]; if (!row) throw new Error("Unknown mail");
      if (row.state === "sent") return row;
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
