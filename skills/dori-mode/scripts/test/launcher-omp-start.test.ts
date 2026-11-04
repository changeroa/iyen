import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { atomicJson } from "../src/journal.ts";
import { nativeLead, type LaunchRecord } from "../src/launcher/native.ts";
import { payloadHash } from "../src/runtime/omp/contract.ts";
import type { Runner } from "../src/run.ts";
import { ompFixture } from "./fixtures/omp.ts";
const ok = (result: any) => ({ code: 0, out: JSON.stringify({ result }), err: "" });
async function fixture() {
  const f = ompFixture(); f.transcript([]); f.snapshot.effort = "medium";
  Object.assign(f.identity, { role: "attached-lead", laneKey: "lead" }); Object.assign(f.target, f.identity);
  await f.serve(async r => ({ protocol: 1, id: r.id, identity: f.identity, result: f.snapshot }));
  const config = defaultConfig(f.directory);
  Object.assign(config.runtime, { kind: "omp", binary: "/fixture/omp", settingsHome: join(f.directory, "profile"), requiredVersion: "18.15.0", startupTimeoutMs: 1 });
  config.stateDir = join(f.directory, "state");
  config.runtime.omp = { registryDir: f.directory, extensionPath: "/fixture/extension.ts", provider: "fixture", approvalMode: "always-ask" };
  const record: LaunchRecord = { version: 1, operationId: "fixture-start", configPath: "/fixture/config", phase: "prepared", cwd: f.directory, pane: f.identity.paneId, terminalId: f.identity.terminalId, model: "test", effort: "medium" };
  const saved = { threadId: f.identity.sessionId, sessionFile: f.identity.sessionFile, pane: f.identity.paneId, terminalId: f.identity.terminalId, cwd: f.directory };
  const state = { starts: 0, self: false, sibling: false, publishOnStart: false, result: { code: 1, out: JSON.stringify({ error: { code: "agent_pane_busy", message: "not an available shell" } }), err: "" } };
  const publish = () => atomicJson(join(f.directory, `${payloadHash(`${f.identity.instanceId}:${f.identity.generation}`)}.json`), { ...f.target, pid: process.pid, startedAt: new Date().toISOString() });
  const runner: Runner = async args => {
    if (args[0] === "ps") return { code: 0, out: `100 1 100 zsh\n200 100 200 bun\n201 200 200 ps${state.sibling ? "\n300 100 300 omp" : ""}`, err: "" };
    if (args[2] === "process-info") return ok({ process_info: { pane_id: record.pane, shell_pid: 100, foreground_process_group_id: state.self ? 200 : 100, foreground_processes: [{ pid: state.self ? 200 : 100, name: state.self ? "bun" : "zsh" }] } });
    if (args[2] === "start") { state.starts++; if (state.publishOnStart) publish(); return state.result; }
    if (args[2] === "list") return ok({ agents: [{ agent: "omp", cwd: f.directory, pane_id: record.pane, terminal_id: record.terminalId, agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: saved.sessionFile } }] });
    throw new Error(`Unexpected ${args}`);
  };
  return { f, config, record, saved, runner, publish, state };
}
test("same-shell caller starts one inherited child and authenticates exact resumed OMP", async () => {
  const h = await fixture(); h.state.self = true; let children = 0;
  const terminal = { pid: 200, isTTY: true, start: (argv: string[], cwd: string) => {
    children++; expect(cwd).toBe(h.f.directory); expect(argv[0]).toBe(h.config.runtime.binary);
    expect(argv[argv.indexOf("--resume") + 1]).toBe(h.saved.sessionFile);
    expect(argv[argv.indexOf("--agent-dir") + 1]).toBe(h.config.runtime.settingsHome);
    expect(h.record.phase).toBe("native-starting"); h.publish(); return { pid: 400 };
  } };
  try {
    expect(await nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, terminal)).toEqual(h.saved);
    expect(await nativeLead(h.config, h.saved, h.record, true, h.runner, () => {}, terminal)).toEqual(h.saved);
    expect(children).toBe(1); expect(h.state.starts).toBe(0);
  } finally { h.f.cleanup(); }
});
test("background native process blocks self-launch before dispatch intent", async () => {
  const h = await fixture(); h.state.self = true; h.state.sibling = true;
  try {
    await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, { pid: 200, isTTY: true, start: () => { throw new Error("must not spawn"); } })).rejects.toThrow("another process");
    expect(h.record.phase).toBe("prepared"); expect(h.state.starts).toBe(0);
  } finally { h.f.cleanup(); }
});
test("structured pre-dispatch refusal is retained and later retry starts exactly once", async () => {
  const h = await fixture();
  try {
    await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {})).rejects.toThrow("refused before dispatch");
    expect(h.record.phase).toBe("native-refused"); expect(h.record.startResult?.out).toContain("agent_pane_busy");
    h.state.result = { code: 0, out: "", err: "" }; h.state.publishOnStart = true;
    expect(await nativeLead(h.config, h.saved, h.record, false, h.runner, () => {})).toEqual(h.saved);
    expect(h.state.starts).toBe(2);
  } finally { h.f.cleanup(); }
});
test.each(["timeout", "connection lost", "agent_pane_unavailable", "agent_start_input_failed"])("%s stays uncertain; retry never starts another process", async error => {
  const h = await fixture(); h.state.result = { code: error === "timeout" ? 124 : 1, out: JSON.stringify({ error: { code: error } }), err: error };
  try {
    for (let n = 0; n < 2; n++) await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {})).rejects.toThrow(error);
    expect(h.state.starts).toBe(1); expect(h.record.phase).toBe("native-starting");
    h.publish(); expect(await nativeLead(h.config, h.saved, h.record, true, h.runner, () => {})).toEqual(h.saved);
    expect(h.state.starts).toBe(1);
  } finally { h.f.cleanup(); }
});
test("legacy unknown intent never switches to self-launch", async () => {
  const h = await fixture(); h.state.self = true; h.record.phase = "native-starting";
  try {
    await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, { pid: 200, isTTY: true, start: () => { throw new Error("must not spawn"); } })).rejects.toThrow("outcome unknown");
    expect(h.state.starts).toBe(0);
  } finally { h.f.cleanup(); }
});
test("synchronous spawn refusal permits retry without treating a later exit as safe replay", async () => {
  const h = await fixture(); h.state.self = true; let attempts = 0;
  const terminal = { pid: 200, isTTY: true, start: () => { if (++attempts === 1) throw new Error("ENOENT fixture"); h.publish(); return { pid: 400 }; } };
  try {
    await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, terminal)).rejects.toThrow("refused before child creation");
    expect(h.record.phase).toBe("native-refused"); expect(h.record.terminalChildPid).toBeUndefined();
    expect(await nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, terminal)).toEqual(h.saved);
    expect(attempts).toBe(2); expect(h.state.starts).toBe(0);
  } finally { h.f.cleanup(); }
});
test("created terminal child without controller remains unknown and cannot be spawned again", async () => {
  const h = await fixture(); h.state.self = true; let children = 0;
  const terminal = { pid: 200, isTTY: true, start: () => { children++; return { pid: 400 }; } };
  try {
    for (let n = 0; n < 2; n++) await expect(nativeLead(h.config, h.saved, h.record, false, h.runner, () => {}, terminal)).rejects.toThrow("outcome unknown");
    expect(h.record.phase).toBe("native-starting"); expect(h.record.terminalChildPid).toBe(400);
    expect(children).toBe(1); expect(h.state.starts).toBe(0);
  } finally { h.f.cleanup(); }
});
