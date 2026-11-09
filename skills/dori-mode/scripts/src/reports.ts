import type { Registry } from "./registry.ts";
import type { Mail } from "./mailbox.ts";
import { requiredText } from "./records.ts";
export const reportKinds = ["milestone", "blocker", "question", "halted", "done"] as const;
export type WorkerReport = { key: string; kind: typeof reportKinds[number]; text: string; eventId: string };
/** Durable lead delivery, deliberately separate from owner-facing replies. */
export const recordReport = async (registry: Registry, putInbox: (mail: Mail) => Mail, args: WorkerReport): Promise<void> => {
  if (!reportKinds.includes(args.kind)) throw new Error("Invalid report kind");
  requiredText(args.text, "text"); requiredText(args.eventId, "eventId");
  await registry.read(args.key).then(lane => { if (!lane) throw new Error("Unknown lane"); });
  const row = putInbox({ id: `report:${args.key}:${args.eventId}`, target: "lead", text: `[REPORT] ${args.key} | ${args.kind} | ${args.text}`, metadata: { type: "worker-report", ...args }, state: "queued", at: new Date().toISOString() });
  await registry.update(args.key, lane => {
    // A replay of an older event must not regress the latest report projection.
    if (lane.report && lane.report.at > Date.parse(row.at)) return lane;
    return { ...lane, report: { id: args.eventId, kind: args.kind, text: args.text, at: Date.parse(row.at) } };
  });
};
