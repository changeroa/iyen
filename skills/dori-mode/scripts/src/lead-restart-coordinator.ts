import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicJson, SerialQueue } from "./journal.ts";
import { readJson } from "./ipc.ts";
import type { DoriConfig } from "./config.ts";
import { statusOf, type Lane } from "./registry.ts";
import type { Mail } from "./mailbox.ts";
import { OmpError, payloadHash, validReceipt, type OmpTarget, type OmpLaunchMetadata } from "./runtime/omp/contract.ts";
import { sameOmpTarget } from "./runtime/omp-integration.ts";

export type RestartPhase = "authorized" | "prepare-pending" | "waiting-idle" | "held" | "exit-pending" | "exited" | "start-pending" | "fresh-held" | "rotation-pending" | "rotated" | "continuation-pending" | "continuation-staged" | "release-pending" | "released" | "refused" | "rejected";
export type RestartScope = { target: OmpTarget; instance: string; generation: number };
export type RestartAuthorization = { source: string; sourceMessageId: string; owner: string; thread: string; mail: Mail; scope: RestartScope };
export type RestartRecord = {
  version: 1; operationId: string; authorizationHash: string; authorization: RestartAuthorization;
  phase: RestartPhase; createdAt: string; updatedAt: string; config: DoriConfig; launchMetadata: OmpLaunchMetadata;
  before: Lane; launch: { instance: string; generation: number; token: string; bridge: string; bootstrapFile: string };
  process?: { pid: number; startedAt: string }; freshTarget?: OmpTarget; freshFence?: number;
  continuation?: { operationId: string; text: string }; problem?: "observation-unavailable";
};
type RestartState = { version: 1; active?: string; operations: Record<string, RestartRecord> };
export type RestartObservation = "waiting-idle" | "held" | "exit-requested" | "released";
export type RestartStatus = {
  schemaVersion: number; operationId: string; phase: RestartPhase | "missing"; authorizationHash?: string;
  sourceMessageId?: string; source?: string; owner?: string; thread?: string; sessionId?: string; sessionFile?: string; pane?: string; terminalId?: string;
  previousNative?: { instanceId: string; generation: number }; native?: { instanceId: string; generation: number };
  attachment?: { instance: string; generation: number }; bridge?: string; createdAt?: string; updatedAt?: string;
  problem?: "observation-unavailable"; uncertain?: boolean; active?: boolean;
};
export type RestartDeps = {
  reject(record: RestartRecord): Promise<void>;
  assertScope(record: RestartRecord): Promise<void>;
  prepare(record: RestartRecord): Promise<RestartObservation>;
  inspect(record: RestartRecord, fresh: boolean): Promise<RestartObservation>;
  commit(record: RestartRecord): Promise<void>;
  exited(record: RestartRecord): Promise<boolean>;
  start(record: RestartRecord): Promise<void>;
  discover(record: RestartRecord): Promise<OmpTarget | undefined>;
  attest(record: RestartRecord): Promise<number>;
  rotate(record: RestartRecord): Promise<void>;
  stage(record: RestartRecord): Promise<void>;
  staged(record: RestartRecord): Promise<boolean>;
  release(record: RestartRecord): Promise<void>;
  finish(record: RestartRecord): Promise<void>;
};

/** Authority is an authenticated delivered owner message, never text supplied by the CLI. */
export function restartAuthorization(config: DoriConfig, lane: Lane, sources: Mail[], sourceMessageId: string, now = Date.now()): RestartAuthorization {
  const runtime = lane.runtime, epoch = runtime?.omp, target = epoch?.target;
  if (lane.key !== "lead" || runtime?.kind !== "omp" || runtime.backend !== "external-current-session" || !epoch || !target ||
    target.role !== "attached-lead" || target.laneKey !== "lead" || runtime.threadId !== target.sessionId || lane.pane !== target.paneId || lane.cwd !== target.cwd ||
    runtime.hostInstanceId !== epoch.attachmentInstanceId || runtime.generation !== epoch.attachmentGeneration || runtime.external?.detachedAt || epoch.detachedAt ||
    lane.dispatchBlocked || runtime.held || lane.cleanupFence || statusOf(lane) !== "working" || !["idle", "running"].includes(runtime.state)) throw new Error("Restart requires an available exact attached native lead epoch");
  const matches = sources.filter(mail => mail.sourceMessageId === sourceMessageId);
  if (matches.length !== 1) throw new Error("Restart requires one original authenticated owner source");
  const mail = matches[0]!;
  const timestamp = Date.parse(mail.at), attachedAt = Date.parse(epoch.attachedAt);
  if (mail.target !== "lead" || mail.state !== "sent" || mail.abandonment || !mail.source || !mail.ownerUser || !mail.thread || mail.thread === "none" ||
    !config.ingress.some(i => i.id === mail.source && i.owners.includes(mail.ownerUser!)) ||
    !Number.isFinite(timestamp) || !Number.isFinite(attachedAt) || timestamp < attachedAt || timestamp > now ||
    mail.attachmentInstance !== runtime.hostInstanceId || mail.ompProvenance?.attachmentInstanceId !== runtime.hostInstanceId ||
    mail.ompProvenance.attachmentGeneration !== runtime.generation || !sameOmpTarget(mail.ompProvenance.target, target) ||
    epoch.excludedInboxIds.includes(mail.id) || !validReceipt(mail.receipt, target, mail.id, payloadHash(mail.text))) throw new Error("Restart source owner/thread/receipt/epoch mismatch");
  if (sources.some(row => row.target === "lead" && row.attachmentInstance === runtime.hostInstanceId && ["sending", "unknown"].includes(row.state))) throw new Error("Unresolved lead input fences restart");
  return { source: mail.source, sourceMessageId, owner: mail.ownerUser, thread: mail.thread, mail: structuredClone(mail),
    scope: { target: structuredClone(target), instance: runtime.hostInstanceId, generation: runtime.generation } };
}

/** A single durable store also owns source consumption and the active-operation fence. */
export class LeadRestartCoordinator {
  private readonly path: string;
  private readonly queue = new SerialQueue();
  private state: RestartState;
  private persistenceUnknown = false;
  constructor(stateDir: string, private readonly deps: RestartDeps) {
    this.path = join(stateDir, "attachments", "lead-restarts.json");
    this.state = existsSync(this.path) ? readJson<RestartState>(this.path) : { version: 1, operations: {} };
    if (this.state.version !== 1 || !this.state.operations || this.state.active && !Object.hasOwn(this.state.operations, this.state.active)) throw new Error("Invalid durable restart state");
  }
  active(): RestartRecord | undefined { const row = this.state.active && this.state.operations[this.state.active]; return row ? structuredClone(row) : undefined; }
  hasActive(): boolean { return this.state.active !== undefined; }
  intakeInstance(instance: string): string {
    const refused = Object.values(this.state.operations).find(row => ["refused", "rejected"].includes(row.phase) && row.launch.instance === instance);
    return refused?.authorization.scope.instance ?? instance;
  }
  get(id: string): RestartRecord | undefined { return Object.hasOwn(this.state.operations, id) ? structuredClone(this.state.operations[id]) : undefined; }
  status(id: string): RestartStatus {
    const r = this.get(id);
    if (!r) return { schemaVersion: 1, operationId: id, phase: "missing" as const };
    const target = r.freshTarget ?? r.authorization.scope.target;
    return { schemaVersion: 1, operationId: r.operationId, phase: r.phase, authorizationHash: r.authorizationHash,
      sourceMessageId: r.authorization.sourceMessageId, source: r.authorization.source, owner: r.authorization.owner, thread: r.authorization.thread,
      sessionId: target.sessionId, sessionFile: target.sessionFile, pane: target.paneId, terminalId: target.terminalId,
      previousNative: { instanceId: r.authorization.scope.target.instanceId, generation: r.authorization.scope.target.generation },
      native: { instanceId: target.instanceId, generation: target.generation },
      attachment: { instance: r.phase === "released" || ["rotated", "continuation-pending", "continuation-staged", "release-pending"].includes(r.phase) ? r.launch.instance : r.authorization.scope.instance,
        generation: r.phase === "released" || ["rotated", "continuation-pending", "continuation-staged", "release-pending"].includes(r.phase) ? r.launch.generation : r.authorization.scope.generation },
      bridge: r.freshTarget ? r.launch.bridge : undefined, createdAt: r.createdAt, updatedAt: r.updatedAt, problem: r.problem,
      uncertain: r.phase.endsWith("-pending"), active: this.state.active === id };
  }
  private save(row: RestartRecord, phase = row.phase, patch: Partial<RestartRecord> = {}): RestartRecord {
    const next = { ...row, ...patch, phase, updatedAt: new Date().toISOString() };
    const state: RestartState = { version: 1, active: phase === "released" || phase === "rejected" ? undefined : next.operationId,
      operations: { ...this.state.operations, [next.operationId]: next } };
    if (this.persistenceUnknown) throw new Error("Restart persistence outcome unknown; service reconstruction required");
    try { atomicJson(this.path, state); }
    catch (error) { this.persistenceUnknown = true; throw error; }
    this.state = state; return next;
  }
  accept(record: RestartRecord): Promise<RestartStatus> {
    return this.queue.run("restart", async () => {
      if (this.persistenceUnknown) throw new Error("Restart persistence outcome unknown; service reconstruction required");
      if (!record.operationId.trim() || record.operationId.length > 200) throw new Error("Stable bounded restart operationId required");
      const prior = this.get(record.operationId);
      if (prior) {
        if (!isDeepStrictEqual(prior.authorization, record.authorization)) throw new Error("Restart operationId reused with changed authorization");
        return this.status(prior.operationId);
      }
      if (this.state.active) throw new Error("Another lead restart is active");
      if (Object.values(this.state.operations).some(op => op.phase !== "rejected" && op.authorization.source === record.authorization.source && op.authorization.thread === record.authorization.thread && op.authorization.sourceMessageId === record.authorization.sourceMessageId)) throw new Error("Owner source already consumed by another restart");
      if (record.authorizationHash !== payloadHash(JSON.stringify({ authorization: record.authorization, launchMetadata: record.launchMetadata })) || record.phase !== "authorized") throw new Error("Invalid restart authorization digest");
      await this.deps.assertScope(record);
      this.save(record); return this.status(record.operationId);
    });
  }
  /** CLI retries/status only observe. Only the service monitor advances new effects. */
  reconcile(id: string): Promise<RestartStatus> {
    return this.queue.run("restart", async () => {
      if (this.persistenceUnknown) throw new Error("Restart persistence outcome unknown; service reconstruction required");
      const row = this.get(id); if (!row || row.phase === "released" || row.phase === "rejected") return this.status(id);
      try { await this.deps.assertScope(row); await this.observe(row); }
      catch { if (!this.persistenceUnknown) this.save(this.get(id)!, undefined, { problem: "observation-unavailable" }); }
      return this.status(id);
    });
  }
  private async observe(row: RestartRecord): Promise<void> {
    if (["prepare-pending", "waiting-idle"].includes(row.phase)) {
      const native = await this.deps.inspect(row, false);
      if (native === "held") this.save(row, "held", { problem: undefined });
      else if (native === "waiting-idle") this.save(row, "waiting-idle", { problem: undefined });
    } else if (row.phase === "exit-pending") {
      if (await this.deps.exited(row)) this.save(row, "exited", { problem: undefined });
    } else if (row.phase === "start-pending") {
      const freshTarget = await this.deps.discover(row);
      if (freshTarget) {
        const fresh = { ...row, freshTarget }; const freshFence = await this.deps.attest(fresh);
        this.save(row, "fresh-held", { freshTarget, freshFence, problem: undefined });
      }
    } else if (row.phase === "continuation-pending") {
      if (await this.deps.staged(row)) this.save(row, "continuation-staged", { problem: undefined });
    } else if (row.phase === "release-pending") {
      if (await this.deps.inspect(row, true) === "released") {
        await this.deps.finish(row); this.save(row, "released", { problem: undefined });
      }
    }
  }
  tick(): Promise<void> {
    return this.queue.run("restart", async () => {
      if (this.persistenceUnknown) return;
      let row = this.active(); if (!row) return;
      try {
        await this.deps.assertScope(row);
        if (row.phase.endsWith("-pending") && row.phase !== "rotation-pending" || row.phase === "waiting-idle") { await this.observe(row); return; }
        switch (row.phase) {
          case "refused": await this.deps.reject(row); this.save(row, "rejected"); break;
          case "authorized":
            row = this.save(row, "prepare-pending");
            try { const result = await this.deps.prepare(row); if (result === "held" || result === "waiting-idle") this.save(row, result); }
            catch (error) {
              if (error instanceof OmpError && error.attempted === false) {
                row = this.save(row, "refused"); await this.deps.reject(row); this.save(row, "rejected");
              } else throw error;
            }
            break;
          case "held":
            if (await this.deps.inspect(row, false) !== "held") throw new Error("Exact native idle latch lost");
            row = this.save(row, "exit-pending"); await this.deps.commit(row); break;
          case "exited":
            if (!await this.deps.exited(row)) throw new Error("Old process exit/detachment no longer proven");
            row = this.save(row, "start-pending"); await this.deps.start(row); break;
          case "fresh-held": row = this.save(row, "rotation-pending");
            // Local durable rotation is explicitly replayable against two pinned epochs.
            await this.deps.attest(row); await this.deps.rotate(row); this.save(row, "rotated"); break;
          case "rotation-pending":
            await this.deps.attest(row); await this.deps.rotate(row); this.save(row, "rotated"); break;
          case "rotated":
            await this.deps.attest(row);
            row = this.save(row, "continuation-pending"); await this.deps.stage(row); break;
          case "continuation-staged":
            await this.deps.attest(row);
            row = this.save(row, "release-pending"); await this.deps.release(row); break;
        }
      } catch { const current = this.active(); if (current && !this.persistenceUnknown) this.save(current, undefined, { problem: "observation-unavailable" }); }
    });
  }
}
