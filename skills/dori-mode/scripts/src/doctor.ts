import { existsSync } from "node:fs";
import type { DoriConfig } from "./config.ts";
import { run } from "./run.ts";
import { startCodex } from "./runtime/codex.ts";
export const doctor = async (config: DoriConfig): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> => {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
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
