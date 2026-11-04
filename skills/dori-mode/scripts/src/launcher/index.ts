import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireFileFence } from "../binding-fence.ts";
import { atomicJson } from "../journal.ts";
import { readJson, serviceClient } from "../ipc.ts";
import { run, type Runner } from "../run.ts";
import { ompLeadBootstrap } from "../runtime/omp/instructions.ts";
import { operationText } from "../runtime/herdr.ts";
import { discoverExternal } from "../runtime/external-current-session.ts";
import { connectObserver, receipt } from "../runtime/observer.ts";
import { assertOperator, selectProfile, type Kind, type Selection } from "./profiles.ts";
import { ensureService, health, assertServiceReady } from "./service.ts";
import { nativeLead, preflight, selectPane, type Identity, type LaunchRecord } from "./native.ts";
export type Options = { registry?: string; config?: string; model?: string; effort?: string; noSwitch?: boolean };
export const identityOfLead = (lead: any): Identity | undefined => lead?.runtime?.threadId ? {
  threadId: lead.runtime.threadId, pane: lead.pane, cwd: lead.cwd,
  ...(lead.runtime.omp?.target ? { sessionFile: lead.runtime.omp.target.sessionFile, terminalId: lead.runtime.omp.target.terminalId } : {}),
} : undefined;
export function effectiveRole(config: Selection["config"], lead: any, options: Options) {
  const model = options.model ?? lead?.runtime?.model ?? config.runtime.roles.lead.model;
  const effort = options.effort ?? lead?.runtime?.effort ?? config.runtime.roles.lead.effort;
  if (!model || !effort) throw new Error("Explicit lead model and effort required (CLI, saved effective lead, or runtime.roles.lead)");
  if (typeof model !== "string" || /[\r\n\0]/.test(model) || model.startsWith("-") || config.runtime.kind === "codex" && model.includes("/")) throw new Error("Invalid native model ID");
  const efforts = config.runtime.kind === "omp" ? ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (!efforts.includes(effort)) throw new Error("Invalid native reasoning effort");
  return { model, effort };
}
export function assertLeadResumable(lead: any) {
  if (lead && (lead.status !== "working" || ["owner-pause", "done-review"].includes(lead.holdReason) || lead.runtime?.held && lead.holdReason !== "recovery" || lead.leadRestart && lead.leadRestart.phase !== "released")) throw new Error("Lead is paused, done, or restarting; explicit owner reconciliation required");
}
export type Dependencies = {
  runner: Runner;
  preflight: typeof preflight;
  ensureService: typeof ensureService;
  selectPane: typeof selectPane;
  nativeLead: typeof nativeLead;
  call: (selection: Selection, action: string, args?: any) => Promise<any>;
  checkTarget: (config: Selection["config"], saved: Identity | undefined, record: LaunchRecord, runner: Runner) => Promise<void>;
  ready: (selection: Selection) => Promise<void>;
};
const defaults: Dependencies = {
  runner: run, preflight, ensureService, selectPane, nativeLead,
  checkTarget: async (config, saved, record, runner) => { await selectPane(config, saved, record, runner, () => {}, true); },
  call: (selection, action, args) => serviceClient(selection.config)(action, args),
  ready: async selection => assertServiceReady(selection.config, await health(selection.config)),
};
export async function launch(kind: Kind, options: Options = {}, overrides: Partial<Dependencies> = {}) {
  assertOperator();
  const selection = await selectProfile(kind, options), deps = { ...defaults, ...overrides };
  const release = await acquireFileFence(join(dirname(selection.registryPath), "launch.lock"), 5000);
  try {
    const releaseState = await acquireFileFence(join(selection.config.stateDir, "launcher", "launch.lock"), 5000);
    try { return await launchLocked(selection, options, deps); } finally { await releaseState(); }
  } finally { await release(); }
}
export async function launchLocked(selection: Selection, options: Options, deps: Dependencies) {
  const { config, kind } = selection, path = join(config.stateDir, "launcher", "launch.json");
  const savedPath = join(config.stateDir, "lanes", "lead.json");
  const priorRecord = existsSync(path) ? readJson<LaunchRecord>(path) : undefined;
  const localLead = existsSync(savedPath) ? readJson<any>(savedPath) : undefined;
  assertLeadResumable(localLead);
  const savedHealthPath = join(config.stateDir, "service-health.json");
  if (existsSync(savedHealthPath)) {
    const priorHealth = readJson<any>(savedHealthPath);
    if (priorHealth.restart || priorHealth.delivery?.handoffPending && !priorRecord?.attachmentRequest) throw new Error("Target has unresolved restart or handoff; reconcile before switching receivers");
  }
  const initialRole = effectiveRole(config, localLead, options);
  const effectiveConfig = { ...config, runtime: { ...config.runtime, roles: { ...config.runtime.roles, lead: initialRole } } };
  if (selection.profile.leadInstructionsPath && !existsSync(selection.profile.leadInstructionsPath)) throw new Error("Configured leadInstructionsPath missing");
  await deps.preflight(effectiveConfig, deps.runner);
  const previewRecord: LaunchRecord = priorRecord && priorRecord.phase !== "ready" ? { ...priorRecord } : { version: 1, operationId: "preflight", configPath: selection.profile.configPath, phase: "prepared", cwd: realpathSync(localLead?.cwd ?? config.defaultCwd), ...initialRole, ...(identityOfLead(localLead) ? { pane: localLead.pane, terminalId: localLead.runtime?.omp?.target?.terminalId } : {}) };
  await deps.checkTarget(config, identityOfLead(localLead), previewRecord, deps.runner);
  await deps.ensureService(selection, Boolean(options.noSwitch), deps.runner);
  await deps.ready(selection);
  const all = await deps.call(selection, "status");
  if (!Array.isArray(all)) throw new Error("Public service status unavailable");
  let lead = all.find((lane: any) => lane.key === "lead");
  if (lead && (lead.runtime?.kind !== kind || lead.runtime?.backend !== "external-current-session")) throw new Error("Existing lead is not the requested native external session");
  assertLeadResumable(lead);
  const role = effectiveRole(config, lead, options), saved = identityOfLead(lead);
  let record: LaunchRecord | undefined = existsSync(path) ? readJson<LaunchRecord>(path) : undefined;
  if (record && (record.version !== 1 || record.configPath !== selection.profile.configPath)) throw new Error("Launch journal profile identity mismatch");
  const unfinished = record && record.phase !== "ready";
  if (unfinished && (record!.model !== role.model || record!.effort !== role.effort || saved && record!.identity && saved.threadId !== record!.identity.threadId)) throw new Error("Pending launcher identity/model changed; reconcile its durable intent first");
  const reused = Boolean(lead?.identityVerified && !lead?.dispatchBlocked);
  if (!unfinished) record = { version: 1, operationId: crypto.randomUUID(), configPath: selection.profile.configPath, phase: "prepared", initialize: !reused, cwd: realpathSync(saved?.cwd ?? config.defaultCwd), ...role,
    ...(saved ? { identity: saved, pane: saved.pane, terminalId: saved.terminalId } : {}) };
  const current = record!;
  const persist = () => atomicJson(path, current);
  persist();
  const pane = await deps.selectPane(config, saved ?? current.identity, current, deps.runner, persist);
  const identity = await deps.nativeLead(config, saved ?? current.identity, current, pane.occupied, deps.runner, persist);
  current.identity = identity; current.phase = current.phase === "attached" ? "attached" : "native-ready"; persist();
  if (current.attachmentRequest && !current.attachmentRequest.completed || !lead || !lead.identityVerified || lead.pane !== identity.pane || kind === "omp" && !reused) {
    if (!current.attachmentRequest) {
      const args = { threadId: identity.threadId, pane: identity.pane, cwd: identity.cwd,
        ...(kind === "omp" ? { sessionFile: identity.sessionFile, terminalId: identity.terminalId } : {}),
        ...(lead ? { operationId: `launcher:${current.operationId}`, expectedInstance: lead.runtime.hostInstanceId, expectedGeneration: lead.runtime.generation, expectedRevision: lead.revision } : {}) };
      current.attachmentRequest = { action: lead ? "lead-reconnect" : "lead-activate", args };
      // This obligation survives a response lost after the service committed.
      current.initialize = true; persist();
    }
    const request = current.attachmentRequest;
    const result = await deps.call(selection, request.action, request.args);
    if (!result.attached || !result.lead) throw new Error("Attachment outcome unconfirmed; retry same durable launcher intent");
    lead = result.lead;
    request.completed = true;
    current.attachment = { instance: lead.runtime.hostInstanceId, generation: lead.runtime.generation };
    persist();
  }
  if (!lead.identityVerified || lead.runtime?.threadId !== identity.threadId || lead.pane !== identity.pane || realpathSync(lead.cwd) !== identity.cwd || !lead.bridge) throw new Error("Activated public native identity mismatch");
  if (current.bootstrap && current.attachment && (current.attachment.instance !== lead.runtime.hostInstanceId || current.attachment.generation !== lead.runtime.generation)) throw new Error("Bootstrap attachment epoch changed; reconcile initialization without replay");
  current.attachment = { instance: lead.runtime.hostInstanceId, generation: lead.runtime.generation };
  current.phase = "attached"; persist();
  // Existing bound native leads already know their bridge. A new generation or
  // an unfinished initialization gets one stable, receipt-reconciled bootstrap.
  if (current.initialize || current.bootstrap) await initialize(selection, lead, current, persist, deps.runner);
  const finalLead = await deps.call(selection, "status", { key: "lead" });
  if (!finalLead.identityVerified || finalLead.runtime?.threadId !== identity.threadId || finalLead.runtime.hostInstanceId !== lead.runtime.hostInstanceId || finalLead.runtime.generation !== lead.runtime.generation || finalLead.pane !== identity.pane || finalLead.dispatchBlocked || finalLead.runtime.held) throw new Error("Final attachment changed or held; readiness unconfirmed");
  await deps.ready(selection);
  current.phase = "ready"; current.attachment = { instance: finalLead.runtime.hostInstanceId, generation: finalLead.runtime.generation }; persist();
  return { ready: true, runtime: kind, threadId: identity.threadId, pane: identity.pane, bridge: finalLead.bridge, inputReady: finalLead.inputReady, reused, bootstrap: current.bootstrap?.phase ?? "existing" };
}
async function initialize(selection: Selection, lead: any, record: LaunchRecord, persist: () => void, runner: Runner) {
  if (!record.bootstrap) {
    if (!lead.inputReady) throw new Error("Native lead input is not ready; bootstrap not submitted");
    const skillPath = resolve(import.meta.dir, "../../../../iyen/SKILL.md");
    const instructions = selection.profile.leadInstructionsPath ?? skillPath;
    if (!existsSync(instructions) || !existsSync(skillPath)) throw new Error("Configured lead instructions or Iyen skill file missing");
    const context = ompLeadBootstrap({ leadInstructionsPath: instructions, personaDir: selection.config.personaDir!, bridge: lead.bridge,
      sessionId: lead.runtime.threadId, paneId: lead.pane, attachmentInstanceId: lead.runtime.hostInstanceId, attachmentGeneration: lead.runtime.generation });
    const routing = `Read the Iyen skill at ${JSON.stringify(skillPath)}. Do not send an unsolicited activation or startup messenger message. Only reply to actual incoming messages under the configured policy.\n`;
    const text = routing + (selection.kind === "omp" ? context : `# Iyen native Codex lead\nRead and apply the Iyen skill at ${JSON.stringify(resolve(import.meta.dir, "../../../../iyen/SKILL.md"))}. This exact native conversation is already attached; do not activate a replacement.\n${context.replace("# Iyen OMP lead compatibility bootstrap", "# Iyen lead operating context")}`);
    record.bootstrap = { operationId: `launcher-bootstrap:${lead.runtime.hostInstanceId}:${lead.runtime.generation}`, text, phase: "sending" }; persist();
    const textPath = join(selection.config.stateDir, "launcher", `${record.operationId}.instructions.txt`);
    await Bun.write(textPath, text); // no credentials: only the scoped bridge and identity
    const result = await runner([lead.bridge, "input", "lead", "--text-file", textPath, "--operation-id", record.bootstrap.operationId], { timeoutMs: selection.config.runtime.startupTimeoutMs });
    if (!result.code) {
      const value = JSON.parse(result.out);
      if (value.turnId) { record.bootstrap.phase = "received"; persist(); return; }
    }
  }
  if (record.bootstrap.phase === "received") return;
  const boot = record.bootstrap;
  if (selection.kind === "omp") {
    const textPath = join(selection.config.stateDir, "launcher", `${record.operationId}.instructions.txt`);
    await Bun.write(textPath, boot.text);
    const result = await runner([lead.bridge, "input-status", "lead", "--text-file", textPath, "--operation-id", boot.operationId]);
    if (!result.code && JSON.parse(result.out).status === "received") { boot.phase = "received"; persist(); return; }
  } else {
    const daemon = await discoverExternal(runner, selection.config.runtime), observer = await connectObserver(daemon.socketPath, selection.config.runtime.rpcTimeoutMs);
    try { if (await receipt(observer, lead.runtime.threadId, operationText(boot.text, boot.operationId))) { boot.phase = "received"; persist(); return; } } finally { observer.close(); }
  }
  throw new Error("Bootstrap input outcome unknown; journal retained for receipt reconciliation, no prompt replay");
}
