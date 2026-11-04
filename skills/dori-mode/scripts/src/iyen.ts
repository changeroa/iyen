#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { launch } from "./launcher/index.ts";
export const help = `Usage: iyen omp|codex [--config PATH] [--registry PATH] [--no-switch] [--model ID] [--effort LEVEL] [--json]
Launch or resume the exact native Iyen lead and reconnect its scoped bridge.
Profiles: \${XDG_CONFIG_HOME:-~/.config}/iyen/launchers.json (version 1).
Automatic messenger receiver switching preserves the other runtime's TUI.
--no-switch refuses an overlapping receiver instead. No session picker or --last is used.`;
if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
      config: { type: "string" }, registry: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      "no-switch": { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } });
    if (values.help) { console.log(help); process.exit(0); }
    const kind = positionals[0];
    if (positionals.length !== 1 || kind !== "omp" && kind !== "codex") throw new Error(help);
    const result = await launch(kind, { ...values, noSwitch: values["no-switch"] });
    console.log(values.json ? JSON.stringify(result, null, 2) : `Iyen ${kind} ready: ${result.threadId} in ${result.pane}`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Launcher failed"); process.exitCode = 1; }
}
