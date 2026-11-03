import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import type { RestartRecord } from "../src/lead-restart-coordinator.ts";
import { restartProcessExited } from "../src/lead-restart-launcher.ts";
import type { Runner } from "../src/run.ts";
import type { OmpTarget } from "../src/runtime/omp/contract.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function record(pid: number): RestartRecord {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iyen-restart-exit-"))); directories.push(dir);
  const target: OmpTarget = { kind: "omp", protocol: 1, sessionId: "00000000-0000-4000-8000-000000000001", sessionFile: join(dir, "original.jsonl"), cwd: dir,
    paneId: "w1:p1", terminalId: "original-terminal", instanceId: "old-native", generation: 1, role: "attached-lead", laneKey: "lead", runtimeVersion: "18.15.0", socketPath: join(dir, "native.sock"), tokenFile: join(dir, "native.token") };
  const mail = { id: "original", target: "lead", text: "restart", state: "sent" as const, at: "2026-11-03T00:00:00.000Z" };
  return { version: 1, operationId: "exit-proof", authorizationHash: "a".repeat(64), authorization: { source: "slack", sourceMessageId: "source", owner: "owner", thread: "original-thread", mail,
    scope: { target, instance: "old-attachment", generation: 2 } },
    launchMetadata: { agentDir: join(dir, "owner-profile"), settingsHome: join(dir, "owner-profile"), approvalMode: "yolo", provider: "fixture", model: "lead-model", effort: "medium" },
    phase: "exit-pending", createdAt: mail.at, updatedAt: mail.at, config: defaultConfig(dir), process: { pid, startedAt: mail.at },
    before: { key: "lead", role: "lead", title: "lead", thread: "none", brief: "", done: "", openedAt: mail.at },
    launch: { instance: "new-attachment", generation: 3, token: "fixture", bridge: join(dir, "bridge"), bootstrapFile: join(dir, "bootstrap") } };
}
function detached(record: RestartRecord, agents: unknown[] = [], terminalId = record.authorization.scope.target.terminalId): Runner {
  return async argv => ({ code: 0, err: "", out: JSON.stringify({ result: argv[1] === "agent" ? { agents } : {
    pane: { pane_id: record.authorization.scope.target.paneId, terminal_id: terminalId, cwd: record.authorization.scope.target.cwd, agent: null } } }) });
}
async function exitedPid() {
  const process = Bun.spawn([globalThis.process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  await process.exited; return process.pid;
}

test("shutdown ACK or detached pane does not prove an actually live process exited", async () => {
  const r = record(process.pid);
  expect(await restartProcessExited(r, detached(r))).toBe(false);
});
test("actual process exit plus exact Herdr detach proves safe resume boundary", async () => {
  const r = record(await exitedPid());
  expect(await restartProcessExited(r, detached(r))).toBe(true);
});
test("reaped native process with stale session association stays pending", async () => {
  const r = record(await exitedPid()), old = r.authorization.scope.target;
  expect(await restartProcessExited(r, detached(r, [{ agent: "omp", pane_id: old.paneId, agent_session: { value: old.sessionFile } }]))).toBe(false);
});
test("replacement pane occupant and changed terminal never authorize launch", async () => {
  const r = record(await exitedPid()), old = r.authorization.scope.target;
  expect(await restartProcessExited(r, detached(r, [{ agent: "codex", pane_id: old.paneId }]))).toBe(false);
  await expect(restartProcessExited(r, detached(r, [], "different-terminal"))).rejects.toThrow();
});
test("missing or ambiguous Herdr evidence is unknown rather than successful exit", async () => {
  const r = record(await exitedPid());
  await expect(restartProcessExited(r, async () => ({ code: 1, out: "", err: "unavailable" }))).rejects.toThrow();
  await expect(restartProcessExited(r, detached(r, [{ agent: "omp", pane_id: "other-pane" }]))).rejects.toThrow();
  const noProcess = { ...r, process: undefined };
  await expect(restartProcessExited(noProcess, detached(r))).rejects.toThrow("never pinned");
});
