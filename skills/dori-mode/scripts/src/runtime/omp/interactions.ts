import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicJson, SerialQueue } from "../../journal.ts";
import { readJson } from "../../ipc.ts";
import type { Mailbox } from "../../mailbox.ts";
import { statusOf, type Lane } from "../../registry.ts";
import { OmpError, assertInteractionAnswer, identityOf, payloadHash, sameIdentity, validReceipt, validInteraction, validInteractionResponse, validInteractionStatus,
  type NativeUserInteraction, type NativeInteractionResponse, type NativeInteractionStatus, type OmpIdentity } from "./contract.ts";

export type InteractionOwnerEvent = { id: string; thread: string; user: string; text: string; metadata?: unknown };
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
    return runtime?.kind === "omp" && !!runtime.omp && !runtime.external?.detachedAt && runtime.state !== "stopped" &&
      !["closed", "done-claimed", "verified-done"].includes(statusOf(lane)) && !lane.cleanupFence &&
      runtime.hostInstanceId === row.attachment && runtime.generation === row.generation && runtime.threadId === row.target.sessionId &&
      runtime.omp.attachmentInstanceId === row.attachment && runtime.omp.attachmentGeneration === row.generation && sameIdentity(runtime.omp.target, row.target);
  }
  private owner(lane: Lane, request: NativeUserInteraction, lanes: Lane[]): { thread: string; source: string; owner: string; sourceMessageId?: string } | undefined {
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
    // Multiple current owner threads are never a fallback for an unmapped lead source.
    if (lane.key === "lead" || lane.role === "lead" || owners.size > 1 || lane.thread === "none") return undefined;
    // Shared messenger ingress may configure several owner identities. The
    // registered report thread needs its own current authenticated receipt.
    const lead = lanes.find(candidate => candidate.key === "lead" && candidate.runtime?.kind === "omp" && candidate.runtime.omp &&
      candidate.runtime.omp.attachmentInstanceId === candidate.runtime.hostInstanceId &&
      candidate.runtime.omp.attachmentGeneration === candidate.runtime.generation &&
      !candidate.runtime.external?.detachedAt && candidate.runtime.state !== "stopped" && !candidate.cleanupFence);
    const originOwners = new Map(this.deps.inbox.list().filter(mail => lead && mail.target === "lead" && mail.state === "sent" &&
      mail.thread === lane.thread && mail.attachmentInstance === lead.runtime!.hostInstanceId && mail.ownerUser && mail.source &&
      mail.ompProvenance?.attachmentInstanceId === lead.runtime!.hostInstanceId &&
      validReceipt(mail.receipt, lead.runtime!.omp!.target, mail.id, payloadHash(mail.text)) &&
      mail.ompProvenance.attachmentGeneration === lead.runtime!.generation && sameIdentity(mail.ompProvenance.target, lead.runtime!.omp!.target) &&
      this.deps.ingress.some(i => i.id === mail.source && i.owners.includes(mail.ownerUser!)))
      .map(mail => [JSON.stringify([mail.source, mail.ownerUser]), { thread: lane.thread, source: mail.source!, owner: mail.ownerUser! }]));
    if (originOwners.size === 1) return originOwners.values().next().value;
    if (originOwners.size > 1) return undefined;
    // Managed lanes may use their registered report thread, but only one ingress/owner can own it.
    const registered = this.deps.ingress.flatMap(i => i.owners.map(owner => ({ thread: lane.thread, source: i.id, owner })));
    return registered.length === 1 ? registered[0] : undefined;
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
    lines.push(`답변 토큰: ${row.token}`, `답변 ${row.token} <응답>`, `취소: 답변 ${row.token} 취소`);
    if (r.kind === "ask") {
      if (r.questions!.length === 1 && !r.questions![0]!.multi) lines.push("응답: 표시된 선택지 번호 또는 정확한 이름 (숫자는 표시 번호). 직접 입력: 직접:<원문> (콜론 뒤 공백도 보존)");
      lines.push('복수 질문/복수 선택/메모: {"kind":"submit","answers":[{"id":"질문 ID","selectedOptions":["선택지 이름"],"customInput":"직접 입력","note":"메모"}]} (질문 순서대로 모두 기입)');
    } else if (r.kind === "confirm") lines.push("응답: true 또는 false");
    else if (r.kind === "input" || r.kind === "editor") lines.push("응답: 입력할 원문 (여러 줄 가능)");
    else if (r.kind === "plan-review") lines.push('응답: 정확한 선택 ID 또는 {"kind":"submit","choice":"execute","role":"제공된 역할"}. 승인은 표시된 계획 원문에만 적용되며 이후 로컬 수정본은 포함하지 않습니다. refine은 feedback 의견 필수.');
    else lines.push("응답: 위에 제공된 정확한 선택 ID. 승인 범위는 생략하거나 확대할 수 없습니다.");
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
    for (const row of Object.values(this.state.requests)) {
      if (row.state === "open" && (row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now() ||
        !lanes.some(lane => lane.key === row.key && this.matches(row, lane)))) this.request({ ...row, state: "stale" });
    }
    for (const lane of lanes) {
      const runtime = lane.runtime;
      if (runtime?.kind !== "omp" || !runtime.omp || runtime.state === "stopped" || runtime.external?.detachedAt ||
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
        const owner = this.owner(lane, request, lanes);
        if (!owner) {
          if (prior?.state === "open") this.request({ ...prior, state: "stale" });
          continue;
        }
        const row: RelayedInteraction = prior ?? { ...binding, ...owner, token, request, state: "open" };
        if (prior && (row.thread !== owner.thread || row.source !== owner.source || row.owner !== owner.owner)) { this.request({ ...prior, state: "stale" }); continue; }
        if (!prior) this.request(row); // Persist the exact advertised owner/epoch before outbox delivery.
        await this.deps.post(`native-interaction:${token}`, row.thread, this.render(row), row.key).catch(() => {});
      }
    }
  }
  list(): RelayedInteraction[] { return Object.values(this.state.requests).filter(r => r.state === "open"); }
  private parse(request: NativeUserInteraction, text: string): NativeInteractionResponse {
    let response: unknown;
    const freeText = request.kind === "input" || request.kind === "editor";
    if (text === "취소" || text === "cancel") response = { kind: "cancel" };
    else {
      if (text.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (!freeText || parsed !== null && typeof parsed === "object" && "kind" in parsed &&
            (parsed.kind === "submit" || parsed.kind === "cancel")) response = parsed;
        } catch (error) { if (!freeText) throw error; }
      }
      if (response === undefined) {
        if (freeText) response = { kind: "submit", value: text };
        else if (request.kind === "ask" && request.questions?.length === 1 && !request.questions[0]!.multi) {
          const q = request.questions[0]!;
          const option = /^[1-9]\d*$/.test(text) ? q.options[Number(text) - 1] : q.options.find(o => o.label === text);
          response = { kind: "submit", answers: [{ id: q.id, selectedOptions: option ? [option.label] : [],
            ...(text.startsWith("직접:") ? { customInput: text.slice(3) } : {}) }] };
        } else if (request.kind === "confirm") response = { kind: "submit", value: text === "true" ? true : text === "false" ? false : undefined };
        else response = { kind: "submit", choice: text };
      }
    }
    if (!validInteractionResponse(response)) throw new Error("응답 형식이 올바르지 않습니다");
    assertInteractionAnswer(request, response); return response;
  }
  /** Returns false only for ordinary conversation; quoted tokens never authorize a response. */
  receive(source: string, event: InteractionOwnerEvent): Promise<boolean> {
    return this.queue.run("relay", async () => {
      if (!this.deps.ingress.some(i => i.id === source && i.owners.includes(event.user))) throw new Error("Untrusted native response owner");
      const explicit = /^답변[ \t]+(iyen-[a-f0-9]{32})(?:[ \t]|\n)([\s\S]*)$/.exec(event.text);
      const command = /^답변(?:\s|$)/.test(event.text.trim());
      const duplicate = Object.values(this.state.responses).find(op => op.source === source && op.sourceMessageId === event.id && op.thread === event.thread);
      if (duplicate) {
        if (duplicate.owner !== event.user) throw new Error("Native response owner mismatch");
        if (!explicit || explicit[1] !== duplicate.token || JSON.stringify(this.parse(this.state.requests[duplicate.token]!.request, explicit[2]!)) !== JSON.stringify(duplicate.response)) throw new Error("Source message reused with another answer");
        await this.reconcile(await this.deps.lanes()); return true;
      }
      const pending = this.list().filter(r => r.source === source && r.thread === event.thread && r.owner === event.user);
      // Tokens embedded in quotations/forwarded prose are data, never authority.
      const looksLikeSelection = pending.some(r => /^(yes|no|네|예|아니오|승인|true|false|\d+)$/i.test(event.text.trim()) ||
        r.request.options?.some(o => o.id === event.text.trim() || o.label === event.text.trim()) || r.request.questions?.some(q => q.options.some(o => o.label === event.text.trim())));
      if (!explicit) {
        if (command || looksLikeSelection) {
          await this.deps.post(`native-clarify:${payloadHash(JSON.stringify([source, event.thread, event.id]))}`, event.thread,
            "요청을 추측해서 처리하지 않습니다. 해당 질문에 표시된 `답변 iyen-… <응답>` 토큰과 정확한 선택/승인 범위를 사용해 주세요.", "lead").catch(() => {});
          return true;
        }
        return false;
      }
      const row = this.state.requests[explicit[1]!];
      if (!row || row.state !== "open" || row.source !== source || row.thread !== event.thread || row.owner !== event.user || row.request.secret ||
        row.request.expiresAt && Date.parse(row.request.expiresAt) <= Date.now()) throw new Error("Native request is stale, local-only or belongs to another owner/thread");
      const lanes = await this.deps.lanes(), lane = lanes.find(l => l.key === row.key);
      if (!lane || !this.matches(row, lane)) { this.request({ ...row, state: "stale" }); throw new Error("Native request epoch expired"); }
      if (lane.dispatchBlocked || lane.runtime?.held || statusOf(lane) === "paused") throw new Error("Native response held until lane reconciliation or resume");
      const owner = this.owner(lane, row.request, lanes);
      if (!owner || owner.thread !== row.thread || owner.source !== row.source || owner.owner !== row.owner) {
        this.request({ ...row, state: "stale" }); throw new Error("Native request owner/thread binding changed");
      }
      if (Object.values(this.state.responses).some(op => op.token === row.token && (op.state === "sending" || op.state === "unknown"))) throw new Error("Native response outcome unknown; status reconciliation required");
      const current = await this.deps.call(lane, "interactions", {});
      if (!Array.isArray(current) || !current.some(r => validInteraction(r, row.target.sessionId) && isDeepStrictEqual(r, row.request))) {
        this.request({ ...row, state: "stale" }); throw new Error("Native request completed locally or changed");
      }
      let response: NativeInteractionResponse;
      try { response = this.parse(row.request, explicit[2]!); }
      catch (error) {
        await this.deps.post(`native-invalid-answer:${payloadHash(JSON.stringify([source, event.thread, event.id]))}`, row.thread,
          `응답이 해당 질문의 형식 또는 제공된 선택/승인 범위와 일치하지 않습니다. 원래 질문을 확인하고 \`답변 ${row.token} <응답>\` 형식으로 다시 답해 주세요. 복수 질문은 질문 ID와 순서를 모두 포함한 JSON이 필요합니다.`, row.key).catch(() => {});
        throw error;
      }
      await this.respond(row, lane, response, source, event);
      return true;
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
      return this.respond(row, lane, response, "operator", { id: operationId, user: row.owner, thread: row.thread, text: "" });
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
