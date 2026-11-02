import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { OmpError, assertIdentity, exactKeys, identityOf, nonempty, object, payloadHash, type OmpTarget } from "./contract.ts";
export type OmpLaunchOptions = {
  binary: string; registryDir: string; bootstrapFile: string; extensionPath: string; cwd: string;
  provider: string; model: string; effort: string; approvalMode: "always-ask" | "always-ask-cached" | "yolo";
  resumeSessionFile?: string; env?: Record<string, string>;
};
export type OmpLaunchSpec = { argv: string[]; env: Record<string, string>; cwd: string };
export function prepareOmpLaunch(options: OmpLaunchOptions): OmpLaunchSpec {
  for (const path of [options.binary, options.registryDir, options.bootstrapFile, options.extensionPath, options.cwd, ...(options.resumeSessionFile ? [options.resumeSessionFile] : [])]) {
    if (!nonempty(path) || !isAbsolute(path)) throw new OmpError("invalid-launch", "OMP launch paths must be explicit absolute paths", false);
  }
  if (![options.provider, options.model, options.effort].every(value => nonempty(value) && !value.startsWith("-")) ||
    !["always-ask", "always-ask-cached", "yolo"].includes(options.approvalMode) ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].includes(options.effort)) throw new OmpError("invalid-launch", "Invalid explicit OMP model, effort or approval mode", false);
  if (options.provider.includes("/") || /\s/.test(options.provider) || options.model.startsWith(`${options.provider}/`)) throw new OmpError("invalid-launch", "OMP model must be the native model ID without a duplicate configured provider prefix", false);
  if (options.resumeSessionFile && !options.resumeSessionFile.endsWith(".jsonl")) throw new OmpError("invalid-launch", "OMP resume requires an exact JSONL session file", false);
  // Qualified model selectors are deferred until extension providers have registered.
  // Native model IDs may themselves contain slashes; never strip or infer a provider from them.
  return { argv: [options.binary, "--model", `${options.provider}/${options.model}`, "--thinking", options.effort, "--approval-mode", options.approvalMode,
    "--extension", options.extensionPath, ...(options.resumeSessionFile ? ["--resume", options.resumeSessionFile] : [])],
    env: { ...options.env, IYEN_OMP_BOOTSTRAP: options.bootstrapFile, IYEN_OMP_REGISTRY_DIR: options.registryDir }, cwd: options.cwd };
}
export function parseOmpVersion(output: string): string {
  const match = /^(?:omp )?(\d+\.\d+\.\d+)\s*$/.exec(output);
  if (!match || match[1] !== "18.15.0") throw new OmpError("runtime-version-unsupported", "Expected OMP 18.15.0", false);
  return match[1];
}
/** Read-only registry enumeration. Descriptors never establish liveness or routing authority. */
export async function discoverOmp(registryDir: string): Promise<OmpTarget[]> {
  if (!isAbsolute(registryDir) || realpathSync(registryDir) !== registryDir) throw new OmpError("unsafe-registry", "OMP registry must be a canonical absolute directory", false);
  const directory = lstatSync(registryDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new OmpError("unsafe-registry", "OMP registry must be private and user-owned", false);
  const names = readdirSync(registryDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  if (names.length > 1024) throw new OmpError("registry-limit", "OMP registry enumeration limit exceeded", false);
  const targets: OmpTarget[] = [];
  for (const name of names) {
    const fd = openSync(join(registryDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > 65536) throw new Error("Unsafe descriptor");
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!object(value) || !exactKeys(value, ["kind", "protocol", "sessionId", "sessionFile", "cwd", "paneId", "terminalId", "instanceId", "generation", "role", "laneKey", "runtimeVersion", "socketPath", "tokenFile", "pid", "startedAt"]) ||
        !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || !nonempty(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt)) ||
        !nonempty(value.socketPath) || !isAbsolute(value.socketPath) || !nonempty(value.tokenFile) || !isAbsolute(value.tokenFile)) throw new Error("Invalid descriptor");
      const target = value as unknown as OmpTarget;
      assertIdentity(identityOf(target));
      if (name !== `${payloadHash(`${target.instanceId}:${target.generation}`)}.json`) throw new Error("Descriptor filename mismatch");
      // A dead PID cannot be attached. A live/reused PID is still not proof: caller must authenticate inspect.
      try { process.kill(value.pid as number, 0); } catch { continue; }
      if (!lstatSync(target.socketPath).isSocket()) continue;
      targets.push({ ...identityOf(target), socketPath: target.socketPath, tokenFile: target.tokenFile });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new OmpError("invalid-descriptor", "OMP registry descriptor cannot be verified", false);
    } finally { closeSync(fd); }
  }
  const sessions = new Set<string>();
  for (const target of targets) {
    if (sessions.has(target.sessionFile)) throw new OmpError("ambiguous-controller", "Multiple live OMP controllers claim one session file", false);
    sessions.add(target.sessionFile);
  }
  return targets;
}
