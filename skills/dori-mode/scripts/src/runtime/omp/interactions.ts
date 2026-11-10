import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicJson, SerialQueue } from "../../journal.ts";
import { readJson } from "../../ipc.ts";
import type { Mailbox } from "../../mailbox.ts";
import { statusOf, type Lane } from "../../registry.ts";
import { OmpError, assertInteractionAnswer, identityOf, payloadHash, sameIdentity, validReceipt, validInteraction, validInteractionStatus,
  type NativeUserInteraction, type NativeInteractionResponse, type NativeInteractionStatus, type OmpIdentity } from "./contract.ts";

type InteractionOwnerEvent = { id: string; thread: string; user: string; metadata?: unknown };
type Binding = { key: string; target: OmpIdentity; attachment: string; generation: number };
export type RelayedInteraction = Binding & {
  token: string; request: NativeUserInteraction; thread: string; source: string; owner: string; sourceMessageId?: string;
  state: "open" | "stale" | "applied";
};
type ResponseOperation = { id: string; token: string; response: NativeInteractionResponse; responseHash: string;
  source: string; sourceMessageId: string; owner: string; thread: string; metadata?: unknown;
  state: "sending" | "unknown" | "applied" | "stale"; outcome?: NativeInteractionStatus };
type RelayState = { version: 1; requests: Record<string, RelayedInteraction>; responses: Record<string, ResponseOperation> };
export type InteractionRelayDeps = {
  stateDir: string; inbox: Mailbox;
  ingress: { id: string; owners: string[] }[];
  lanes(): Promise<Lane[]>;
  call(lane: Lane, action: "interactions" | "interaction-respond" | "interaction-response-status", args: Record<string, unknown>): Promise<unknown>;
  post(id: string, thread: string, text: string, key: string): Promise<void>;
};

/** One durable state machine; native resolver, not the Iyen input queue, owns completion. */
export class NativeInteractionRelay {
  private readonly path: string;
  private readonly queue = new SerialQueue();
  private state: RelayState;
  private blocked: { key: string; request: NativeUserInteraction; reason: string }[] = [];
  constructor(private readonly deps: InteractionRelayDeps) {
    this.path = join(deps.stateDir, "native-interactions.json");
    this.state = existsSync(this.path) ? readJson<RelayState>(this.path) : { version: 1, requests: {}, responses: {} };
    if (this.state.version !== 1 || !this.state.requests || !this.state.responses) throw new Error("Invalid native relay journal");
    for (const row of Object.values(this.state.responses)) if (row.state === "sending") row.state = "unknown";
    atomicJson(this.path, this.state);
  }
  private save(next: RelayState): void { atomicJson(this.path, next); this.state = next; }
  private request(row: RelayedInteraction): void { this.save({ ...this.state, requests: { ...this.state.requests, [row.token]: row } }); }
  private operation(row: ResponseOperation): void { this.save({ ...this.state, responses: { ...this.state.responses, [row.id]: row } }); }
  private matches(row: Binding, lane: Lane): boolean {
    const runtime = lane.runtime;
    return runtime?.kind === "omp" && runtime.backend === "external-current-session" && !!runtime.omp && !runtime.external?.detachedAt && !runtime.omp.detachedAt && runtime.state !== "stopped" &&
      !["closed", "done-claimed", "verified-done"].includes(statusOf(lane)) && !lane.cleanupFence &&
      runtime.hostInstanceId === row.attachment && runtime.generation === row.generation && runtime.threadId === row.target.sessionId &&
      runtime.omp.attachmentInstanceId === row.attachment && runtime.omp.attachmentGeneration === row.generation && sameIdentity(runtime.omp.target, row.target);
  }
  private owner(lane: Lane, request: NativeUserInteraction): { thread: string; source: string; owner: string; sourceMessageId?: string } | undefined {
    const epoch = lane.runtime!;
    const receipts = this.deps.inbox.list().filter(mail => mail.target === lane.key && mail.state === "sent" && mail.thread && mail.thread !== "none" &&
      mail.attachmentInstance === epoch.hostInstanceId && mail.ownerUser && mail.source && this.deps.ingress.some(i => i.id === mail.source && i.owners.includes(mail.ownerUser!)) &&
      (!mail.ompProvenance || (sameIdentity(mail.ompProvenance.target, epoch.omp!.target) && mail.ompProvenance.attachmentGeneration === epoch.generation)));
    const correlated = receipts.filter(mail => (!request.sourceEntryId || mail.receipt?.entryId === request.sourceEntryId) &&
      (!request.sourceOperationHash || payloadHash(mail.id) === request.sourceOperationHash));
    const exactSource = !!request.sourceEntryId || !!request.sourceOperationHash;
    if (exactSource && !correlated.length && (lane.role === "lead" || lane.key === "lead" ||
      receipts.some(mail => mail.receipt?.entryId === request.sourceEntryId || payloadHash(mail.id) === request.sourceOperationHash))) return undefined;
    const candidates = exactSource && correlated.length ? correlated : lane.role === "lead" || lane.key === "lead" ? receipts : [];
    const owners = new Map(candidates.map(mail => [JSON.stringify([mail.thread, mail.source, mail.ownerUser]), mail]));
    if (owners.size === 1) {
      const mail = owners.values().next().value!;
      return { thread: mail.thread!, source: mail.source!, owner: mail.ownerUser!, sourceMessageId: mail.sourceMessageId };
    }
    return undefined;
  }
  private render(row: RelayedInteraction): string {
    const r = row.request, lines = [`[${row.key}] 응답이 필요합니다 (${r.kind})`, r.title];
    if (r.secret) return [...lines, "비밀 입력은 Slack으로 전달할 수 없습니다. 해당 로컬 OMP 화면에서 입력해 주세요."].join("\n");
    if (r.message) lines.push(r.message);
    for (const q of r.questions ?? []) {
      lines.push(`질문 ${q.id}${q.header ? ` (${q.header})` : ""}: ${q.question}${q.multi ? " [복수 선택 가능]" : ""}`);
      q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}${o.preview ? `\n${o.preview}` : ""}`));
    }
    for (const o of r.options ?? []) lines.push(`${o.disabled ? "[선택 불가] " : ""}${o.id}: ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    for (const t of r.tiers ?? []) lines.push(`실행 역할 ${t.role}: ${t.provider}/${t.model}${t.thinkingLevel ? ` (${t.thinkingLevel})` : ""}`);
    if (r.placeholder) lines.push(`입력 안내: ${r.placeholder}`);
    if (r.defaultValue !== undefined) lines.push(`현재 값: ${r.defaultValue} (자동 선택하지 않음)`);
    if (r.kind === "plan-review") lines.push("승인은 표시된 계획 원문에만 적용되며 이후 로컬 수정본은 포함하지 않습니다.");
    lines.push("이 스레드에 평소처럼 답해 주세요. 담당 리드가 답변을 확인하고 이 요청에 전달합니다.");
    if (r.expiresAt) lines.push(`만료: ${r.expiresAt}`);
    return lines.join("\n");
  }
  poll(): Promise<void> { return this.queue.run("relay", () => this.pollScoped()); }
  private async reconcile(lanes: Lane[]): Promise<void> {
    for (const op of Object.values(this.state.responses).filter(op => op.state === "unknown" || op.state === "sending")) {
      const row = this.state.requests[op.token], lane = row && lanes.find(l => l.key === row.key);
      if (!row || !lane || !this.matches(row, lane)) {
        // The old request is invalid, but an uncertain response may already have applied.
        // Keep that outcome unknown; never query its operation in a replacement epoch.
        if (row?.state === "open") this.request({ ...row, state: "stale" });
        continue;
      }
      try {
        const result = await this.deps.call(lane, "interaction-response-status", { operationId: op.id });
        if (!validInteractionStatus(result, op.id)) continue;
        if (result.requestId !== undefined && result.requestId !== row.request.id || result.responseHash !== undefined && result.responseHash !== op.responseHash) continue;
        if (result.status === "applied" || result.status === "stale") {
          this.operation({ ...op, state: result.status, outcome: result }); this.request({ ...row, state: result.status });
        }
        // missing/pending are unknown, never permission to retry the mutation.
      } catch { /* Same exact native epoch must become observable before reconciliation. */ }
    }
  }
  private async pollScoped(): Promise<void> {
    const lanes = await this.deps.lanes();
    await this.reconcile(lanes);
    const blocked: typeof this.blocked = [];
    for (const row of Object.values(this.state.requests)) {
      if (row.state === "open" && (row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now() ||
        !lanes.some(lane => lane.key === row.key && this.matches(row, lane)))) this.request({ ...row, state: "stale" });
    }
    for (const lane of lanes) {
      const runtime = lane.runtime;
      if (runtime?.kind !== "omp" || runtime.backend !== "external-current-session" || !runtime.omp || runtime.state === "stopped" || runtime.external?.detachedAt ||
        ["closed", "done-claimed", "verified-done"].includes(statusOf(lane)) || lane.cleanupFence) continue;
      let requests: NativeUserInteraction[];
      try {
        const result = await this.deps.call(lane, "interactions", {});
        if (!Array.isArray(result) || !result.every(r => validInteraction(r, runtime.threadId!)) || new Set(result.map(r => r.id)).size !== result.length) throw new Error("Invalid native dialogs");
        requests = result;
      } catch { continue; } // A disconnected/missing capability is not an empty list or local completion.
      for (const row of Object.values(this.state.requests)) {
        if (row.state === "open" && row.key === lane.key && this.matches(row, lane) &&
          (!requests.some(r => r.id === row.request.id) || row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now())) this.request({ ...row, state: "stale" });
      }
      for (const request of requests) {
        if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) continue;
        const binding: Binding = { key: lane.key, target: identityOf(runtime.omp.target), attachment: runtime.hostInstanceId, generation: runtime.generation };
        const token = `iyen-${payloadHash(JSON.stringify([binding, request.id])).slice(0, 32)}`;
        const prior = this.state.requests[token];
        if (prior && (prior.state !== "open" || !isDeepStrictEqual(prior.request, request))) {
          if (prior.state === "open") this.request({ ...prior, state: "stale" });
          continue;
        }
        const owner = this.owner(lane, request);
        if (!owner) {
          blocked.push({ key: lane.key, request, reason: "authenticated-owner-thread-unresolved" });
          if (prior?.state === "open") this.request({ ...prior, state: "stale" });
          continue;
        }
        const row: RelayedInteraction = prior ?? { ...binding, ...owner, token, request, state: "open" };
        if (prior && (row.thread !== owner.thread || row.source !== owner.source || row.owner !== owner.owner)) { this.request({ ...prior, state: "stale" }); continue; }
        if (!prior) this.request(row); // Persist the exact advertised owner/epoch before outbox delivery.
        await this.deps.post(`native-interaction:${token}`, row.thread, this.render(row), row.key).catch(() => {});
      }
    }
    this.blocked = blocked;
  }
  list(): RelayedInteraction[] { return Object.values(this.state.requests).filter(r => r.state === "open"); }
  unrouted(): readonly { key: string; request: NativeUserInteraction; reason: string }[] { return this.blocked; }
  responseHistory() {
    return Object.values(this.state.responses).map(operation => {
      const row = this.state.requests[operation.token];
      return { operation, binding: row ? { key: row.key, target: row.target, attachment: row.attachment, generation: row.generation } : undefined };
    });
  }
  /** The lead supplies semantics; authenticated delivered conversation supplies authority. */
  respondFromLead(token: string, response: NativeInteractionResponse, sourceMessageId: string): Promise<NativeInteractionStatus> {
    return this.queue.run("relay", async () => {
      const row = this.state.requests[token];
      if (!row || !sourceMessageId) throw new Error("Unknown native request or source message");
      assertInteractionAnswer(row.request, response);
      const lanes = await this.deps.lanes();
      const lead = lanes.find(l => l.key === "lead");
      const runtime = lead?.runtime;
      if (!lead || runtime?.kind !== "omp" || !runtime.omp || runtime.omp.target.role !== "attached-lead" || runtime.omp.target.laneKey !== "lead" ||
        !this.matches({ key: lead.key, target: runtime.omp.target, attachment: runtime.hostInstanceId, generation: runtime.generation }, lead) ||
        lead.dispatchBlocked || runtime.held || statusOf(lead) === "paused") throw new Error("Current attached lead unavailable");
      const sources = this.deps.inbox.list().filter(mail => mail.sourceMessageId === sourceMessageId &&
        mail.source === row.source && mail.thread === row.thread);
      if (sources.length !== 1) throw new Error("Native response requires one original authenticated source");
      const mail = sources[0]!;
      if (mail.target !== "lead" || mail.state !== "sent" || mail.abandonment || mail.ownerUser !== row.owner ||
        !this.deps.ingress.some(i => i.id === mail.source && i.owners.includes(mail.ownerUser!)) ||
        !Number.isFinite(Date.parse(mail.at)) || Date.parse(mail.at) < Date.parse(row.request.createdAt) ||
        mail.attachmentInstance !== runtime.hostInstanceId || mail.ompProvenance?.attachmentInstanceId !== runtime.hostInstanceId ||
        mail.ompProvenance.attachmentGeneration !== runtime.generation || !sameIdentity(mail.ompProvenance.target, runtime.omp.target) ||
        !validReceipt(mail.receipt, runtime.omp.target, mail.id, payloadHash(mail.text))) {
        throw new Error("Native response source is not current authenticated lead conversation");
      }
      const duplicate = Object.values(this.state.responses).find(op => op.source === mail.source &&
        op.sourceMessageId === sourceMessageId && op.thread === mail.thread);
      if (duplicate) {
        if (duplicate.token !== token || duplicate.owner !== mail.ownerUser || !isDeepStrictEqual(duplicate.response, response)) {
          throw new Error("Source message reused with another answer");
        }
        await this.reconcile(lanes);
        return this.state.responses[duplicate.id]!.outcome ?? {
          status: "pending", operationId: duplicate.id, requestId: row.request.id, responseHash: duplicate.responseHash,
        };
      }
      if (row.state !== "open" || row.request.secret ||
        row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now()) throw new Error("Native request is stale or local-only");
      const lane = lanes.find(l => l.key === row.key);
      if (!lane || !this.matches(row, lane)) { this.request({ ...row, state: "stale" }); throw new Error("Native request epoch expired"); }
      if (lane.dispatchBlocked || lane.runtime?.held || statusOf(lane) === "paused") throw new Error("Native response held until lane reconciliation or resume");
      const owner = this.owner(lane, row.request);
      if (!owner || owner.thread !== row.thread || owner.source !== row.source || owner.owner !== row.owner) {
        this.request({ ...row, state: "stale" }); throw new Error("Native request owner/thread binding changed");
      }
      if (Object.values(this.state.responses).some(op => op.token === token && ["sending", "unknown", "applied"].includes(op.state))) {
        throw new Error("Native response already attempted; reconcile without replay");
      }
      const sourceSnapshot = structuredClone(mail);
      const current = await this.deps.call(lane, "interactions", {});
      if (!Array.isArray(current) || !current.some(r => validInteraction(r, row.target.sessionId) && isDeepStrictEqual(r, row.request))) {
        this.request({ ...row, state: "stale" }); throw new Error("Native request completed locally or changed");
      }
      // Observation may await a resolver; re-check both epochs and source before mutation.
      const latest = await this.deps.lanes(), currentLane = latest.find(l => l.key === row.key), currentLead = latest.find(l => l.key === "lead");
      if (row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now() ||
        !currentLane || !this.matches(row, currentLane) || currentLane.dispatchBlocked || currentLane.runtime?.held || statusOf(currentLane) === "paused" ||
        !currentLead || !this.matches({ key: lead.key, target: runtime.omp.target, attachment: runtime.hostInstanceId, generation: runtime.generation }, currentLead) ||
        currentLead.dispatchBlocked || currentLead.runtime?.held || statusOf(currentLead) === "paused" ||
        !isDeepStrictEqual(this.deps.inbox.get(mail.id), sourceSnapshot)) throw new Error("Native response binding changed during observation");
      const currentOwner = this.owner(currentLane, row.request);
      if (!currentOwner || currentOwner.thread !== row.thread || currentOwner.source !== row.source || currentOwner.owner !== row.owner) {
        throw new Error("Native request owner/thread binding changed");
      }
      return this.respond(row, currentLane, response, mail.source!, {
        id: sourceMessageId, user: mail.ownerUser!, thread: mail.thread!, metadata: mail.metadata,
      });
    });
  }
  /** Operator path still requires a stable, original source-message operation identity. */
  respondOperator(token: string, response: NativeInteractionResponse, operationId: string): Promise<NativeInteractionStatus> {
    return this.queue.run("relay", async () => {
      const row = this.state.requests[token], lane = row && (await this.deps.lanes()).find(l => l.key === row.key);
      if (!operationId || !row || row.state !== "open" || !lane || !this.matches(row, lane) ||
        row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now()) throw new Error("Expired native request");
      if (lane.dispatchBlocked || lane.runtime?.held || statusOf(lane) === "paused") throw new Error("Native response held until lane reconciliation or resume");
      assertInteractionAnswer(row.request, response);
      return this.respond(row, lane, response, "operator", { id: operationId, user: row.owner, thread: row.thread });
    });
  }
  private async respond(row: RelayedInteraction, lane: Lane, response: NativeInteractionResponse, source: string, event: InteractionOwnerEvent): Promise<NativeInteractionStatus> {
    const id = `native-response:${payloadHash(JSON.stringify([source, event.thread, event.id, row.token]))}`, responseHash = payloadHash(JSON.stringify(response));
    const prior = this.state.responses[id];
    if (prior) {
      if (prior.responseHash !== responseHash) throw new Error("Response operation conflict");
      await this.reconcile(await this.deps.lanes());
      return this.state.responses[id]!.outcome ?? { status: "pending", operationId: id, requestId: row.request.id, responseHash };
    }
    if (Object.values(this.state.responses).some(op => op.token === row.token && ["sending", "unknown", "applied"].includes(op.state))) throw new Error("Native response already attempted; reconcile without replay");
    const op: ResponseOperation = { id, token: row.token, response, responseHash, source, sourceMessageId: event.id, owner: event.user, thread: event.thread,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}), state: "sending" };
    this.operation(op); // Durable before crossing the native resolver boundary.
    try {
      const result = await this.deps.call(lane, "interaction-respond", { requestId: row.request.id, response, operationId: id });
      if (!validInteractionStatus(result, id) || !["applied", "stale"].includes(result.status) || result.requestId !== row.request.id || result.responseHash !== responseHash) throw new Error("Native response receipt mismatch");
      this.operation({ ...op, state: result.status as "applied" | "stale", outcome: result }); this.request({ ...row, state: result.status as "applied" | "stale" });
      return result;
    } catch (error) {
      // Even explicit pre-submit failures are not automatically re-applied under another ID.
      this.operation({ ...op, state: "unknown" });
      await this.reconcile(await this.deps.lanes());
      const reconciled = this.state.responses[id]!;
      if (reconciled.outcome) return reconciled.outcome;
      if (error instanceof OmpError && error.code === "interaction-stale") this.request({ ...row, state: "stale" });
      return { status: "pending", operationId: id, requestId: row.request.id, responseHash };
    }
  }
}
