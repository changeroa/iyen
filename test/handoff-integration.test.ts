import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { ipc, readJson, serviceSocket, socketDir } from "../src/ipc.ts";
import { withState } from "./fakes.ts";

const waitFor = async <T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 15000;
  let last: unknown;
  do {
    try { const value = await read(); if (accept(value)) return value; } catch (error) { last = error; }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${String(last)}`);
};

test("process handoff transfers only explicit queued input, revokes the old bridge and survives restart without replay", async () => {
  const state = withState(), oldId = "11111111-1111-4111-8111-111111111111", newId = "22222222-2222-4222-8222-222222222222";
  const socketPath = join(socketDir(state.dir), "shared.sock"), statePath = join(state.dir, "external-state.json"), panesPath = join(state.dir, "fixture-panes.json");
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  const server = Bun.serve({ unix: socketPath, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: { message(ws, raw) {
    const m = JSON.parse(String(raw)); if (m.id === undefined) return;
    const snapshot = readJson<any>(statePath);
    const result = m.method === "initialize" ? {} : m.method === "thread/read" ? { thread: snapshot.thread } :
      m.method === "thread/loaded/list" ? { data: [snapshot.thread.id], nextCursor: null } : m.method === "thread/goal/get" ? { goal: null } :
        m.method === "thread/turns/list" ? { data: snapshot.turns, nextCursor: null } : undefined;
    ws.send(JSON.stringify(result === undefined ? { id: m.id, error: { code: -32601, message: "unsupported" } } : { id: m.id, result }));
  } } });
  try {
    const setSession = (id: string, busy: boolean) => {
      atomicJson(statePath, { socketPath, thread: { id, cwd: state.dir, status: busy ? { type: "active", activeFlags: ["waitingOnApproval"] } : { type: "idle" } },
        turns: busy ? [{ id: `busy-${id}`, status: "inProgress", items: [] }] : [] });
      atomicJson(panesPath, [{ pane_id: "current:p", tab_id: "current:t", agent: "codex", agent_status: busy ? "working" : "idle", agent_session: { agent: "codex", kind: "id", value: id } }]);
    };
    setSession(oldId, true);
    const at = new Date().toISOString();
    atomicJson(join(state.dir, "inbox.json"), {
      uncertain: { id: "uncertain", target: "lead", text: "uncertain old attempt", state: "unknown", at },
      sent: { id: "sent", target: "lead", text: "already delivered", state: "sent", turnId: "prior-receipt", at },
      reconciled: { id: "reconciled", target: "lead", text: "manually reconciled", state: "queued", source: "reconciled: previous attempt", at },
    });
    const bin = join(state.dir, "bin"); mkdirSync(bin); symlinkSync(join(import.meta.dir, "fixtures/herdr.ts"), join(bin, "herdr"));
    const configPath = join(state.dir, "config.json");
    atomicJson(configPath, { ...defaultConfig(), stateDir: state.dir, defaultCwd: state.dir, runtime: { ...defaultConfig().runtime, binary: join(import.meta.dir, "fixtures/external-codex.ts"), rpcTimeoutMs: 1000 } });
    const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: state.dir, DORI_STATE_DIR: state.dir, DORI_CONFIG: configPath };
    const cli = join(import.meta.dir, "../src/cli.ts");
    const call = (action: string, args: any = {}, token = readJson<any>(join(state.dir, "control.json")).token) => ipc<any>(serviceSocket(state.dir), token, action, args, 10000);
    const start = async () => {
      daemon = Bun.spawn([process.execPath, cli, "serve"], { env, stdout: "pipe", stderr: "pipe" });
      const logs = { out: new Response(daemon.stdout as ReadableStream).text(), err: new Response(daemon.stderr as ReadableStream).text() };
      await waitFor(async () => existsSync(join(state.dir, "control.json")), Boolean);
      await waitFor(() => call("status"), Array.isArray); return logs;
    };
    const stop = async (logs: { out: Promise<string>; err: Promise<string> }) => {
      daemon!.kill("SIGTERM"); await daemon!.exited; expect(await logs.err).toBe(""); await logs.out;
    };
    let logs = await start();
    const old = await call("lead-attach", { threadId: oldId, pane: "current:p", cwd: state.dir });
    const oldAttachment = readJson<any>(join(state.dir, "attachments/lead.json"));
    for (const id of ["selected", "unselected"]) await call("input", { key: "lead", text: id, operationId: id });
    setSession(newId, true);
    const args = { fromThreadId: oldId, threadId: newId, pane: "current:p", cwd: state.dir, operationId: "handoff-process", mailIds: ["selected"] };
    await call("lead-handoff-preview", args);
    expect(readJson<any>(join(state.dir, "attachments/lead.json")).instance).toBe(oldAttachment.instance);
    for (const id of ["uncertain", "sent", "reconciled"]) await expect(call("lead-handoff", { ...args, operationId: `reject-${id}`, mailIds: [id] })).rejects.toThrow();
    const result = await call("lead-handoff", args);
    expect(result).toMatchObject({ attached: true, lead: { identityVerified: true, readiness: "busy", runtime: { threadId: newId } } });
    expect(result.bridge).not.toBe(old.bridge);
    await expect(call("status", { key: "lead" }, oldAttachment.token)).rejects.toThrow("Forbidden");
    expect(await call("lead-handoff", args)).toMatchObject({ attached: true, bridge: result.bridge });
    await expect(call("lead-handoff", { ...args, mailIds: ["unselected"] })).rejects.toThrow();
    await stop(logs); logs = await start();
    expect(await call("lead-handoff", args)).toMatchObject({ attached: true, bridge: result.bridge });
    setSession(newId, false);
    const mail = await waitFor(() => call("mail-list"), value => value.inbox.find((row: any) => row.id === "selected")?.state === "sent");
    expect(mail.inbox.find((row: any) => row.id === "unselected").state).toBe("queued");
    expect(mail.inbox.find((row: any) => row.id === "uncertain").state).toBe("unknown");
    expect(mail.inbox.find((row: any) => row.id === "reconciled").state).toBe("queued");
    expect(mail.inbox.find((row: any) => row.id === "sent").turnId).toBe("prior-receipt");
    const receipt = mail.inbox.find((row: any) => row.id === "selected").turnId;
    expect(receipt).toBeTruthy();
    await stop(logs); logs = await start();
    const afterRestart = await call("mail-list");
    expect(afterRestart.inbox.find((row: any) => row.id === "selected").turnId).toBe(receipt);
    const calls = readFileSync(join(state.dir, "external-codex-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const submissions = calls.filter(args => args[0] === "queue" && args[1] === "--thread");
    expect(submissions).toHaveLength(1); expect(submissions[0][2]).toBe(newId);
    await stop(logs);
  } finally { daemon?.kill(); if (daemon) await daemon.exited; server.stop(true); state.done(); }
}, 30000);
