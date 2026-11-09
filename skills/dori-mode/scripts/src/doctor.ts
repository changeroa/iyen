import { existsSync, lstatSync } from "node:fs";
import type { DoriConfig } from "./config.ts";
import { run } from "./run.ts";
import { connectOmp } from "./runtime/omp/client.ts";
import { discoverOmpSafe, ompProfileEnvironment, ompVersionMatches, verifyOmpHerdr } from "./runtime/omp-integration.ts";
import { startCodex } from "./runtime/codex.ts";
export const doctor = async (config: DoriConfig): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> => {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  if (config.runtime.kind === "omp") {
    const binary = await run([config.runtime.binary, "--version"], { timeoutMs: 10000, env: ompProfileEnvironment(config.runtime.settingsHome!) });
    checks.push({ name: "omp", ok: binary.code === 0 && ompVersionMatches(binary.out, config.runtime.requiredVersion), detail: `requires ${config.runtime.requiredVersion}` });
    const bun = (process.versions.bun ?? "0.0.0").split(".").map(Number);
    checks.push({ name: "bun", ok: bun[0]! > 1 || bun[0] === 1 && (bun[1]! > 4 || bun[1] === 4 && bun[2]! >= 4), detail: `running ${process.versions.bun ?? "unavailable"}; OMP requires tested Bun >=1.4.4` });
    const omp = config.runtime.omp;
    checks.push({ name: "policy", ok: config.runtime.sandbox === "danger-full-access" && !!omp?.approvalMode, detail: "OMP has no Codex OS sandbox; explicit approvalMode and isolated unsandboxed profile required" });
    checks.push({ name: "extension", ok: !!omp && existsSync(omp.extensionPath), detail: "Explicit Iyen control extension must be loaded in the existing TUI; no automatic injection" });
    try {
      const st = lstatSync(omp!.registryDir);
      checks.push({ name: "registry", ok: st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0, detail: "private owner-only controller registry" });
      const targets = await discoverOmpSafe(omp!.registryDir);
      checks.push({ name: "controllers", ok: targets.length > 0, detail: targets.length ? `${targets.length} descriptors; each authenticated below` : "No controller; explicitly load extension in main OMP TUI with IYEN_OMP_REGISTRY_DIR" });
      for (const target of targets.filter(target => target.role === "attached-lead")) {
        let c;
        try {
          await verifyOmpHerdr(target); c = await connectOmp(target, { timeoutMs: config.runtime.rpcTimeoutMs });
          const snap = await c.inspect();
          checks.push({ name: `${target.laneKey}:identity`, ok: target.runtimeVersion === config.runtime.requiredVersion, detail: "authenticated native session/file/pane/terminal/generation" });
          checks.push({ name: `${target.laneKey}:receipts`, ok: snap.capabilities.durableReceipts && snap.capabilities.input, detail: "durable transcript receipt storage" });
          checks.push({ name: `${target.laneKey}:interactions`, ok: snap.capabilities.interactions === true, detail: "native userInteractions list/respond/responseStatus capability required; local-only SDK is not relay-ready" });
          checks.push({ name: `${target.laneKey}:model`, ok: true, detail: `${snap.provider}/${snap.model}; effort ${snap.effort ?? "unavailable"}` });
          checks.push({ name: `${target.laneKey}:control`, ok: true, detail: "borrowed lead inspect/input/interactions; detach does not stop TUI" });
        } catch { checks.push({ name: `${target.laneKey}:controller`, ok: false, detail: "Exact live OMP identity/capabilities unavailable" }); }
        finally { c?.close(); }
      }
    } catch { checks.push({ name: "registry", ok: false, detail: "Registry missing or unsafe; explicitly configure/load the control extension" }); }
    return { ok: checks.every(c => c.ok), checks };
  }
  for (const [name, argv] of [["codex", [config.runtime.binary, "--version"]], ["herdr", ["herdr", "--version"]], ["git", ["git", "--version"]], ["gh", ["gh", "--version"]]] as const) {
    const result = await run(argv, { timeoutMs: 10000 });
    checks.push({ name, ok: result.code === 0 && (name !== "codex" || result.out === `codex-cli ${config.runtime.requiredVersion}`), detail: name === "codex" ? `requires ${config.runtime.requiredVersion}` : result.code === 0 ? "available" : "unavailable" });
  }
  checks.push({ name: "cwd", ok: existsSync(config.defaultCwd), detail: "configured working directory" });
  try {
    const runtime = await startCodex(config.runtime);
    try {
      const models = await runtime.session.models();
      for (const [role, selected] of Object.entries(config.runtime.roles)) {
        const model = selected.model ? models.find(m => m.id === selected.model || m.model === selected.model) : models.find(m => m.isDefault);
        checks.push({ name: `model:${role}`, ok: !!model && (!selected.effort || model.supportedReasoningEfforts.some(e => e.reasoningEffort === selected.effort)), detail: selected.model ?? "Codex default" });
      }
      const account: any = await runtime.session.rpc.request("account/read", { refreshToken: false });
      checks.push({ name: "authentication", ok: account.account !== null || account.requiresOpenaiAuth === false, detail: account.account ? "configured" : "login may be required" });
    } finally { runtime.close(); await runtime.exited; }
  } catch { checks.push({ name: "protocol", ok: false, detail: "initialization or model catalog unavailable" }); }
  return { ok: checks.every(c => c.ok), checks };
};
