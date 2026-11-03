import { isDeepStrictEqual } from "node:util";
import { withBindingFence } from "./binding-fence.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Mail, Mailbox } from "./mailbox.ts";
import { statusOf, type Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { callOmp, sameOmpTarget } from "./runtime/omp-integration.ts";
import { payloadHash, validReceipt, type OmpReceipt } from "./runtime/omp/contract.ts";

/** Caller owns the lane launch/dispatch queues and supplies current lead/admin scope validation. */
export const abandonManagedInput = async (
  deps: FlowDeps & { inbox: Mailbox; assertScope: () => Promise<void> },
  args: { id: string; operationId: string; evidence: string },
): Promise<Mail> => {
  if (![args.id, args.operationId, args.evidence].every(value => typeof value === "string" && value.trim())) throw new Error("Mail ID, stable operation ID and explicit evidence required");
  if (deps.inbox.name !== "inbox") throw new Error("Only managed inbox input can be abandoned");
  return withBindingFence(deps.config.stateDir, async () => {
    await deps.assertScope();
    let row = deps.inbox.get(args.id);
    if (!row) throw new Error("Unknown mail");
    if (deps.inbox.list().some(other => other.id !== row!.id && other.abandonment?.operationId === args.operationId)) throw new Error("Abandonment operation ID reused with different input");
    let intent = row.abandonment;
    const resumedIntent = !!intent;
    if (intent && (intent.operationId !== args.operationId || intent.evidence !== args.evidence)) throw new Error("Abandonment operation conflicts with original intent");
    if (intent && intent.outcome !== "pending") {
      // Completed retries return the original durable result, even after recovery.
      const { abandonment: _, ...original } = row;
      const expected = intent.outcome === "abandoned" ? { ...intent.original, state: "abandoned" } : {
        ...intent.original, state: "sent", turnId: row.receipt?.receiptId, receiptKind: "omp-session-entry", receipt: row.receipt,
      };
      if (!isDeepStrictEqual(original, expected) || intent.outcome === "received" && !validReceipt(row.receipt, intent.epoch.target, row.id, payloadHash(row.text))) throw new Error("Completed abandonment row changed");
      return row;
    }
    const lane = await deps.registry.read(row.target);
    const managed = (current: Lane | null): Lane => {
      const runtime = current?.runtime;
      if (!current || current.key === "lead" || current.role === "lead" || runtime?.kind !== "omp" || runtime.backend !== "herdr-tui" || !runtime.omp || runtime.external || runtime.omp.detachedAt || current.cleanupFence || statusOf(current) === "closed") throw new Error("Abandonment requires the exact managed OMP worker");
      if (runtime.omp.target.role !== "managed-lane" || runtime.omp.target.laneKey !== current.key || runtime.threadId !== runtime.omp.target.sessionId) throw new Error("Managed OMP target mismatch");
      return current;
    };
    managed(lane);
    if (!intent) {
      if (row.state !== "queued" && row.state !== "unknown") throw new Error("Only queued or unknown input can be abandoned");
      if (row.state === "queued" && (row.turnId || row.receipt || row.receiptKind)) throw new Error("Queued input has delivery evidence; reconcile instead");
      const runtime = lane!.runtime!;
      if (row.state === "unknown") {
        const provenance = row.ompProvenance;
        if (!provenance || row.attachmentInstance !== provenance.attachmentInstanceId || !Number.isSafeInteger(provenance.attachmentGeneration) || provenance.attachmentGeneration < 1 || !sameOmpTarget(provenance.target, runtime.omp!.target)) throw new Error("Original exact native operation provenance required");
      }
      intent = {
        operationId: args.operationId, evidence: args.evidence, at: iso(deps.clock),
        original: structuredClone(row),
        epoch: { hostInstanceId: runtime.hostInstanceId, generation: runtime.generation, target: structuredClone(runtime.omp!.target) },
        outcome: "pending", delivery: row.state === "queued" ? "not-attempted" : "unknown",
      };
    }
    const capturedIntent = intent;
    const assertCurrent = async (stopped = false): Promise<void> => {
      await deps.assertScope();
      const current = managed(await deps.registry.read(row!.target)), runtime = current.runtime!;
      if (runtime.hostInstanceId !== capturedIntent.epoch.hostInstanceId || runtime.generation !== capturedIntent.epoch.generation || !sameOmpTarget(runtime.omp!.target, capturedIntent.epoch.target)) throw new Error("Managed OMP epoch changed during abandonment");
      if (stopped && runtime.state !== "stopped") throw new Error("Managed OMP process stop not durably confirmed");
      if (!isDeepStrictEqual(deps.inbox.get(row!.id), row)) throw new Error("Mail changed during abandonment");
      const { abandonment: _, ...original } = row!;
      if (!isDeepStrictEqual(original, capturedIntent.original)) throw new Error("Original input changed after abandonment intent");
    };
    await assertCurrent();
    if (!row.abandonment) row = deps.inbox.mark(row.id, { abandonment: capturedIntent });
    // Durable intent fences even queued input from delivery, including after restart.
    if (capturedIntent.delivery === "not-attempted") {
      await assertCurrent();
      return deps.inbox.mark(row.id, { state: "abandoned", abandonment: { ...capturedIntent, outcome: "abandoned", completedAt: iso(deps.clock) } });
    }
    let operation: unknown;
    if (capturedIntent.original.receipt) {
      if (!validReceipt(capturedIntent.original.receipt, capturedIntent.epoch.target, row.id, payloadHash(capturedIntent.original.text))) throw new Error("Invalid saved native receipt");
      operation = { status: "received", receipt: capturedIntent.original.receipt };
    } else {
      try {
        operation = await callOmp(capturedIntent.original.ompProvenance!.target, "operation", { operationId: row.id, text: capturedIntent.original.text }, deps.config, deps.run);
      } catch {
        // An unreachable original controller is not absence or failure evidence.
        // Only the existing exact-process stop guarantee permits retiring uncertainty.
      }
    }
    let received: OmpReceipt | undefined;
    if (operation && typeof operation === "object" && "status" in operation && operation.status === "received") {
      if (!("receipt" in operation) || !validReceipt(operation.receipt, capturedIntent.epoch.target, row.id, payloadHash(capturedIntent.original.text))) throw new Error("Invalid original native receipt");
      received = operation.receipt;
    }
    await assertCurrent();
    if (received) return deps.inbox.mark(row.id, {
      state: "sent", turnId: received.receiptId, receiptKind: "omp-session-entry", receipt: received,
      abandonment: { ...capturedIntent, outcome: "received", completedAt: iso(deps.clock) },
    });
    // Never hold/release/input, discover another controller, or infer exit from idle.
    // RuntimeControl.stop proves native PID exit AND Herdr detach, or throws.
    if (!resumedIntent) await deps.runtime.stop(row.target);
    // A persisted pending intent may already have requested native shutdown.
    // Only the same epoch's durable exit proof can finish it; never resend stop.
    else if ((await deps.registry.read(row.target))?.runtime?.state !== "stopped") throw new Error("Original stop outcome unconfirmed; reconcile exact-process exit without resubmitting stop");
    await assertCurrent(true);
    return deps.inbox.mark(row.id, {
      state: "abandoned", abandonment: { ...capturedIntent, outcome: "abandoned", completedAt: iso(deps.clock), processStoppedAt: iso(deps.clock) },
    });
  });
};
