import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { DoriService } from "../src/service.ts";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { OmpControlServer, type OmpContext } from "../src/runtime/omp/server.ts";
import { assertInteractionAnswer, payloadHash, type NativeInteractionReceipt, type NativeInteractionResponse, type NativeUserInteraction } from "../src/runtime/omp/contract.ts";
import { ompSnapshot } from "../src/runtime/omp-integration.ts";
import { ompFixture } from "./fixtures/omp.ts";
import type { Runner } from "../src/run.ts";

const thread = "slack:C-owner/100.000";
async function fixture() {
  const f = ompFixture(); f.transcript([]);
  Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity);
  let dialogs: NativeUserInteraction[] = [], sends = 0, attempts = 0, loseAck = false, unknown = false;
  let leafId: string | null = null;
  const applied = new Map<string, NativeInteractionReceipt>(), results = new Map<string, NativeInteractionResponse>();
  const ctx: OmpContext = {
    mode: "tui", agent: { kind: "main" }, cwd: f.directory, model: { id: "test", provider: "fixture" },
    sessionManager: { getSessionId: () => f.identity.sessionId, getSessionFile: () => f.identity.sessionFile, getLeafId: () => leafId, ensureOnDisk: async () => {} },
    isIdle: () => true, hasPendingMessages: () => false, getPendingPlanReview: () => undefined, getAsyncJobSnapshot: () => null,
    abort: () => { throw new Error("Remote answer must not abort the native ask"); }, shutdown: () => { throw new Error("Unexpected native shutdown"); },
    userInteractions: {
      list: () => dialogs,
      responseStatus: operationId => applied.get(operationId) ?? { status: "missing", operationId },
      respond: async (requestId, response, operationId) => {
        attempts++;
        if (unknown) throw new Error("Native delivery outcome unavailable");
        const prior = applied.get(operationId);
        if (prior) { if (prior.responseHash !== payloadHash(JSON.stringify(response))) throw new Error("Conflicting native operation"); return prior; }
        const dialog = dialogs.find(r => r.id === requestId);
        if (dialog) { assertInteractionAnswer(dialog, response); results.set(requestId, response); dialogs = dialogs.filter(r => r.id !== requestId); }
        const receipt: NativeInteractionReceipt = { status: dialog ? "applied" : "stale", requestId, operationId, responseHash: payloadHash(JSON.stringify(response)) };
        applied.set(operationId, receipt);
        if (loseAck) throw new Error("Lost native ACK after apply");
        return receipt;
      },
    },
  };
  const server = new OmpControlServer(f.target, "fixture-bearer", join(f.directory, "native"), () => ctx,
    { getThinkingLevel: () => "medium", sendUserMessage: text => {
      sends++; leafId = `ordinary-${sends}`;
      f.transcript([{ type: "message", id: leafId, parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } }]);
    } });
  await server.listen();
  const notifications: { thread: string; text: string }[] = [];
  const runner: Runner = async argv => {
    if (argv[0] === "fixture-reply") { notifications.push({ thread: argv[1]!, text: argv[2]! }); return { code: 0, out: "", err: "" }; }
    if (argv.join(" ") !== "herdr agent list") throw new Error(`Unexpected command ${argv[0]}`);
    return { code: 0, err: "", out: JSON.stringify({ result: { agents: [{ agent: "omp", cwd: f.directory, pane_id: f.identity.paneId, terminal_id: f.identity.terminalId,
      agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: f.identity.sessionFile } }] } }) };
  };
  const defaults = defaultConfig(f.directory);
  const config: DoriConfig = { ...defaults, stateDir: join(f.directory, "state"), ingress: [{ id: "owner-slack", command: ["fixture-ingress"], owners: ["owner"] }],
    hooks: { threadReply: ["fixture-reply", "{thread}", "{text}"] }, runtime: { ...defaults.runtime, kind: "omp", binary: "/fixture/omp", requiredVersion: "18.15.0", rpcTimeoutMs: 200,
      settingsHome: join(f.directory, "profile"), sandbox: "danger-full-access", omp: { registryDir: f.directory, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "always-ask" } } };
  let service = new DoriService(config, runner);
  const key = "lead";
  atomicJson(join(f.directory, `${createHash("sha256").update("instance:1").digest("hex")}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
  await service.handle("lead-activate", { threadId: f.identity.sessionId, sessionFile: f.identity.sessionFile, pane: f.identity.paneId, terminalId: f.identity.terminalId, cwd: f.directory }, { role: "admin" });
  const lane = (await service.registry.read(key))!;
  function source(id: string, ownerThread = thread, user = "owner") {
    const operationId = `inbound:owner-slack:${ownerThread}:${id}`;
    service.inbox.put({ id: operationId, target: key, text: "original owner task", source: "owner-slack", sourceMessageId: id, ownerUser: user, metadata: { channel: "C-owner", ts: id },
      thread: ownerThread, state: "sent", at: "2026-11-01T00:00:00.000Z", attachmentInstance: lane.runtime!.hostInstanceId,
      ompProvenance: { target: f.target, attachmentInstanceId: lane.runtime!.hostInstanceId, attachmentGeneration: lane.runtime!.generation },
      receipt: { operationId, payloadHash: payloadHash("original owner task"), sessionId: f.identity.sessionId, sessionFile: f.identity.sessionFile, entryId: `entry-${id}`, receiptId: `omp-entry:${f.identity.sessionId}:entry-${id}` } });
    return { sourceEntryId: `entry-${id}`, sourceOperationHash: payloadHash(operationId) };
  }
  const origin = source("source-1");
  function ask(id = "ask-1", patch: Partial<NativeUserInteraction> = {}): NativeUserInteraction {
    return { id, sessionId: f.identity.sessionId, kind: "ask", title: "어떤 방식을 사용할까요?", questions: [{ id: "strategy", question: "구현 방식을 선택해 주세요", options: [{ label: "단순 구현", description: "유지보수 우선" }, { label: "직접 지정" }] }],
      createdAt: "2026-11-01T00:00:00.000Z", ...origin, ...patch };
  }
  async function publish(rows: NativeUserInteraction[]) { dialogs = rows; await service.nativeInteractions.poll(); return service.nativeInteractions.list(); }
  async function conversation(id = "reply-1", text = "1", patch: Record<string, unknown> = {}) {
    const lead = (await service.registry.read("lead"))!, runtime = lead.runtime!, target = runtime.omp!.target;
    const operationId = `inbound:owner-slack:${thread}:${id}`;
    return service.inbox.put({ id: operationId, target: "lead", state: "sent", text, source: "owner-slack",
      sourceMessageId: id, ownerUser: "owner", thread, at: "2026-11-01T00:00:01.000Z", metadata: { ts: id, channel: "C-owner" },
      attachmentInstance: runtime.hostInstanceId,
      ompProvenance: { target, attachmentInstanceId: runtime.hostInstanceId, attachmentGeneration: runtime.generation },
      receipt: { operationId, payloadHash: payloadHash(text), sessionId: target.sessionId, sessionFile: target.sessionFile,
        entryId: `reply-entry-${id}`, receiptId: `omp-entry:${target.sessionId}:reply-entry-${id}` }, ...patch });
  }
  async function answer(token: string, response: NativeInteractionResponse = selection, id = "reply-1") {
    await conversation(id);
    return service.nativeInteractions.respondFromLead(token, response, id);
  }
  return { f, ctx, server, config, notifications, results, applied, source, conversation, ask, publish, answer, lane, key,
    service: () => service, attempts: () => attempts, sends: () => sends,
    setDialogs: (rows: NativeUserInteraction[]) => { dialogs = rows; }, loseAck: () => { loseAck = true; }, unknown: () => { unknown = true; },
    restart: () => { service = new DoriService(config, runner); },
    cleanup: () => { server.close(); f.cleanup(); } };
}

const selection: NativeInteractionResponse = { kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] };

test("lead resolves the original ask with immutable owner metadata and status-only retries", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    expect(row!.sourceMessageId).toBe("source-1");
    await h.conversation("natural", "응, 단순 구현으로 해줘");
    const first = await h.service().nativeInteractions.respondFromLead(row!.token, selection, "natural");
    expect(first.status).toBe("applied");
    expect(await h.service().nativeInteractions.respondFromLead(row!.token, selection, "natural")).toEqual(first);
    h.restart();
    expect(await h.service().nativeInteractions.respondFromLead(row!.token, selection, "natural")).toEqual(first);
    expect(h.attempts()).toBe(1); expect(h.sends()).toBe(0);
    expect(h.service().nativeInteractions.responseHistory().map(row => row.operation)).toEqual([expect.objectContaining({
      sourceMessageId: "natural", owner: "owner", thread, metadata: { ts: "natural", channel: "C-owner" }, state: "applied",
    })]);
    expect(h.service().inbox.list().find(m => m.sourceMessageId === "natural")).toMatchObject({ target: "lead", state: "sent" });
  } finally { h.cleanup(); }
});

test("one source cannot change its answer or independently resolve a second native request", async () => {
  const h = await fixture();
  try {
    const rows = await h.publish([h.ask("first"), h.ask("second")]);
    await h.answer(rows[0]!.token);
    await expect(h.answer(rows[0]!.token, { kind: "cancel" })).rejects.toThrow("another answer");
    await expect(h.answer(rows[1]!.token)).rejects.toThrow("another answer");
    expect(h.results.has("second")).toBe(false); expect(h.attempts()).toBe(1);
  } finally { h.cleanup(); }
});

test("lead mediates native resolver without a new prompt", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    await h.answer(row!.token);
    expect(h.results.get("ask-1")).toEqual(selection); expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});


test("an ordered multi-question ask permits empty multi-selection and explicit custom-only answers", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("multi", { questions: [
      { id: "features", question: "기능", multi: true, options: [{ label: "A" }, { label: "B" }] },
      { id: "empty", question: "없음", multi: true, options: [] },
      { id: "details", question: "상세", options: [] },
    ] })]);
    const response: NativeInteractionResponse = { kind: "submit", answers: [
      { id: "features", selectedOptions: ["B", "A"], note: "순서 유지" }, { id: "empty", selectedOptions: [] },
      { id: "details", selectedOptions: [], customInput: " \n 원문 \n" },
    ] };
    expect((await h.answer(row!.token, response)).status).toBe("applied");
  } finally { h.cleanup(); }
});

test("ask rejects missing, reordered, unknown, duplicated and contradictory choices before submission", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("boundaries", { questions: [
      { id: "single", question: "하나", options: [{ label: "A" }, { label: "B" }] },
      { id: "multi", question: "여러", multi: true, options: [{ label: "C" }] },
    ] })]);
    const invalid = [
      [{ id: "single", selectedOptions: ["A"] }],
      [{ id: "multi", selectedOptions: ["C"] }, { id: "single", selectedOptions: ["A"] }],
      [{ id: "single", selectedOptions: ["A", "B"] }, { id: "multi", selectedOptions: ["C"] }],
      [{ id: "single", selectedOptions: ["unknown"] }, { id: "multi", selectedOptions: ["C"] }],
      [{ id: "single", selectedOptions: ["A"] }, { id: "multi", selectedOptions: ["C", "C"] }],
      [{ id: "single", selectedOptions: ["A"], customInput: "also" }, { id: "multi", selectedOptions: [] }],
    ];
    for (const [i, answers] of invalid.entries()) {
      await expect(h.answer(row!.token, { kind: "submit", answers }, `invalid-${i}`)).rejects.toThrow();
    }
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("approval and plan review reject widened, disabled, missing-tier and missing-feedback answers", async () => {
  const h = await fixture();
  try {
    const [approval] = await h.publish([h.ask("approval", { kind: "approval", questions: undefined,
      options: [{ id: "grant:workspace:once", label: "이번만" }, { id: "session", label: "세션", disabled: true }] })]);
    for (const choice of ["yes", "grant:workspace:always", "session"]) {
      await expect(h.answer(approval!.token, { kind: "submit", choice }, choice)).rejects.toThrow();
    }
    const [plan] = await h.publish([h.ask("plan", { kind: "plan-review", questions: undefined, message: "원본 계획",
      options: [{ id: "execute", label: "실행" }, { id: "refine", label: "수정" }],
      tiers: [{ role: "builder", provider: "openai", model: "gpt-6.1-sol" }] })]);
    await expect(h.answer(plan!.token, { kind: "submit", choice: "execute" }, "no-role")).rejects.toThrow();
    await expect(h.answer(plan!.token, { kind: "submit", choice: "refine" }, "no-feedback")).rejects.toThrow();
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});


for (const fault of ["guest", "thread", "ingress", "queued", "control", "old-time", "receipt", "provenance", "generation", "attachment", "hash"] as const)
test(`source provenance rejects ${fault} without native mutation`, async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    const mail = await h.conversation("source", `> 답변 ${row!.token} 1`);
    const patch = fault === "guest" ? { ownerUser: "guest" } : fault === "thread" ? { thread: "slack:other/200" } :
      fault === "ingress" ? { source: "other" } : fault === "queued" ? { state: "queued" as const } :
      fault === "control" ? { target: "owner-control" } : fault === "old-time" ? { at: "2026-10-31T23:59:59.000Z" } :
      fault === "receipt" ? { receipt: undefined } : fault === "provenance" ? { ompProvenance: undefined } :
      fault === "generation" ? { ompProvenance: { ...mail.ompProvenance!, attachmentGeneration: 99 } } :
      fault === "attachment" ? { attachmentInstance: "old-host" } : { receipt: { ...mail.receipt!, payloadHash: payloadHash("other text") } };
    h.service().inbox.mark(mail.id, patch);
    await expect(h.service().nativeInteractions.respondFromLead(row!.token, selection, "source")).rejects.toThrow();
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("quoted and token-like owner text remains inert conversation until the lead chooses a semantic response", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    await h.conversation("quoted", `> 답변 ${row!.token} 1`);
    expect(h.attempts()).toBe(0);
    await h.service().nativeInteractions.respondFromLead(row!.token, { kind: "cancel" }, "quoted");
    expect(h.results.get("ask-1")).toEqual({ kind: "cancel" });
  } finally { h.cleanup(); }
});

for (const fault of ["local", "epoch", "done", "hold", "owner", "plan-snapshot"] as const)
test(`native request fence rejects ${fault}`, async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    if (fault === "local") h.setDialogs([]);
    if (fault === "plan-snapshot") h.setDialogs([h.ask("ask-1", { title: "changed request" })]);
    if (fault === "epoch") await h.service().registry.update(h.key, l => ({ ...l, runtime: { ...l.runtime!, generation: 2 } }));
    if (fault === "done") await h.service().registry.update(h.key, l => ({ ...l, status: "done-claimed" }));
    if (fault === "hold") await h.service().registry.update(h.key, l => ({ ...l, status: "paused", dispatchBlocked: true, runtime: { ...l.runtime!, held: true } }));
    if (fault === "owner") h.config.ingress[0]!.owners.splice(0, 1, "different-owner");
    await expect(h.answer(row!.token)).rejects.toThrow();
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("local completion racing native submission returns stale without resolving a replacement", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("race")]);
    const native = h.ctx.userInteractions!, respond = native.respond;
    native.respond = (id, response, operationId) => { h.setDialogs([h.ask("replacement")]); return respond(id, response, operationId); };
    expect((await h.answer(row!.token)).status).toBe("stale");
    expect(h.results.has("replacement")).toBe(false); expect(h.results.has("race")).toBe(false);
  } finally { h.cleanup(); }
});

for (const acknowledged of [true, false]) test(`uncertain native submission reconciles status only; applied=${acknowledged}`, async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    if (acknowledged) h.loseAck(); else h.unknown();
    const first = await h.answer(row!.token);
    expect(first.status).toBe(acknowledged ? "applied" : "pending");
    h.restart(); await h.service().nativeInteractions.poll();
    expect((await h.answer(row!.token)).status).toBe(first.status);
    await expect(h.answer(row!.token, selection, "different-source")).rejects.toThrow();
    expect(h.attempts()).toBe(1);
    expect(h.results.has("ask-1")).toBe(acknowledged);
  } finally { h.cleanup(); }
});

test("unknown submission never follows replacement epoch even on same-source retry", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]); h.unknown(); await h.answer(row!.token);
    await h.service().registry.update(h.key, l => ({ ...l, runtime: { ...l.runtime!, generation: 2 } }));
    h.restart(); await h.service().nativeInteractions.poll();
    await expect(h.answer(row!.token)).rejects.toThrow();
    expect(h.attempts()).toBe(1);
    expect(h.service().nativeInteractions.responseHistory().map(row => row.operation)).toEqual([expect.objectContaining({ state: "unknown" })]);
  } finally { h.cleanup(); }
});

test("pending resolver is reconciled read-only after timeout", async () => {
  const h = await fixture();
  const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
  const { promise: completion, resolve: finished } = Promise.withResolvers<void>();
  try {
    const [row] = await h.publish([h.ask()]);
    const native = h.ctx.userInteractions!, respond = native.respond, status = native.responseStatus;
    let pending: { requestId: string; operationId: string; responseHash: string } | undefined, starts = 0;
    native.respond = async (requestId, response, operationId) => {
      starts++; pending = { requestId, operationId, responseHash: payloadHash(JSON.stringify(response)) };
      await barrier;
      try { return await respond(requestId, response, operationId); } finally { finished(); }
    };
    native.responseStatus = operationId => {
      const result = status(operationId);
      return result.status === "missing" && pending?.operationId === operationId ? { ...pending, status: "pending" } : result;
    };
    expect((await h.answer(row!.token)).status).toBe("pending");
    expect((await h.answer(row!.token)).status).toBe("pending"); expect(starts).toBe(1);
    release(); await completion; await h.service().nativeInteractions.poll();
    expect((await h.answer(row!.token)).status).toBe("applied"); expect(starts).toBe(1);
  } finally { release(); h.cleanup(); }
});

test("secret and expired dialogs cannot receive remote answers", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("secret", { kind: "input", questions: undefined, secret: true, title: "secret-marker", defaultValue: "secret-marker" })]);
    expect(JSON.stringify(h.notifications)).not.toContain("secret-marker");
    await expect(h.answer(row!.token, { kind: "submit", value: "never transmit" })).rejects.toThrow();
    expect(await h.publish([h.ask("expired", { expiresAt: "2000-01-01T00:00:00.000Z" })])).toEqual([]);
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("native wire idempotence preserves original receipt and rejects conflicting reuse", async () => {
  const h = await fixture();
  try {
    h.setDialogs([h.ask("wire")]);
    const client = await connectOmp(h.f.target);
    try {
      const first = await client.interactionRespond("wire", selection, "wire-operation");
      expect(first.status).toBe("applied");
      expect(await client.interactionRespond("wire", selection, "wire-operation")).toEqual(first);
      expect(await client.interactionResponseStatus("wire-operation")).toEqual(first);
      await expect(client.interactionRespond("wire", { kind: "cancel" }, "wire-operation")).rejects.toThrow("interaction-operation-conflict");
      await expect(client.interactionRespond("another", selection, "wire-operation")).rejects.toThrow("interaction-operation-conflict");
      expect(h.attempts()).toBe(1);
    } finally { client.close(); }
  } finally { h.cleanup(); }
});

test("missing UI capability preserves ordinary input readiness without dialog authority", async () => {
  const h = await fixture();
  try {
    h.ctx.userInteractions = undefined;
    const client = await connectOmp(h.f.target);
    try {
      expect((await client.inspect()).capabilities.interactions).toBe(false);
      expect(ompSnapshot(await client.inspect()).inputReady).toBe(true);
      await expect(client.interactions()).rejects.toThrow("interactions-unavailable");
    } finally { client.close(); }
    await expect(connectOmp({ ...h.f.target, generation: 2 })).rejects.toMatchObject({ code: "identity-mismatch" });
  } finally { h.cleanup(); }
});

test("unmapped and contradictory source provenance never selects an unrelated thread", async () => {
  const h = await fixture();
  try {
    const other = h.source("other", "slack:C-other/200");
    expect(await h.publish([h.ask("contradictory", { sourceOperationHash: other.sourceOperationHash })])).toEqual([]);
    expect(await h.publish([h.ask("unmatched", { sourceEntryId: "unknown", sourceOperationHash: payloadHash("unknown") })])).toEqual([]);
    expect(await h.publish([h.ask("ambiguous", { sourceEntryId: undefined, sourceOperationHash: undefined })])).toEqual([]);
    expect(h.notifications).toEqual([]);
  } finally { h.cleanup(); }
});

test("held native requests resume only with a fresh authorized answer", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    await h.service().registry.update(h.key, l => ({ ...l, status: "paused", dispatchBlocked: true, runtime: { ...l.runtime!, held: true } }));
    await expect(h.answer(row!.token, selection, "held")).rejects.toThrow();
    await expect(h.service().nativeInteractions.respondOperator(row!.token, selection, "operator-held")).rejects.toThrow();
    expect(h.attempts()).toBe(0);
    await h.service().registry.update(h.key, l => ({ ...l, status: "working", dispatchBlocked: false, runtime: { ...l.runtime!, held: false } }));
    await h.answer(row!.token, selection, "resumed");
    expect(h.results.get("ask-1")).toEqual(selection);
  } finally { h.cleanup(); }
});

test("lead epoch changed during native observation cannot authorize a response", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    const dispatch = h.server.dispatch.bind(h.server);
    h.server.dispatch = async request => {
      if (request.method === "interactions") {
        await h.service().registry.update("lead", l => ({ ...l, runtime: { ...l.runtime!, generation: 2 } }));
      }
      return dispatch(request);
    };
    await expect(h.answer(row!.token)).rejects.toThrow();
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("reconnect retains an already-open request without a duplicate notice", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    h.restart(); await h.service().nativeInteractions.poll();
    expect(h.service().nativeInteractions.list()[0]!.token).toBe(row!.token);
    expect(h.notifications.map(n => n.thread)).toEqual([thread]);
    await h.answer(row!.token); expect(h.results.get("ask-1")).toEqual(selection);
  } finally { h.cleanup(); }
});

test("unknown native notice delivery is never blindly sent again", async () => {
  const h = await fixture();
  try {
    h.setDialogs([h.ask()]);
    let sends = 0;
    const original = h.service().runner;
    const runner: Runner = async (argv, options) => argv[0] === "fixture-reply"
      ? (sends++, { code: 1, out: "", err: "Unknown hook delivery" }) : original(argv, options);
    let service = new DoriService(h.config, runner);
    await service.nativeInteractions.poll();
    const token = service.nativeInteractions.list()[0]!.token;
    expect(service.outbox.get(`native-interaction:${token}`)?.state).toBe("unknown");
    await service.nativeInteractions.poll();
    service = new DoriService(h.config, runner); await service.nativeInteractions.poll();
    expect(sends).toBe(1); expect(service.outbox.get(`native-interaction:${token}`)?.state).toBe("unknown");
  } finally { h.cleanup(); }
});

test("source changed in place during native observation cannot authorize a response", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    const source = await h.conversation("changing-source", "first option");
    const interactions = h.ctx.userInteractions!;
    h.ctx.userInteractions = { ...interactions, list: () => {
      source.text = "changed after receipt verification";
      return interactions.list();
    } };
    await expect(h.service().nativeInteractions.respondFromLead(row!.token, selection, "changing-source")).rejects.toThrow("binding changed");
    expect(h.attempts()).toBe(0);
    expect(h.applied.size).toBe(0);
  } finally { h.cleanup(); }
});
