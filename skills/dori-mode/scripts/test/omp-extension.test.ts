import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { registerOmpExtension, parseBootstrap, type OmpExtensionOptions } from "../src/runtime/omp/extension.ts";
import { discoverOmp, prepareOmpLaunch, parseOmpVersion } from "../src/runtime/omp/launcher.ts";
import { connectOmp } from "../src/runtime/omp/client.ts";
import type { OmpContext } from "../src/runtime/omp/server.ts";
import { durableJson } from "../src/runtime/omp/receipts.ts";
import { ompFixture } from "./fixtures/omp.ts";

function extensionFixture() {
  const f = ompFixture(); f.transcript([]);
  const handlers = new Map<string, (event: any, context: OmpContext) => unknown>(); const tools: any[] = [];
  const ctx: OmpContext = { mode: "tui", agent: { kind: "main" }, cwd: f.directory, model: { id: "test", provider: "fixture" },
    sessionManager: { getSessionId: () => f.identity.sessionId, getSessionFile: () => f.identity.sessionFile, getLeafId: () => null, ensureOnDisk: async () => {} },
    isIdle: () => true, hasPendingMessages: () => false, getAsyncJobSnapshot: () => null, getPendingPlanReview: () => undefined, abort: () => {}, shutdown: () => {},
  };
  const api = { pi: { VERSION: "18.15.0" }, on: (event: string, handler: (event: any, context: OmpContext) => unknown) => handlers.set(event, handler), registerTool: (tool: unknown) => tools.push(tool),
    sendUserMessage: () => {}, getThinkingLevel: () => "medium" };
  const actualPane = { pane_id: f.identity.paneId, terminal_id: f.identity.terminalId, agent: "omp", cwd: f.directory,
    agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: f.identity.sessionFile } };
  const options: OmpExtensionOptions = { env: { IYEN_OMP_REGISTRY_DIR: f.directory, HERDR_PANE_ID: f.identity.paneId }, timeoutMs: 200, herdrPane: async () => actualPane };
  const event = (name: string) => handlers.get(name)?.({ type: name }, ctx);
  return { ...f, ctx, api, options, actualPane, handlers, tools, event,
    cleanup: () => { event("session_shutdown"); f.cleanup(); },
    async ready() { for (let attempt = 0; attempt < 100; attempt++) { if (readdirSync(f.directory).some(name => /^[a-f0-9]{64}\.json$/.test(name))) return; await Bun.sleep(5); } throw new Error("Controller descriptor not published"); },
  };
}
test("extension waits for exact Herdr path association without blocking SessionStart, then authenticates inspect", async () => {
  const f = extensionFixture(); let associated = false;
  f.options.herdrPane = async () => associated ? f.actualPane : { ...f.actualPane, agent_session: undefined };
  try {
    await registerOmpExtension(f.api, f.options);
    expect(f.event("session_start")).toBeUndefined(); await Bun.sleep(15);
    expect(readdirSync(f.directory).some(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(false);
    associated = true; await f.ready();
    const [target] = await discoverOmp(f.directory); expect(target?.sessionFile).toBe(f.identity.sessionFile);
    const client = await connectOmp(target!);
    try { const snapshot = await client.inspect(); expect(snapshot.capabilities.input).toBe(true); expect(snapshot.identity.terminalId).toBe(f.identity.terminalId);
      f.actualPane.agent_session.source = "wrong-source"; await expect(client.inspect()).rejects.toThrow("association-mismatch");
    } finally { client.close(); }
  } finally { f.cleanup(); }
});
test("extension does not register borrowed service tools or publish subagent controllers", async () => {
  const f = extensionFixture(); f.ctx.agent.kind = "sub";
  try { await registerOmpExtension(f.api, f.options); f.event("session_start"); await Bun.sleep(10);
    expect(f.tools).toHaveLength(0); expect(await discoverOmp(f.directory)).toEqual([]);
  } finally { f.cleanup(); }
});
test("extension switch immediately revokes old socket and descriptor", async () => {
  const f = extensionFixture();
  try {
    await registerOmpExtension(f.api, f.options); f.event("session_start"); await f.ready();
    const [target] = await discoverOmp(f.directory), client = await connectOmp(target!);
    try { f.event("session_before_switch"); await expect(client.inspect()).rejects.toThrow("unknown"); expect(await discoverOmp(f.directory)).toEqual([]); }
    finally { client.close(); }
  } finally { f.cleanup(); }
});
test("managed bootstrap requires scoped service paths and blocks all native subagent spawning", async () => {
  const f = extensionFixture();
  const bootstrap = { protocol: 1, registryDir: f.directory, role: "managed-lane", laneKey: "worker", expectedCwd: f.directory, expectedPaneId: f.identity.paneId, expectedTerminalId: f.identity.terminalId };
  try {
    expect(() => parseBootstrap(bootstrap)).toThrow("scoped service paths");
    const service = { contextFile: "/context", configFile: "/config", stateDir: "/state", cliPath: "/cli", bunBinary: "/bun" };
    const file = join(f.directory, "bootstrap.json"); durableJson(file, { ...bootstrap, service });
    f.options.env = { IYEN_OMP_BOOTSTRAP: file, HERDR_PANE_ID: f.identity.paneId };
    await registerOmpExtension(f.api, f.options);
    expect(f.event("before_subagent_spawn")).toEqual({ block: true, reason: "Managed Iyen lanes cannot spawn native subagents" });
    expect(f.tools.map(tool => tool.name)).toEqual(["iyen_control"]);
    expect(f.event("tool_call")).toEqual({ block: true, reason: "Iyen managed runtime is held or unavailable" });
  } finally { f.cleanup(); }
});
test("OMP launch specification uses supported explicit flags and exact file resume, never restore", () => {
  const options = { binary: "/bin/omp", registryDir: "/registry", bootstrapFile: "/bootstrap", extensionPath: "/extension.ts", cwd: "/workspace", provider: "fixture", model: "test", effort: "medium", approvalMode: "always-ask" as const, resumeSessionFile: "/session.jsonl", env: { HERDR_PANE_ID: "pane" } };
  const launch = prepareOmpLaunch(options);
  expect(launch.argv).toEqual(["/bin/omp", "--model", "fixture/test", "--thinking", "medium", "--approval-mode", "always-ask", "--extension", "/extension.ts", "--resume", "/session.jsonl"]);
  expect(prepareOmpLaunch({ ...options, provider: "iyen-fixture" }).argv.slice(1, 3)).toEqual(["--model", "iyen-fixture/test"]);
  expect(prepareOmpLaunch({ ...options, provider: "openrouter", model: "anthropic/claude" }).argv.slice(1, 3)).toEqual(["--model", "openrouter/anthropic/claude"]);
  expect(() => prepareOmpLaunch({ ...options, model: "fixture/test" })).toThrow("duplicate configured provider prefix");
  expect(launch.env.HERDR_PANE_ID).toBe("pane"); expect(launch.env.IYEN_OMP_BOOTSTRAP).toBe("/bootstrap");
  expect(() => prepareOmpLaunch({ ...options, resumeSessionFile: "latest" })).toThrow("absolute paths");
  expect(parseOmpVersion("18.15.0\n")).toBe("18.15.0"); expect(() => parseOmpVersion("prefix 18.15.0 trailing")).toThrow("Expected OMP");
});
