import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SetupRecord = {
  readonly name: string;
  readonly platform: string;
  readonly onboardedAt: string;
};

export const setupRecordPath = (home = homedir()): string => join(home, ".dori", "setup.json");

/** Setup and onboarding are done once per user; this record, not the agent's per-project memory, says so (#14). */
export const readSetupRecord = async (home = homedir()): Promise<SetupRecord | undefined> => {
  const file = Bun.file(setupRecordPath(home));
  if (!(await file.exists())) return undefined;
  const parsed = (await file.json()) as Partial<SetupRecord>;
  if (typeof parsed.name !== "string" || typeof parsed.platform !== "string" || typeof parsed.onboardedAt !== "string") return undefined;
  return { name: parsed.name, platform: parsed.platform, onboardedAt: parsed.onboardedAt };
};

export const saveSetupRecord = async (record: SetupRecord, home = homedir()): Promise<void> => {
  const path = setupRecordPath(home);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
};
