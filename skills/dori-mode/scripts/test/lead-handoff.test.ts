import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { readJson, socketDir } from "../src/ipc.ts";
import { DoriService, type ExternalTransport } from "../src/service.ts";
import type { Runner } from "../src/run.ts";
import { withState } from "./fakes.ts";

const fromThreadId = "11111111-1111-4111-8111-111111111111", threadId = "22222222-2222-4222-8222-222222222222";
const admin = { role: "admin" as const };
let h: ReturnType<typeof fixture>;
function fixture() {
  const state = withState(), socketPath = join(socketDir(state.dir), "handoff.sock"), calls: string[][] = [];
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, ingress: [{ id: "owner", command: ["fixture"], owners: ["owner"] }], runtime: { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 100 } };
  let invalid = false, unavailable = false, busy = true;
  const observer = { close() {}, async read(method: string, params: any): Promise<any> {
    const id = params?.threadId;
    const result = method === "initialize" ? {} : method === "thread/read" ? { thread: { id, cwd: state.dir, status: { type: busy ? "active" : "idle", ...(busy ? { activeFlags: [] } : {}) } } } :
      method === "thread/loaded/list" ? { data: [fromThreadId, threadId], nextCursor: null } : method === "thread/goal/get" ? { goal: null } :
      method === "thread/turns/list" ? { data: busy ? [{ id: `owner:${id}`, status: "inProgress", items: [] }] : [], nextCursor: null } : undefined;
    if (result === undefined) throw new Error("refused"); return result;
  } };
  const transport: ExternalTransport = { connect: async () => observer, observe: async (_run, _config, _attachment, action) => action(observer) };
  const run: Runner = async argv => {
    calls.push([...argv]);
    const ok = (result: unknown) => ({ code: 0, out: JSON.stringify(result), err: "" });
    if (argv[1] === "app-server") { if (unavailable) throw new Error("Bearer private-token"); return ok({ status: "running", cliVersion: "0.200.0", appServerVersion: "0.200.0", socketPath }); }
    if (argv[1] === "queue" && argv[2] === "--help") return { code: 0, out: "queue --thread <UUID> --message <TEXT>", err: "" };
    if (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "get") {
      const target = argv[3] === "new:pane";
      return ok({ result: { agent: { agent: "codex", pane_id: argv[3], agent_status: busy ? "working" : "idle", agent_session: { agent: "codex", kind: "id", value: target && !invalid ? threadId : fromThreadId } } } });
    }
    throw new Error(`Unexpected mutation: ${argv.join(" ")}`);
  };
  const s = new DoriService(config, run, transport);
  const attach = { threadId: fromThreadId, pane: "old:pane", cwd: state.dir };
  const args = { fromThreadId, threadId, pane: "new:pane", cwd: state.dir, mailIds: ["selected"], operationId: "handoff-1" };
  return { state, config, s, attach, args, calls, run, transport, invalid: (value = true) => invalid = value, unavailable: (v = true) => unavailable = v, idle: () => busy = false };
}
beforeEach(async () => {
  h = fixture(); atomicJson(join(h.state.dir, "control.json"), { token: "admin" });
  h.s.inbox.put({ id: "history", target: "lead", text: "historical", state: "queued", at: "2020-01-01" });
  await h.s.handle("lead-attach", h.attach, admin);
  const saved = readJson<any>(join(h.state.dir, "attachments/lead.json"));
  for (const id of ["selected", "unselected"]) h.s.inbox.put({ id, target: "lead", text: id, state: "queued", at: "2026-01-01", attachmentInstance: saved.instance });
  for (const state of ["unknown", "sending", "sent"] as const) h.s.inbox.put({ id: state, target: "lead", text: state, state, at: "2020-01-01", attachmentInstance: saved.instance });
  h.s.inbox.put({ id: "receipt", target: "lead", text: "receipt", state: "queued", turnId: "known-turn", at: "2020-01-01" });
  h.s.inbox.put({ id: "reconciled", target: "lead", text: "reconciled", state: "queued", source: "reconciled: checked by operator", at: "2020-01-01" });
  h.s.inbox.put({ id: "other", target: "lead", text: "other", state: "queued", attachmentInstance: "other-instance", at: "2020-01-01" });
});
afterEach(() => { h.s.stop(); h.state.done(); });
const saved = () => readJson<any>(join(h.state.dir, "attachments/lead.json"));
const queues = () => h.calls.filter(argv => argv[1] === "queue" && argv[2] !== "--help");

test("preview lists never-attempted records, explicitly labels historical eligibility and does not transfer mail", async () => {
  const before = structuredClone(h.s.inbox.list()), attachment = saved();
  const { mailIds, operationId, ...preview } = h.args;
  expect(await h.s.handle("lead-handoff-preview", preview, admin)).toMatchObject({ eligibleMailIds: ["history", "selected", "unselected"], historicalMailIds: ["history"], dispatches: false });
  expect(h.s.inbox.list()).toEqual(before); expect(saved()).toEqual(attachment); expect(queues()).toHaveLength(0);
  expect(existsSync(join(h.state.dir, "attachments/handoff.json"))).toBe(false);
});

test("handoff migrates only selected mail, preserves history and revokes old capability after replacement", async () => {
  const old = saved(), before = structuredClone(h.s.inbox.list());
  const [result, duplicate] = await Promise.all([1, 2].map(() => h.s.handle("lead-handoff", h.args, admin)));
  expect(result).toEqual(duplicate);
  expect(result).toMatchObject({ attached: true, handedOff: true, operationId: "handoff-1", fromThreadId, threadId, mailIds: ["selected"], lead: { readiness: "busy", runtime: { generation: old.generation + 1, threadId } } });
  const current = saved(); expect(current.instance).not.toBe(old.instance); expect(current.token).not.toBe(old.token);
  expect(current.excludedInboxIds).toContain("history"); expect(current.excludedInboxIds).toContain("unselected"); expect(current.excludedInboxIds).not.toContain("selected");
  expect(h.s.inbox.get("selected")?.attachmentInstance).toBe(current.instance);
  for (const row of before.filter(row => row.id !== "selected")) expect(h.s.inbox.get(row.id)).toEqual(row);
  await expect(h.s.authorize(old.token)).rejects.toThrow("Forbidden");
  expect(await h.s.authorize(current.token)).toMatchObject({ instance: current.instance });
  expect((await h.s.registry.read("lead"))?.runtimeHistory?.at(-1)?.threadId).toBe(fromThreadId);
  const restarted = new DoriService(h.config, h.run, h.transport);
  expect(await restarted.handle("lead-handoff", h.args, admin)).toEqual(result);
  await expect(restarted.handle("lead-handoff", { ...h.args, mailIds: [] }, admin)).rejects.toThrow("different arguments");
  expect(queues()).toHaveLength(0); expect(JSON.stringify(result)).not.toContain(current.token);
});

for (const id of ["unknown", "sending", "sent", "receipt", "reconciled", "other", "missing"]) test(`handoff refuses ${id} without mutating the old attachment`, async () => {
  const old = saved();
  await expect(h.s.handle("lead-handoff", { ...h.args, mailIds: [id] }, admin)).rejects.toThrow("selection");
  expect(saved()).toEqual(old); expect(await h.s.authorize(old.token)).toMatchObject({ instance: old.instance }); expect(queues()).toHaveLength(0);
});

test("handoff requires explicit operator, source identity and mail selection; invalid target preserves old capability", async () => {
  const old = saved(), caller = await h.s.authorize(old.token);
  await expect(h.s.handle("lead-handoff", h.args, caller)).rejects.toThrow("operator");
  await expect(h.s.handle("lead-handoff", { ...h.args, fromThreadId: threadId }, admin)).rejects.toThrow();
  const { mailIds, ...missing } = h.args;
  await expect(h.s.handle("lead-handoff", missing, admin)).rejects.toThrow("explicit mailIds");
  await expect(h.s.handle("lead-handoff", { ...h.args, operationId: "" }, admin)).rejects.toThrow("operationId");
  h.invalid(); await expect(h.s.handle("lead-handoff", h.args, admin)).rejects.toThrow("identity mismatch");
  expect(saved()).toEqual(old); expect(await h.s.authorize(old.token)).toMatchObject({ instance: old.instance }); expect(queues()).toHaveLength(0);
});

test("explicit historical selection can transfer never-attempted history while empty selection transfers nothing", async () => {
  const result = await h.s.handle("lead-handoff", { ...h.args, mailIds: ["history"] }, admin);
  expect(result.mailIds).toEqual(["history"]); expect(saved().excludedInboxIds).not.toContain("history");
  expect(h.s.inbox.get("history")?.attachmentInstance).toBe(saved().instance); expect(queues()).toHaveLength(0);
});

test("empty selection preserves every historical and current queue boundary", async () => {
  const before = structuredClone(h.s.inbox.list()); await h.s.handle("lead-handoff", { ...h.args, mailIds: [] }, admin);
  expect(h.s.inbox.list()).toEqual(before); for (const row of before) expect(saved().excludedInboxIds).toContain(row.id);
  expect(queues()).toHaveLength(0);
});

for (const boundary of ["hold", "mail", "attachment", "registry", "commit", "release"] as const) test(`recorded handoff interrupted at ${boundary} safely recovers without replay or duplicate generation`, async () => {
  const old = saved(), update = h.s.registry.update.bind(h.s.registry), mark = h.s.inbox.mark.bind(h.s.inbox); let armed = true;
  h.s.registry.update = async (key, fn) => {
    const result = await update(key, lane => {
      const next = fn(lane);
      if (armed && boundary === "attachment" && next.runtime?.threadId === threadId) { armed = false; throw new Error("injected attachment"); }
      if (armed && boundary === "commit" && lane.runtime?.threadId === threadId && !next.dispatchBlocked) { armed = false; throw new Error("injected commit"); }
      return next;
    });
    if (armed && (boundary === "hold" && result.runtime?.threadId === fromThreadId && result.dispatchBlocked || boundary === "registry" && result.runtime?.threadId === threadId || boundary === "release" && result.runtime?.threadId === threadId && !result.dispatchBlocked)) { armed = false; throw new Error(`injected ${boundary}`); }
    return result;
  };
  h.s.inbox.mark = (id, patch) => { const result = mark(id, patch); if (armed && boundary === "mail" && id === "selected") { armed = false; throw new Error("injected mail"); } return result; };
  await expect(h.s.handle("lead-handoff", h.args, admin)).rejects.toThrow("injected");
  expect((await h.s.registry.read("lead"))?.dispatchBlocked).toBe(true); expect(queues()).toHaveLength(0);
  const committed = ["commit", "release"].includes(boundary);
  if (!committed) expect(await h.s.authorize(old.token)).toMatchObject({ instance: old.instance });
  const restart = new DoriService(h.config, h.run, h.transport);
  // Explicit retries bypass automatic backoff and finish only the recorded target.
  const result = await restart.handle("lead-handoff", h.args, admin);
  expect(result).toMatchObject({ attached: true, handedOff: true, lead: { readiness: "busy", runtime: { generation: old.generation + 1 } } });
  expect(await restart.handle("lead-handoff", h.args, admin)).toEqual(result);
  expect(restart.inbox.get("selected")?.attachmentInstance).toBe(saved().instance);
  expect(restart.inbox.get("unknown")?.state).toBe("unknown"); expect(restart.inbox.get("sending")?.state).toBe("unknown");
  expect(saved().excludedInboxIds).toContain("history"); expect(saved().excludedInboxIds).toContain("unselected");
  await expect(restart.authorize(old.token)).rejects.toThrow("Forbidden"); expect(queues()).toHaveLength(0);
  expect(existsSync(join(h.state.dir, "attachments/handoff.json"))).toBe(false);
});

test("pending handoff resumes on observation, keeps newly arrived source mail excluded, and throttles offline target retries", async () => {
  const old = saved(), update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => { const result = await update(key, fn); if (armed && result.dispatchBlocked) { armed = false; throw new Error("injected hold"); } return result; };
  await expect(h.s.handle("lead-handoff", h.args, admin)).rejects.toThrow("injected");
  h.unavailable(); await h.s.receive("owner", { id: "during", user: "owner", thread: "owner:thread", text: "new message" });
  expect(h.s.inbox.get("inbound:owner:owner:thread:during")?.attachmentInstance).toBe(old.instance);
  const restart = new DoriService(h.config, h.run, h.transport); restart.deps.clock = { now: () => Date.now() + 120000, sleep: async () => {} };
  await restart.handle("status", { key: "lead" }, admin);
  const probes = h.calls.length;
  await restart.handle("status", { key: "lead" }, admin); expect(h.calls.length).toBe(probes);
  h.unavailable(false); restart.deps.clock = { now: () => Date.now() + 240000, sleep: async () => {} };
  await restart.handle("status", { key: "lead" }, admin);
  expect((await restart.registry.read("lead"))?.runtime?.threadId).toBe(threadId);
  expect(restart.inbox.get("inbound:owner:owner:thread:during")?.attachmentInstance).toBe(old.instance);
  expect(queues()).toHaveLength(0);
});

for (const holdReason of ["owner-pause", "done-review"] as const) test(`handoff preserves ${holdReason}`, async () => {
  await h.s.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason, runtime: { ...lane.runtime!, held: true } }));
  expect(await h.s.handle("lead-handoff", h.args, admin)).toMatchObject({ attached: true, lead: { dispatchBlocked: true, holdReason, readiness: "held" } });
  expect((await h.s.registry.read("lead"))?.holdReason).toBe(holdReason); expect(queues()).toHaveLength(0);
});

test("pending handoff gates admin mutations and definite target identity loss requires explicit operator retry", async () => {
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => { const result = await update(key, fn); if (armed && result.dispatchBlocked) { armed = false; throw new Error("injected hold"); } return result; };
  await expect(h.s.handle("lead-handoff", h.args, admin)).rejects.toThrow("injected");
  for (const action of ["input", "report", "mail-resolve", "lead-detach"])
    await expect(h.s.handle(action, { key: "lead", text: "concurrent", operationId: "concurrent" }, admin)).rejects.toThrow("mutations are held");
  expect(h.s.inbox.get("concurrent")).toBeUndefined();
  h.invalid(); const restart = new DoriService(h.config, h.run, h.transport);
  restart.deps.clock = { now: () => Date.now() + 120000, sleep: async () => {} };
  await restart.handle("status", { key: "lead" }, admin);
  h.invalid(false); restart.deps.clock = { now: () => Date.now() + 240000, sleep: async () => {} };
  const calls = h.calls.length; await restart.handle("status", { key: "lead" }, admin);
  expect(h.calls.length).toBe(calls); expect((await restart.registry.read("lead"))?.runtime?.threadId).toBe(fromThreadId);
  expect(await restart.handle("lead-handoff", h.args, admin)).toMatchObject({ attached: true, handedOff: true, threadId });
  expect(queues()).toHaveLength(0);
});


test("inbox persistence failure leaves cache unchanged and same-process handoff retry durably assigns selected mail", async () => {
  const old = saved(), mark = h.s.inbox.mark.bind(h.s.inbox), path = join(h.state.dir, "inbox.json"), backup = `${path}.test-backup`;
  let armed = true;
  h.s.inbox.mark = (id, patch) => {
    if (!armed || id !== "selected") return mark(id, patch);
    armed = false;
    // Atomic replacement cannot rename a file over a directory. Restore the
    // durable inbox immediately after the failure; the process keeps its cache.
    renameSync(path, backup); mkdirSync(path);
    try { return mark(id, patch); }
    finally { rmdirSync(path); renameSync(backup, path); }
  };
  await expect(h.s.handle("lead-handoff", h.args, admin)).rejects.toThrow();
  expect(h.s.inbox.get("selected")?.attachmentInstance).toBe(old.instance);
  expect(readJson<any>(path).selected.attachmentInstance).toBe(old.instance);
  expect(await h.s.authorize(old.token)).toMatchObject({ instance: old.instance });
  const result = await h.s.handle("lead-handoff", h.args, admin), current = saved();
  expect(result).toMatchObject({ attached: true, handedOff: true });
  expect(h.s.inbox.get("selected")?.attachmentInstance).toBe(current.instance);
  expect(readJson<any>(path).selected.attachmentInstance).toBe(current.instance);
  expect(readJson<any>(path).unknown.state).toBe("unknown"); expect(queues()).toHaveLength(0);
});
