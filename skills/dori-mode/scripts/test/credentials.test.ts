import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentialsPath, readCredential, saveCredential } from "../src/credentials.ts";
import { readSetupRecord, saveSetupRecord } from "../src/setup-record.ts";

const homes: string[] = [];
const freshHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-home-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("a token saved during setup is found from a new shell with the variable unset (#14)", async () => {
  const home = freshHome();
  await saveCredential("DORI_SLACK_TOKEN", "xoxb-saved", { home });

  expect(await readCredential("DORI_SLACK_TOKEN", { home, env: {} })).toBe("xoxb-saved");
});

test("the credentials file is private to the owner", async () => {
  const home = freshHome();
  await saveCredential("DORI_SLACK_TOKEN", "xoxb-saved", { home });

  expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
});

test("a variable set in the environment still wins over the saved credential", async () => {
  const home = freshHome();
  await saveCredential("DORI_SLACK_TOKEN", "xoxb-saved", { home });

  expect(await readCredential("DORI_SLACK_TOKEN", { home, env: { DORI_SLACK_TOKEN: "xoxb-env" } })).toBe("xoxb-env");
});

test("saving a second credential keeps the first", async () => {
  const home = freshHome();
  await saveCredential("DORI_SLACK_TOKEN", "xoxb-saved", { home });
  await saveCredential("DORI_SLACK_COOKIE", "cookie", { home });

  expect(await readCredential("DORI_SLACK_TOKEN", { home, env: {} })).toBe("xoxb-saved");
  expect(await readCredential("DORI_SLACK_COOKIE", { home, env: {} })).toBe("cookie");
});

test("a missing credential reads as undefined", async () => {
  expect(await readCredential("DORI_SLACK_TOKEN", { home: freshHome(), env: {} })).toBeUndefined();
});

test("setup completion is recorded per user, so a restart in any directory sees it (#14)", async () => {
  const home = freshHome();
  expect(await readSetupRecord(home)).toBeUndefined();

  await saveSetupRecord({ name: "ShipDori", platform: "slack", onboardedAt: "2026-10-15T10:00:00Z" }, home);

  expect(await readSetupRecord(home)).toEqual({ name: "ShipDori", platform: "slack", onboardedAt: "2026-10-15T10:00:00Z" });
});
