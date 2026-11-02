import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { configPath, type DoriConfig } from "./config.ts";
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export const watchdogLaunchAgent = (config: DoriConfig, path = configPath(), home = homedir()) => {
  const label = "dev.iyen.delivery-watchdog-v1", destination = join(home, "Library/LaunchAgents", `${label}.plist`);
  const argumentsXml = [process.execPath, resolve(import.meta.dir, "cli.ts"), "watchdog", "loop"].map(v => `<string>${xml(v)}</string>`).join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict><key>DORI_CONFIG</key><string>${xml(resolve(path))}</string><key>DORI_STATE_DIR</key><string>${xml(config.stateDir)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
  return { version: 1, label, destination, plist };
};
export const installWatchdog = (config: DoriConfig, apply: boolean) => {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS; use watchdog loop under your process supervisor");
  const result = watchdogLaunchAgent(config);
  if (apply) { mkdirSync(dirname(result.destination), { recursive: true, mode: 0o700 }); writeFileSync(result.destination, result.plist, { mode: 0o600 }); }
  return { ...result, written: apply, activated: false, next: `launchctl bootstrap gui/${process.getuid?.()} ${JSON.stringify(result.destination)}` };
};
