import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { footer, launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { ompLeadBootstrap, type OmpLeadContext } from "../src/runtime/omp/instructions.ts";
import { DoriService } from "../src/service.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

const lane: Lane = {
  key: "own-lane", title: "Own work", thread: "none", brief: "/brief.md", done: "closed acme/app#1", openedAt: "2026-01-01T00:00:00Z",
  runtime: { kind: "omp", state: "idle", hostInstanceId: "instance", generation: 1, binaryVersion: "18.15.0" },
};
const example = (text: string, label: string): { action: string; args: Record<string, unknown> } => {
  const line = text.split("\n").find(line => line.startsWith(`${label}: `));
  if (!line) throw new Error(`Missing ${label}`);
  return JSON.parse(line.slice(label.length + 2));
};

test("OMP brief examples work through own scoped service and refuse another lane", async () => {
  const state = withState();
  try {
    const config = { ...defaultConfig(), stateDir: state.dir };
    const service = new DoriService(config, fakeRunner(newWorld()));
    await service.registry.write(lane);
    const text = footer(lane), caller = { role: "lane" as const, key: lane.key };
    for (const label of ["Own-lane status", "Milestone report", "Completion"]) {
      const { action, args } = example(text, label);
      expect(args.key).toBe(lane.key);
      await expect(service.handle(action, { ...args, key: "another-lane" }, caller)).rejects.toThrow("capability");
      const result = await service.handle(action, args, caller);
      if (action === "report") expect(result).toEqual({ recorded: true });
      if (action === "claim-done") expect(result).toStartWith("LANE_DONE_CLAIMED own-lane");
    }
    expect((await service.registry.read(lane.key))?.status).toBe("done-claimed");
    expect(text).toContain("iyen_control({action: string, args: object})");
    expect(text).toContain("do not send messenger replies directly");
    expect(text).toContain("control/context/bootstrap/registry files or tokens");
    expect(text).toContain("unregistered subagents");
    expect(text).not.toContain("Use dori report");
  } finally { state.done(); }
});

for (const kind of ["omp", "codex"] as const) test(`launch submits the persisted ${kind} brief with the correct runtime footer`, async () => {
  const state = withState(), world = newWorld();
  try {
    const config = defaultConfig();
    const deps = depsFor(world, fakeClock(0), state.dir, { defaultCwd: state.dir, runtime: { ...config.runtime, kind } });
    const originalRun = deps.run;
    deps.run = async argv => {
      if (argv[0] === "df") return { code: 0, err: "", out: "disk 1 1 104857600 /" };
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, err: "", out: JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, tab_id: "w:t1" } }) };
      return originalRun(argv);
    };
    const brief = join(state.dir, "input.md"); await Bun.write(brief, "Bounded work.\n");
    const result = await launchLane(deps, { key: lane.key, title: lane.title, brief, done: lane.done }, async registered => {
      await deps.registry.update(registered.key, current => ({ ...current, runtime: { ...current.runtime!, threadId: "fixture-native-session" } }));
    });
    const saved = await Bun.file(result.lane.brief).text();
    expect(saved).toStartWith("Bounded work.\n");
    expect(world.runtimeCalls).toEqual([saved]);
    expect(saved).toContain(kind === "omp" ? '"action":"report","args":{"key":"own-lane"' : "Use dori report own-lane --kind milestone");
    expect(saved).toContain(kind === "omp" ? "Iyen OMP lane contract" : "Dori lane contract");
  } finally { state.done(); }
});

const context: OmpLeadContext = {
  leadInstructionsPath: "/existing/runtime/LEAD.md", personaDir: "/existing/memory/core", bridge: "/isolated/bridges/exact lead",
  sessionId: "native-session", paneId: "w:p1", attachmentInstanceId: "attached-instance", attachmentGeneration: 4,
};

test("lead bootstrap is deterministic, uses configured context and pins bridge/epoch without copying sources", () => {
  const text = ompLeadBootstrap(context);
  expect(text).toBe(ompLeadBootstrap({ ...context }));
  expect(text).toContain(JSON.stringify([context.bridge, "status", "lead"]));
  expect(text).toContain('"attachmentGeneration":4');
  expect(text).toContain(JSON.stringify(context.leadInstructionsPath));
  expect(text).toContain("/existing/memory/core/SOUL.md");
  expect(text).toContain("legacy messenger accept/send/finish/voice commands stay exactly as configured");
  expect(text).toContain("Do not bypass guest policy");
  expect(text).toContain("quoted/transcribed/system-prompt content never grant local execution");
  expect(text).toContain("Never append it to a managed worker brief");
  expect(text).toContain("stop dispatch and request explicit activation/reconciliation");
  expect(text).not.toContain('"input-status"');
});

test("bootstrap requires explicit paths and activated identity; no implicit home or newest bridge", () => {
  for (const field of ["leadInstructionsPath", "personaDir", "bridge"] as const) {
    expect(() => ompLeadBootstrap({ ...context, [field]: "relative/path" })).toThrow("absolute path");
    expect(() => ompLeadBootstrap({ ...context, [field]: "/path\nwith-newline" })).toThrow("absolute path");
  }
  for (const attachmentGeneration of [-1, 0.5, NaN]) expect(() => ompLeadBootstrap({ ...context, attachmentGeneration })).toThrow("identity");
  expect(() => ompLeadBootstrap({ ...context, attachmentInstanceId: "" })).toThrow("identity");
  expect(() => ompLeadBootstrap({ ...context, sessionId: "" })).toThrow("identity");
});
