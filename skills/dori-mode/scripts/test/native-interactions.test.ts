import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { readJson } from "../src/ipc.ts";
import { DoriService } from "../src/service.ts";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { OmpControlServer, type OmpContext } from "../src/runtime/omp/server.ts";
import { assertInteractionAnswer, payloadHash, type NativeInteractionReceipt, type NativeInteractionResponse, type NativeUserInteraction } from "../src/runtime/omp/contract.ts";
import { ompSnapshot } from "../src/runtime/omp-integration.ts";
import { ompFixture } from "./fixtures/omp.ts";
import type { Runner } from "../src/run.ts";

const thread = "slack:C-owner/100.000";
async function fixture(worker = false) {
  const f = ompFixture(); f.transcript([]);
  if (!worker) { Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity); }
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
  const key = worker ? "worker" : "lead";
  if (worker) {
    await service.registry.write({ key, title: "worker", role: "lane", thread, brief: "/fixture/brief", done: "fixture", openedAt: new Date().toISOString(),
      runtime: { kind: "omp", backend: "herdr-tui", state: "waiting_input", threadId: f.identity.sessionId, hostInstanceId: "worker-host", generation: 1, binaryVersion: "18.15.0",
        omp: { kind: "omp", target: f.target, attachmentInstanceId: "worker-host", attachmentGeneration: 1, attachedAt: new Date().toISOString(), excludedInboxIds: [] } } });
  } else {
    atomicJson(join(f.directory, `${createHash("sha256").update("instance:1").digest("hex")}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
    await service.handle("lead-activate", { threadId: f.identity.sessionId, sessionFile: f.identity.sessionFile, pane: f.identity.paneId, terminalId: f.identity.terminalId, cwd: f.directory }, { role: "admin" });
  }
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
  async function answer(token: string, text: string, id = "reply-1", patch: Record<string, unknown> = {}) {
    return service.receive("owner-slack", { id, user: "owner", thread, text: `답변 ${token} ${text}`, metadata: { ts: id, channel: "C-owner" }, ...patch });
  }
  return { f, ctx, server, config, notifications, results, applied, source, ask, publish, answer, lane, key,
    service: () => service, attempts: () => attempts, sends: () => sends,
    setDialogs: (rows: NativeUserInteraction[]) => { dialogs = rows; }, loseAck: () => { loseAck = true; }, unknown: () => { unknown = true; },
    restart: () => { service = new DoriService(config, runner); },
    cleanup: () => { server.close(); f.cleanup(); } };
}

test("native ask roundtrip advertises actual Korean choices in original owner thread and resolves without a new turn", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    expect(h.notifications).toEqual([{ thread, text: expect.stringContaining("구현 방식을 선택해 주세요") }]);
    expect(h.notifications[0]!.text).toContain(`답변 ${row!.token}`);
    expect(h.notifications[0]!.text).toContain("유지보수 우선");
    expect(row!.sourceMessageId).toBe("source-1");
    await h.answer(row!.token, "1");
    expect(h.results.get("ask-1")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] });
    expect(h.attempts()).toBe(1); expect(h.sends()).toBe(0);
    const incoming = h.service().inbox.list().find(m => m.sourceMessageId === "reply-1")!;
    expect(incoming).toMatchObject({ target: "owner-control", state: "sent", ownerUser: "owner", metadata: { ts: "reply-1", channel: "C-owner" } });
    await h.answer(row!.token, "1"); expect(h.attempts()).toBe(1);
    h.restart(); await h.answer(row!.token, "1"); expect(h.attempts()).toBe(1);
  } finally { h.cleanup(); }
});

test("managed worker answers are exact control traffic while ordinary chat remains lead-only", async () => {
  const h = await fixture(true);
  try {
    const [row] = await h.publish([h.ask()]);
    await h.service().receive("owner-slack", { id: "ordinary", user: "owner", thread, text: "다음 작업도 검토해 주세요" });
    expect(h.service().inbox.list().find(m => m.sourceMessageId === "ordinary")?.target).toBe("lead");
    await h.answer(row!.token, "직접: 사용자 정의 구현");
    expect(h.results.get("ask-1")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: [], customInput: " 사용자 정의 구현" }] });
    expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

test("multi-question/multi-select answers preserve ordered IDs, labels, custom input and notes", async () => {
  const h = await fixture();
  try {
    const request = h.ask("multi", { questions: [
      { id: "features", question: "기능", multi: true, options: [{ label: "A" }, { label: "B" }] },
      { id: "details", question: "상세 설명", options: [] },
    ] });
    const [row] = await h.publish([request]);
    const response: NativeInteractionResponse = { kind: "submit", answers: [{ id: "features", selectedOptions: ["B", "A"], note: "순서 유지" }, { id: "details", selectedOptions: [], customInput: "직접 입력" }] };
    await h.answer(row!.token, JSON.stringify(response)); expect(h.results.get("multi")).toEqual(response);
  } finally { h.cleanup(); }
});

test("ambiguous bare selection, quoted token, guests and cross-thread replies cannot resolve any pending request", async () => {
  const h = await fixture();
  try {
    const rows = await h.publish([h.ask("first"), h.ask("second")]), row = rows[0]!;
    await h.service().receive("owner-slack", { id: "bare", user: "owner", thread, text: "1" });
    expect(h.notifications.at(-1)!.text).toContain("요청을 추측해서 처리하지 않습니다");
    await h.service().receive("owner-slack", { id: "quoted", user: "owner", thread, text: `> 답변 ${row.token} 1` });
    await expect(h.answer(row.token, "1", "guest", { user: "guest" })).rejects.toThrow("Untrusted");
    await h.answer(row.token, "1", "cross-thread", { thread: "slack:other/200" });
    expect(h.attempts()).toBe(0);
    await h.answer(row.token, "1", "qualified"); expect(h.results.has(row.request.id)).toBe(true);
    expect(h.results.has(rows[1]!.request.id)).toBe(false);
  } finally { h.cleanup(); }
});

test("approval requires qualified exact offered scope, rejects generic yes, widened grants and disabled choices", async () => {
  const h = await fixture();
  try {
    const request = h.ask("approval", { kind: "approval", questions: undefined, title: "파일 변경 승인", options: [
      { id: "grant:workspace:once", label: "작업공간 이번만" }, { id: "deny", label: "거부" }, { id: "session", label: "세션 허용", disabled: true },
    ] });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    await h.service().receive("owner-slack", { id: "yes", user: "owner", thread, text: "yes" });
    await h.answer(row!.token, "yes", "qualified-yes");
    await h.answer(row!.token, "grant:workspace:always", "wide");
    await h.answer(row!.token, "session", "disabled");
    expect(h.attempts()).toBe(0);
    await h.answer(row!.token, "grant:workspace:once", "exact");
    expect(h.results.get("approval")).toEqual({ kind: "submit", choice: "grant:workspace:once" });
  } finally { h.cleanup(); }
});

for (const kind of ["select", "confirm", "input", "editor", "plan-review"] as const) test(`native ${kind} uses real resolver shape, not a new prompt`, async () => {
  const h = await fixture();
  try {
    const request = h.ask(kind, { kind, questions: undefined, options: kind === "select" ? [{ id: "choice-id", label: "선택" }] : kind === "plan-review" ? [{ id: "execute", label: "실행" }, { id: "refine", label: "수정" }] : undefined,
      ...(kind === "plan-review" ? { message: "실제 검토할 계획", tiers: [{ role: "builder", provider: "openai", model: "gpt-6.1-sol", thinkingLevel: "medium" }] } : {}) });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    const response: NativeInteractionResponse = kind === "select" ? { kind: "submit", choice: "choice-id" } : kind === "confirm" ? { kind: "submit", value: false } :
      kind === "plan-review" ? { kind: "submit", choice: "execute", role: "builder" } : { kind: "submit", value: "  여러 줄\n 원문 유지\n" };
    if (kind === "plan-review") {
      expect(h.notifications[0]!.text).toContain("실제 검토할 계획");
      await h.answer(row!.token, "execute", "missing-tier");
      await h.answer(row!.token, '{"kind":"submit","choice":"refine"}', "missing-feedback");
      expect(h.attempts()).toBe(0);
    }
    await h.answer(row!.token, JSON.stringify(response)); expect(h.results.get(kind)).toEqual(response); expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

test("local completion, expiry and controller generation changes invalidate advertised tokens", async () => {
  const h = await fixture();
  try {
    const [local] = await h.publish([h.ask("local")]);
    h.setDialogs([]);
    await h.answer(local!.token, "1");
    const [fresh] = await h.publish([h.ask("new")]);
    await h.service().registry.update(h.key, lane => ({ ...lane, runtime: { ...lane.runtime!, generation: lane.runtime!.generation + 1 } }));
    await h.answer(fresh!.token, "1", "new-epoch");
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
  const expired = await fixture();
  try {
    await expired.publish([expired.ask("expired", { expiresAt: "2000-01-01T00:00:00.000Z" })]);
    expect(expired.notifications).toEqual([]); expect(expired.service().nativeInteractions.list()).toEqual([]);
  } finally { expired.cleanup(); }
});

test("owner cancellation uses native cancellation and lane completion invalidates remote replies", async () => {
  const h = await fixture(true);
  try {
    const [cancel] = await h.publish([h.ask("cancel")]); await h.answer(cancel!.token, "취소");
    expect(h.results.get("cancel")).toEqual({ kind: "cancel" });
    const [done] = await h.publish([h.ask("done")]);
    await h.service().registry.update(h.key, lane => ({ ...lane, status: "done-claimed", dispatchBlocked: true }));
    await h.answer(done!.token, "1", "after-done");
    expect(h.attempts()).toBe(1); expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

test("reconnect captures already-open dialogs without duplicate notice and correlates original source among threads", async () => {
  const h = await fixture();
  try {
    h.source("other-source", "slack:C-other/200.000");
    const [row] = await h.publish([h.ask()]);
    h.restart(); await h.service().nativeInteractions.poll();
    expect(h.service().nativeInteractions.list()[0]!.token).toBe(row!.token);
    expect(h.notifications.map(n => n.thread)).toEqual([thread]);
    await h.answer(row!.token, "1"); expect(h.results.has("ask-1")).toBe(true);
  } finally { h.cleanup(); }
});

test("unknown native response reconciles applied receipt without a second mutation", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]); h.loseAck();
    await h.answer(row!.token, "1");
    expect(h.results.has("ask-1")).toBe(true); expect(h.attempts()).toBe(1);
    h.restart(); await h.service().nativeInteractions.poll(); await h.answer(row!.token, "1"); expect(h.attempts()).toBe(1);
    const journal = readJson<any>(join(h.config.stateDir, "native-interactions.json"));
    expect(Object.values(journal.responses)).toEqual([expect.objectContaining({ state: "applied", sourceMessageId: "reply-1", responseHash: payloadHash(JSON.stringify(h.results.get("ask-1"))) })]);
  } finally { h.cleanup(); }
});

test("missing native response status after an uncertain attempt remains unknown across reconnect and never blindly retries", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]); h.unknown(); await h.answer(row!.token, "1");
    h.restart(); await h.service().nativeInteractions.poll(); await h.answer(row!.token, "1");
    await h.answer(row!.token, "1", "different-source-id");
    expect(h.attempts()).toBe(1); expect(h.results.has("ask-1")).toBe(false);
    const journal = readJson<any>(join(h.config.stateDir, "native-interactions.json"));
    expect(Object.values(journal.responses)).toEqual([expect.objectContaining({ state: "unknown" })]);
  } finally { h.cleanup(); }
});

test("secret dialogs are redacted on wire and cannot receive any remote secret answer", async () => {
  const h = await fixture();
  try {
    const request = h.ask("secret", { kind: "input", questions: undefined, secret: true, title: "secret-title-marker", message: "secret-message-marker", defaultValue: "secret-value-marker" });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    expect(JSON.stringify(h.notifications)).not.toMatch(/secret-title-marker|secret-message-marker|secret-value-marker/);
    await h.answer(row!.token, "never transmit this");
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("missing native UI capability preserves ordinary input readiness but cannot resolve dialogs or cross identity", async () => {
  const h = await fixture();
  try {
    h.ctx.userInteractions = undefined;
    const client = await connectOmp(h.f.target);
    try {
      expect((await client.inspect()).capabilities.interactions).toBe(false);
      expect(ompSnapshot(await client.inspect()).inputReady).toBe(true);
      await expect(client.interactions()).rejects.toThrow("interactions-unavailable");
      await expect(client.interactionResponseStatus("response-op")).rejects.toThrow("interactions-unavailable");
    } finally { client.close(); }
    await expect(connectOmp({ ...h.f.target, generation: 2 })).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

test("ask rejects missing/reordered questions, unknown labels and multiple selections on a single-select request before submission", async () => {
  const h = await fixture();
  try {
    const request = h.ask("boundaries", { questions: [
      { id: "single", question: "하나 선택", options: [{ label: "A" }, { label: "B" }] },
      { id: "multi", question: "여러 개 선택", multi: true, options: [{ label: "C" }] },
    ] });
    const [row] = await h.publish([request]);
    const invalid = [
      [{ id: "single", selectedOptions: ["A"] }],
      [{ id: "multi", selectedOptions: ["C"] }, { id: "single", selectedOptions: ["A"] }],
      [{ id: "single", selectedOptions: ["A", "B"] }, { id: "multi", selectedOptions: ["C"] }],
      [{ id: "single", selectedOptions: ["not-offered"] }, { id: "multi", selectedOptions: ["C"] }],
      [{ id: "single", selectedOptions: ["A"] }, { id: "multi", selectedOptions: ["C", "C"] }],
    ];
    for (const [i, answers] of invalid.entries()) await h.answer(row!.token, JSON.stringify({ kind: "submit", answers }), `invalid-${i}`);
    expect(h.attempts()).toBe(0);
    await h.answer(row!.token, JSON.stringify({ kind: "submit", answers: [{ id: "single", selectedOptions: ["B"] }, { id: "multi", selectedOptions: ["C"] }] }), "valid-boundary");
    expect(h.results.get("boundaries")).toEqual({ kind: "submit", answers: [{ id: "single", selectedOptions: ["B"] }, { id: "multi", selectedOptions: ["C"] }] });
  } finally { h.cleanup(); }
});

test("native wire idempotence returns the original receipt, rejects changed operation reuse and reconciles exact status", async () => {
  const h = await fixture();
  try {
    h.setDialogs([h.ask("wire")]);
    const client = await connectOmp(h.f.target);
    try {
      const response: NativeInteractionResponse = { kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] };
      const first = await client.interactionRespond("wire", response, "wire-operation");
      expect(first).toMatchObject({ status: "applied", requestId: "wire", operationId: "wire-operation", responseHash: payloadHash(JSON.stringify(response)) });
      expect(await client.interactionRespond("wire", response, "wire-operation")).toEqual(first);
      expect(await client.interactionResponseStatus("wire-operation")).toEqual(first);
      await expect(client.interactionRespond("wire", { kind: "cancel" }, "wire-operation")).rejects.toThrow("interaction-operation-conflict");
      await expect(client.interactionRespond("another-request", response, "wire-operation")).rejects.toThrow("interaction-operation-conflict");
      expect(await client.interactionResponseStatus("never-submitted")).toEqual({ status: "missing", operationId: "never-submitted" });
      expect(h.attempts()).toBe(1);
    } finally { client.close(); }
  } finally { h.cleanup(); }
});

for (const choice of ["once", "session", "deny", "grant:workspace:once", "grant:workspace:always"]) test(`approval preserves explicitly offered ${choice} scope`, async () => {
  const h = await fixture();
  try {
    const request = h.ask(`approve-${choice}`, { kind: "approval", questions: undefined, options: [{ id: choice, label: "제공된 범위" }] });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    await h.answer(row!.token, choice);
    expect(h.results.get(request.id)).toEqual({ kind: "submit", choice });
    expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

for (const choice of ["compact", "keep", "refine", "save"]) test(`plan review supports ${choice} through the native resolver`, async () => {
  const h = await fixture();
  try {
    const request = h.ask(`plan-${choice}`, { kind: "plan-review", questions: undefined, message: "실제 계획 본문",
      options: [{ id: choice, label: "네이티브 계획 선택" }], tiers: [{ role: "reviewer", provider: "openai", model: "gpt-6.1-sol" }] });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    const response: NativeInteractionResponse = { kind: "submit", choice, ...(["compact", "keep"].includes(choice) ? { role: "reviewer" } : {}), ...(choice === "refine" ? { feedback: "이 부분을 수정해 주세요" } : {}) };
    await h.answer(row!.token, JSON.stringify(response));
    expect(h.results.get(request.id)).toEqual(response);
  } finally { h.cleanup(); }
});

test("a local completion racing remote native submission returns stale rather than resolving another request", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("race")]);
    const native = h.ctx.userInteractions!, respond = native.respond;
    // Native resolver observes local completion after the server's open-request check.
    native.respond = (id, response, operationId) => { h.setDialogs([]); return respond(id, response, operationId); };
    await h.answer(row!.token, "1");
    expect(h.results.has("race")).toBe(false);
    expect(h.service().nativeInteractions.list()).toEqual([]);
    expect([...h.applied.values()]).toEqual([expect.objectContaining({ status: "stale", requestId: "race" })]);
    expect(h.sends()).toBe(0);
  } finally { h.cleanup(); }
});

test("an unmapped lead dialog is withheld across multiple owner threads but can use one unique current owner thread", async () => {
  const h = await fixture();
  try {
    const request = h.ask("unmapped", { sourceEntryId: undefined, sourceOperationHash: undefined });
    const [row] = await h.publish([JSON.parse(JSON.stringify(request))]);
    expect(row!.thread).toBe(thread);
    h.source("second-owner-thread", "slack:C-other/200.000");
    await h.publish([JSON.parse(JSON.stringify(request)), h.ask("ambiguous-unmapped", { sourceEntryId: "also-unmapped", sourceOperationHash: undefined })]);
    expect(h.service().nativeInteractions.list()).toEqual([]);
    expect(h.notifications.map(n => n.thread)).toEqual([thread]);
    await h.answer(row!.token, "1");
    expect(h.attempts()).toBe(0);
  } finally { h.cleanup(); }
});

test("uncertain native response stays unknown after epoch replacement and cannot be retargeted", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]); h.unknown(); await h.answer(row!.token, "1");
    await h.service().registry.update(h.key, lane => ({ ...lane, runtime: { ...lane.runtime!, generation: lane.runtime!.generation + 1 } }));
    h.restart(); await h.service().nativeInteractions.poll();
    const journal = readJson<any>(join(h.config.stateDir, "native-interactions.json"));
    expect(Object.values(journal.responses)).toEqual([expect.objectContaining({ state: "unknown" })]);
    expect(journal.requests[row!.token].state).toBe("stale");
    await h.answer(row!.token, "1", "new-source");
    expect(h.attempts()).toBe(1);
  } finally { h.cleanup(); }
});

test("pending native response status after timeout is reconciled read-only until its original resolver completes", async () => {
  const h = await fixture();
  const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
  const { promise: completion, resolve: finished } = Promise.withResolvers<void>();
  try {
    const [row] = await h.publish([h.ask()]);
    const native = h.ctx.userInteractions!, originalRespond = native.respond, originalStatus = native.responseStatus;
    let pending: { requestId: string; operationId: string; responseHash: string } | undefined, starts = 0;
    native.respond = async (requestId, response, operationId) => {
      starts++; pending = { requestId, operationId, responseHash: payloadHash(JSON.stringify(response)) };
      await barrier;
      try { return await originalRespond(requestId, response, operationId); } finally { finished(); }
    };
    native.responseStatus = operationId => {
      const result = originalStatus(operationId);
      return result.status === "missing" && pending?.operationId === operationId ? { ...pending, status: "pending" } : result;
    };
    await h.answer(row!.token, "1");
    await h.answer(row!.token, "1");
    expect(starts).toBe(1); expect(h.results.has("ask-1")).toBe(false);
    const before = readJson<any>(join(h.config.stateDir, "native-interactions.json"));
    expect(Object.values(before.responses)).toEqual([expect.objectContaining({ state: "unknown" })]);
    release(); await completion;
    await h.service().nativeInteractions.poll();
    const after = readJson<any>(join(h.config.stateDir, "native-interactions.json"));
    expect(Object.values(after.responses)).toEqual([expect.objectContaining({ state: "applied" })]);
    expect(h.results.get("ask-1")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] });
    expect(starts).toBe(1);
  } finally { release(); h.cleanup(); }
});

test("an uncertain native notice delivery is not sent a second time on polling or service reconnect", async () => {
  const h = await fixture();
  try {
    h.setDialogs([h.ask()]);
    let sends = 0;
    const originalRunner = h.service().runner;
    const runner: Runner = async (argv, options) => argv[0] === "fixture-reply"
      ? (sends++, { code: 1, out: "", err: "Unknown hook delivery" })
      : originalRunner(argv, options);
    let service = new DoriService(h.config, runner);
    await service.nativeInteractions.poll();
    const token = service.nativeInteractions.list()[0]!.token;
    expect(service.outbox.get(`native-interaction:${token}`)?.state).toBe("unknown");
    await service.nativeInteractions.poll();
    service = new DoriService(h.config, runner); await service.nativeInteractions.poll();
    expect(sends).toBe(1);
    expect(service.outbox.get(`native-interaction:${token}`)?.state).toBe("unknown");
  } finally { h.cleanup(); }
});

test("Codex owner conversation starting with 답변 retains legacy lead-only intake", async () => {
  const f = ompFixture();
  try {
    const service = new DoriService({ ...defaultConfig(f.directory), stateDir: join(f.directory, "state"),
      ingress: [{ id: "owner-slack", command: ["fixture-ingress"], owners: ["owner"] }] },
      async () => { throw new Error("Ordinary intake must not send an automatic reply"); });
    await service.receive("owner-slack", { id: "codex-message", thread, user: "owner", text: "답변 내용도 검토해 주세요" });
    expect(service.inbox.list()).toEqual([expect.objectContaining({ target: "lead", state: "queued", sourceMessageId: "codex-message",
      text: `Owner message in ${thread}:\nSource message ID: codex-message\n답변 내용도 검토해 주세요` })]);
    expect(service.outbox.list()).toEqual([]);
  } finally { f.cleanup(); }
});

test("empty multi-select is applied, but single option plus custom input is not submitted", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask("multi-empty", { questions: [
      { id: "single", question: "하나", options: [{ label: "A" }] },
      { id: "multi", question: "없음 허용", multi: true, options: [{ label: "B" }] },
    ] })]);
    await h.answer(row!.token, JSON.stringify({ kind: "submit", answers: [
      { id: "single", selectedOptions: ["A"], customInput: "also custom" }, { id: "multi", selectedOptions: [] },
    ] }), "both");
    expect(h.attempts()).toBe(0);
    const response: NativeInteractionResponse = { kind: "submit", answers: [{ id: "single", selectedOptions: ["A"] }, { id: "multi", selectedOptions: [] }] };
    await h.answer(row!.token, JSON.stringify(response), "empty-multi");
    expect(h.results.get("multi-empty")).toEqual(response);
  } finally { h.cleanup(); }
});

for (const kind of ["input", "editor"] as const) test(`${kind} preserves ordinary JSON, incomplete braces and multiline whitespace`, async () => {
  const h = await fixture();
  try {
    for (const [index, value] of ['{"kind":"component","value":1}', "{ unfinished\n  code ", "  text\n\n"].entries()) {
      const id = `${kind}-${index}`;
      const [row] = await h.publish([h.ask(id, { kind, questions: undefined })]);
      await h.answer(row!.token, value, `raw-text-${index}`);
      expect(h.results.get(id)).toEqual({ kind: "submit", value });
    }
  } finally { h.cleanup(); }
});

test("custom input preserves whitespace and numeric answers name displayed indices rather than numeric labels", async () => {
  const h = await fixture();
  try {
    const [custom] = await h.publish([h.ask("custom")]);
    await h.answer(custom!.token, "직접: \n 원문 \n", "custom");
    expect(h.results.get("custom")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: [], customInput: " \n 원문 \n" }] });
    const [numeric] = await h.publish([h.ask("numeric", { questions: [{ id: "number", question: "선택", options: [{ label: "2" }, { label: "second" }] }] })]);
    await h.answer(numeric!.token, "2", "numeric");
    expect(h.results.get("numeric")).toEqual({ kind: "submit", answers: [{ id: "number", selectedOptions: ["second"] }] });
  } finally { h.cleanup(); }
});

test("contradictory or unmatched lead provenance never selects an unrelated owner receipt", async () => {
  const h = await fixture();
  try {
    const other = h.source("other", "slack:C-other/200");
    expect(await h.publish([h.ask("contradictory", { sourceOperationHash: other.sourceOperationHash })])).toEqual([]);
    expect(await h.publish([h.ask("unmatched", { sourceEntryId: "unknown", sourceOperationHash: payloadHash("unknown") })])).toEqual([]);
    expect(h.notifications).toEqual([]);
    const [valid] = await h.publish([h.ask("valid-source")]);
    expect(valid?.thread).toBe(thread);
    expect(valid?.sourceMessageId).toBe("source-1");
  } finally { h.cleanup(); }
});

test("registered worker launch provenance can use its uniquely authenticated report thread", async () => {
  const h = await fixture(true);
  try {
    const [row] = await h.publish([h.ask("launch-ask", { sourceEntryId: "launch-entry", sourceOperationHash: payloadHash("launch-worker") })]);
    expect(row?.thread).toBe(thread);
    await h.answer(row!.token, "1");
    expect(h.results.get("launch-ask")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] });
  } finally { h.cleanup(); }
});

test("rejected owner answers are durable control and an edited source cannot newly apply", async () => {
  const h = await fixture();
  try {
    const [row] = await h.publish([h.ask()]);
    await h.answer(row!.token, "not-offered", "rejected");
    const original = h.service().inbox.list().find(r => r.sourceMessageId === "rejected")!;
    expect(original).toMatchObject({ target: "owner-control", state: "sent" });
    await h.answer(row!.token, "1", "rejected");
    expect(h.attempts()).toBe(0);
    expect(h.service().inbox.get(original.id)?.text).toBe(original.text);
    await h.answer(row!.token, "1", "valid-new-source");
    expect(h.results.has("ask-1")).toBe(true);
  } finally { h.cleanup(); }
});

test("replayed ordinary selection does not become an answer after a question opens", async () => {
  const h = await fixture();
  try {
    const event = { id: "old-ordinary", user: "owner", thread, text: "1" };
    await h.service().receive("owner-slack", event);
    const [row] = await h.publish([h.ask()]);
    await h.service().receive("owner-slack", event);
    expect(h.attempts()).toBe(0);
    expect(h.service().inbox.list().find(r => r.sourceMessageId === event.id)?.target).toBe("lead");
    await h.answer(row!.token, "1", "new-answer");
    expect(h.results.has("ask-1")).toBe(true);
  } finally { h.cleanup(); }
});

test("old native SDK without UI capability still receives ordinary borrowed-lead input durably", async () => {
  const h = await fixture();
  try {
    h.ctx.userInteractions = undefined;
    const receipt = await h.service().deps.runtime.input("lead", "일반 owner 대화", "ordinary-without-ui");
    expect(receipt.receipt).toMatchObject({ operationId: "ordinary-without-ui", sessionId: h.f.identity.sessionId, payloadHash: payloadHash("일반 owner 대화") });
    expect(h.service().inbox.get("ordinary-without-ui")?.state).toBe("sent");
    expect(h.sends()).toBe(1);
    expect(h.notifications).toEqual([]);
  } finally { h.cleanup(); }
});

for (const received of [true, false]) test(`native ACK loss reconciles read-only on observation; durable receipt present=${received}`, async () => {
  const h = await fixture();
  try {
    const originalDispatch = h.server.dispatch.bind(h.server);
    let inputs = 0, lookups = 0;
    h.server.dispatch = async request => {
      if (request.method === "input") {
        inputs++;
        if (received) await originalDispatch(request);
        throw new Error("Lost input ACK");
      }
      if (request.method === "operation") lookups++;
      return originalDispatch(request);
    };
    await expect(h.service().deps.runtime.input("lead", "실제 owner 입력", "lost-input-ack")).rejects.toThrow();
    expect(h.service().inbox.get("lost-input-ack")?.state).toBe("unknown");
    expect((await h.service().registry.read("lead"))?.dispatchBlocked).toBe(true);
    await h.service().deps.runtime.inspect("lead");
    expect(h.service().inbox.get("lost-input-ack")?.state).toBe(received ? "sent" : "unknown");
    expect((await h.service().registry.read("lead"))?.dispatchBlocked).toBe(!received);
    expect(inputs).toBe(1);
    expect(lookups).toBe(1);
    expect(h.sends()).toBe(received ? 1 : 0);
  } finally { h.cleanup(); }
});

for (const binding of ["current", "old-generation", "other-thread", "missing-receipt", "ambiguous-owner"] as const)
test(`shared ingress binds worker report thread only to an exact authenticated lead receipt: ${binding}`, async () => {
  const h = await fixture(true);
  try {
    h.config.ingress[0]!.owners.push("second-owner");
    const target = { ...h.f.target, sessionId: "019a4190-0000-7000-8000-000000000002", instanceId: "lead-controller", role: "attached-lead" as const, laneKey: "lead" };
    await h.service().registry.write({ ...h.lane, key: "lead", role: "lead", revision: 0, thread: "none", runtime: {
      ...h.lane.runtime!, backend: "external-current-session", threadId: target.sessionId, hostInstanceId: "lead-host", generation: 3,
      omp: { kind: "omp", target, attachmentInstanceId: "lead-host", attachmentGeneration: 3, attachedAt: new Date().toISOString(), excludedInboxIds: [] },
    } });
    const text = "authenticated task";
    const receipt = { operationId: "authenticated-source", payloadHash: payloadHash(text), sessionId: target.sessionId, sessionFile: target.sessionFile,
      entryId: "owner-entry", receiptId: `omp-entry:${target.sessionId}:owner-entry` };
    h.service().inbox.put({ id: receipt.operationId, target: "lead", text, source: "owner-slack", ownerUser: "owner",
      thread: binding === "other-thread" ? "slack:other/200" : thread, attachmentInstance: "lead-host", state: "sent", at: new Date().toISOString(),
      ompProvenance: { target, attachmentInstanceId: "lead-host", attachmentGeneration: binding === "old-generation" ? 2 : 3 },
      ...(binding === "missing-receipt" ? {} : { receipt }),
    });
    if (binding === "ambiguous-owner") {
      h.service().inbox.put({ id: "second-owner-source", target: "lead", text, source: "owner-slack", ownerUser: "second-owner", thread,
        attachmentInstance: "lead-host", state: "sent", at: new Date().toISOString(),
        ompProvenance: { target, attachmentInstanceId: "lead-host", attachmentGeneration: 3 },
        receipt: { ...receipt, operationId: "second-owner-source", entryId: "other-owner", receiptId: `omp-entry:${target.sessionId}:other-owner` },
      });
    }
    const rows = await h.publish([h.ask("launch-owned", { sourceEntryId: "launch-entry", sourceOperationHash: payloadHash("launch-operation") })]);
    if (binding === "current") {
      expect(rows[0]).toMatchObject({ thread, owner: "owner", source: "owner-slack" });
      await h.answer(rows[0]!.token, "1");
      expect(h.results.get("launch-owned")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] });
    } else {
      expect(rows).toEqual([]);
      expect(h.notifications).toEqual([]);
      expect(h.attempts()).toBe(0);
    }
  } finally { h.cleanup(); }
});

test("owner and operator answers cannot cross a native execution hold and a fresh answer works after resume", async () => {
  const h = await fixture(true);
  try {
    const [row] = await h.publish([h.ask()]);
    await h.service().registry.update(h.key, lane => ({ ...lane, status: "paused", dispatchBlocked: true, runtime: { ...lane.runtime!, held: true } }));
    await h.answer(row!.token, "1", "while-held");
    await expect(h.service().nativeInteractions.respondOperator(row!.token,
      { kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] }, "operator-held")).rejects.toThrow();
    expect(h.attempts()).toBe(0);
    await h.service().registry.update(h.key, lane => ({ ...lane, status: "working", dispatchBlocked: false, runtime: { ...lane.runtime!, held: false } }));
    await h.answer(row!.token, "1", "after-resume");
    expect(h.results.get("ask-1")).toEqual({ kind: "submit", answers: [{ id: "strategy", selectedOptions: ["단순 구현"] }] });
  } finally { h.cleanup(); }
});
