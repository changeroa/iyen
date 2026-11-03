import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { watchdogLaunchAgent } from "../src/watchdog-install.ts";
test("versioned LaunchAgent pins resolved installation without session identity or secrets", () => {
  const value = watchdogLaunchAgent({ ...defaultConfig(), stateDir: "/persistent/a & b/state" }, "/persistent/a & b/config.json", "/home/test");
  expect(value.label).toBe("dev.iyen.delivery-watchdog-v1"); expect(value.destination).toBe("/home/test/Library/LaunchAgents/dev.iyen.delivery-watchdog-v1.plist");
  expect(value.plist).toContain("/persistent/a &amp; b/config.json"); expect(value.plist).toContain("<string>watchdog</string><string>loop</string>");
  expect(value.plist).not.toMatch(/token|thread-id|lead-activate|kickstart|resume/);
});
