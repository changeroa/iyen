import { chmod, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export const credentialsPath = (home = homedir()): string => join(home, ".dori", "credentials.json");

const readAll = async (home: string): Promise<Record<string, string>> => {
  const file = Bun.file(credentialsPath(home));
  if (!(await file.exists())) return {};
  const parsed: unknown = await file.json();
  if (typeof parsed !== "object" || parsed === null) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

/**
 * Tokens live per user, not per shell: a restart in another directory must find them, or Dori reads
 * "token not set" as "setup not done" and asks to onboard again (#14). The environment still wins.
 */
export const readCredential = async (name: string, options: { home?: string; env?: Env } = {}): Promise<string | undefined> => {
  const value = (options.env ?? process.env)[name];
  if (value !== undefined && value !== "") return value;
  return (await readAll(options.home ?? homedir()))[name];
};

export const saveCredential = async (name: string, value: string, options: { home?: string } = {}): Promise<void> => {
  const home = options.home ?? homedir();
  const path = credentialsPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = { ...(await readAll(home)), [name]: value };
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};
