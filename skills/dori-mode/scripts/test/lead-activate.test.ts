import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { readJson } from "../src/ipc.ts";
import { DoriService, type ExternalTransport } from "../src/service.ts";
import type { Runner } from "../src/run.ts";
import { withState } from "./fakes.ts";
const oldId = "11111111-1111-4111-8111-111111111111", newId = "22222222-2222-4222-8222-222222222222", admin = { role: "admin" as const };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0)) done(); });
function fixture() {
  const state = withState(), calls: string[][] = [], socketPath = join(state.dir, "shared.sock");
  const config = { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, runtime: { ...defaultConfig().runtime, binary: process.execPath, rpcTimeoutMs: 100 } };
  let mode = "live", same = false, snapshots = 0, processReads = 0;
  let onSnapshot: (count: number) => void = () => {};
  const pane = () => same ? "old:pane" : "new:pane";
  const agent = (p: string, id: string) => ({ pane_id: p, agent: "codex", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: id } });
  const observer = { close() {}, async read(method: string, params: any): Promise<any> {
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: state.dir, status: { type: "idle" } } };
    if (method === "thread/loaded/list") return { data: [oldId, newId], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    throw new Error(`Unexpected read ${method}`);
  } };
  const transport: ExternalTransport = { connect: async () => observer, observe: async (_r, _c, _a, action) => action(observer) };
  const run: Runner = async argv => {
    calls.push([...argv]); const ok = (result: unknown) => ({ code: 0, out: JSON.stringify(result), err: "" });
    if (argv[1] === "app-server") return ok({ status: "running", cliVersion: "0.200.0", appServerVersion: "0.200.0", socketPath });
    if (argv[1] === "queue" && argv[2] === "--help") return { code: 0, out: "queue --thread <UUID> --message <TEXT>", err: "" };
    if (argv[0] === "ps") {
      if (mode === "shell-malformed") return { code: 0, out: "unreadable", err: "" };
      if (mode === "shell-missing") return { code: 1, out: "", err: "unsupported" };
      return { code: 0, out: `1 0\n100 1\n${mode === "shell-busy" ? "200 100\n" : ""}`, err: "" };
    }
    if (argv[1] === "pane" && argv[2] === "process-info") {
      const pid = mode === "shell-race" && ++processReads > 1 ? 101 : 100;
      return ok({ result: { process_info: { pane_id: "old:pane", shell_pid: pid, foreground_process_group_id: pid, foreground_processes: [{ pid, name: "zsh" }] } } });
    }
    if (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "get") {
      const p = argv[3]!;
      return ok({ result: { agent: agent(p, p === pane() && (!same || mode === "replaced") && mode !== "bad-target" ? newId : oldId) } });
    }
    if (argv[0] === "herdr" && argv[1] === "api" && argv[2] === "snapshot") {
      onSnapshot(++snapshots);
      if (mode === "offline") throw new Error("offline");
      if (mode === "malformed") return ok({ result: { snapshot: { agents: [] } } });
      const panes = [agent(pane(), mode === "bad-target" ? oldId : newId)];
      if (!same && ["live", "unknown"].includes(mode)) panes.push(mode === "unknown" ? { pane_id: "old:pane", agent_status: "unknown" } as any : agent("old:pane", oldId));
      if (mode === "moved") panes.push(agent("moved:pane", oldId));
      if (mode === "duplicate") panes.push(agent("duplicate:pane", newId));
      const agents = structuredClone(panes);
      if (mode.startsWith("shell")) panes.push({ pane_id: "old:pane", agent_status: "unknown" } as any);
      return ok({ result: { snapshot: { panes, agents } } });
    }
    throw new Error(`Unexpected mutation: ${argv.join(" ")}`);
  };
  const s = new DoriService(config, run, transport); atomicJson(join(state.dir, "control.json"), { token: "admin" });
  cleanup.push(() => { s.stop(); state.done(); });
  return { state, config, s, run, transport, calls, onSnapshot: (fn: typeof onSnapshot) => onSnapshot = fn, mode: (v: string) => mode = v, same: () => same = true,
    saved: () => readJson<any>(join(state.dir, "attachments/lead.json")),
    attach: () => s.handle("lead-activate", { threadId: oldId, pane: "old:pane", cwd: state.dir }, admin),
    activate: (service = s) => service.handle("lead-activate", { threadId: newId, pane: pane(), cwd: state.dir }, admin) };
}
test("operator-only activation attaches first session and reuses same attachment", async () => {
  const h = fixture(); await h.attach(); const before = h.saved();
  expect(await h.attach()).toMatchObject({ attached: true, reused: true }); expect(h.saved()).toEqual(before);
  await expect(h.s.handle("lead-activate", { threadId: newId, pane: "new:pane", cwd: h.state.dir }, { role: "lane", key: "worker" })).rejects.toThrow("operator");
});
for (const mode of ["closed", "same-pane", "shell"]) test(`replaces terminated prior TUI (${mode}), no replay, revokes old bridge`, async () => {
  const h = fixture(); await h.attach(); const old = h.saved();
  for (const state of ["queued", "unknown", "sent"] as const) h.s.inbox.put({ id: state, target: "lead", text: state, state, at: "2026-01-01", attachmentInstance: old.instance });
  const mail = structuredClone(h.s.inbox.list());
  if (mode !== "same-pane") h.mode(mode); else { h.same(); h.mode("replaced"); }
  expect(await h.activate()).toMatchObject({ attached: true, handedOff: true, threadId: newId, mailIds: [] });
  expect(h.saved().instance).not.toBe(old.instance); expect(h.saved().generation).toBe(old.generation + 1);
  expect(h.saved().excludedInboxIds.sort()).toEqual(["queued", "sent", "unknown"]); expect(h.s.inbox.list()).toEqual(mail);
  await expect(h.s.authorize(old.token)).rejects.toThrow("Forbidden");
  expect((await h.s.registry.read("lead"))?.runtimeHistory).toContainEqual(expect.objectContaining({ hostInstanceId: old.instance }));
  const current = h.saved(); await h.activate(); expect(h.saved()).toEqual(current);
  expect(h.calls.filter(argv => argv[1] === "queue" && argv[2] !== "--help" || argv[1] === "agent" && argv[2] !== "get")).toHaveLength(0);
});
for (const mode of ["live", "unknown", "malformed", "offline", "bad-target", "moved", "duplicate", "shell-busy", "shell-missing", "shell-malformed", "shell-race"]) test(`refuses ${mode} observation without mutation or revocation`, async () => {
  const h = fixture(); await h.attach(); const old = h.saved(), lane = await h.s.registry.read("lead"); h.mode(mode);
  await expect(h.activate()).rejects.toThrow(); expect(h.saved()).toEqual(old); expect(await h.s.registry.read("lead")).toEqual(lane);
  expect(await h.s.authorize(old.token)).toMatchObject({ instance: old.instance });
  expect(existsSync(join(h.state.dir, "attachments/handoff.json"))).toBe(false);
});
test("ownership changing between snapshot observations refuses before preparing a transaction", async () => {
  const h = fixture(); await h.attach(); h.mode("closed"); const old = h.saved(), lane = await h.s.registry.read("lead");
  h.onSnapshot(count => { if (count === 2) h.mode("live"); });
  await expect(h.activate()).rejects.toThrow("explicit lead-handoff");
  expect(h.saved()).toEqual(old); expect(await h.s.registry.read("lead")).toEqual(lane);
  expect(existsSync(join(h.state.dir, "attachments/handoff.json"))).toBe(false);
});
for (const holdReason of ["owner-pause", "done-review"] as const) test(`preserves ${holdReason}`, async () => {
  const h = fixture(); await h.attach(); h.mode("closed");
  await h.s.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason, runtime: { ...lane.runtime!, held: true } }));
  expect(await h.activate()).toMatchObject({ lead: { dispatchBlocked: true, holdReason, readiness: "held" } });
});
for (const boundary of ["hold", "replacement", "cleanup"]) test(`interrupted ${boundary} retries use one durable activation transaction`, async () => {
  const h = fixture(); await h.attach(); h.mode("closed"); const old = h.saved();
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => {
    const lane = await update(key, fn);
    if (armed && (boundary === "hold" && lane.runtime?.threadId === oldId && lane.dispatchBlocked || boundary === "replacement" && lane.runtime?.threadId === newId)) { armed = false; throw new Error("injected"); }
    return lane;
  };
  if (boundary === "cleanup") h.s.handoffIO.removeMarker = () => { throw new Error("injected"); };
  await expect(h.activate()).rejects.toThrow("injected");
  const marker = readJson<any>(join(h.state.dir, "attachments/handoff.json"));
  await expect(h.s.handle("lead-activate", { threadId: newId, pane: "other:pane", cwd: h.state.dir }, admin)).rejects.toThrow("Another handoff");
  const restart = new DoriService(h.config, h.run, h.transport); cleanup.unshift(() => restart.stop());
  expect(await h.activate(restart)).toMatchObject({ attached: true, mailIds: [], operationId: marker.operationId });
  expect(h.saved().generation).toBe(old.generation + 1); const saved = h.saved(); await h.activate(restart); expect(h.saved()).toEqual(saved);
  expect(existsSync(join(h.state.dir, "attachments/handoff.json"))).toBe(false);
});
test("prepared recovery rechecks prior ownership before replacement", async () => {
  const h = fixture(); await h.attach(); h.mode("closed"); const old = h.saved();
  const update = h.s.registry.update.bind(h.s.registry); let armed = true;
  h.s.registry.update = async (key, fn) => { const lane = await update(key, fn); if (armed && lane.dispatchBlocked) { armed = false; throw new Error("injected"); } return lane; };
  await expect(h.activate()).rejects.toThrow("injected"); h.mode("live");
  const restart = new DoriService(h.config, h.run, h.transport); cleanup.unshift(() => restart.stop());
  await expect(h.activate(restart)).rejects.toThrow("explicit lead-handoff");
  expect(h.saved()).toEqual(old); expect((await restart.registry.read("lead"))?.runtime?.threadId).toBe(oldId);
  h.mode("closed"); expect(await h.activate(restart)).toMatchObject({ attached: true, threadId: newId });
});

test("an orphan preparation can be superseded after source revision changes without replay", async () => {
  const h = fixture(); await h.attach(); h.mode("closed"); const old = h.saved();
  h.s.inbox.put({ id: "old-mail", target: "lead", text: "old request", state: "queued", at: "2026-01-01", attachmentInstance: old.instance });
  const mail = structuredClone(h.s.inbox.list()), marker = join(h.state.dir, "attachments/handoff.json");
  // Install a failure at marker creation only after the preparation is saved.
  const validate = (h.s as any).prepareAttachment.bind(h.s);
  (h.s as any).prepareAttachment = (...args: any[]) => {
    const prepared = validate(...args); mkdirSync(marker); return prepared;
  };
  await expect(h.activate()).rejects.toThrow();
  rmdirSync(marker); (h.s as any).prepareAttachment = validate;
  expect(h.saved()).toEqual(old);
  await h.s.registry.update("lead", lane => ({ ...lane, dispatchBlocked: true, holdReason: "owner-pause", runtime: { ...lane.runtime!, held: true } }));
  const result = await h.activate();
  expect(result).toMatchObject({ attached: true, mailIds: [], lead: { dispatchBlocked: true, holdReason: "owner-pause" } });
  expect(h.saved().generation).toBe(old.generation + 1);
  expect(h.s.inbox.list()).toEqual(mail);
  expect(h.saved().excludedInboxIds).toContain("old-mail");
  expect(readdirSync(join(h.state.dir, "attachments/handoffs"))).toHaveLength(2);
  await expect(h.s.authorize(old.token)).rejects.toThrow("Forbidden");
  const attached = h.saved(); await h.activate(); expect(h.saved()).toEqual(attached);
});
