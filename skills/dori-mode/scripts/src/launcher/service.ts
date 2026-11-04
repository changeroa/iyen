import { existsSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DoriConfig } from "../config.ts";
import { atomicJson } from "../journal.ts";
import { readJson, serviceClient } from "../ipc.ts";
import { run, type Runner } from "../run.ts";
import { overlaps, type Profile, type Selection } from "./profiles.ts";
const ownedServices = new Map<number, ReturnType<typeof Bun.spawn>>();
/** Services spawned and authenticated by this launcher, not ambient PID files. */
export const ownedServicePids = () => [...ownedServices].filter(([, child]) => child.exitCode === null && !child.signalCode).map(([pid]) => pid);
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
export async function health(config: DoriConfig): Promise<any | undefined> {
  try { return await serviceClient(config)("health", {}, 1500); }
  catch {
    const path = join(config.stateDir, "service.lock");
    if (existsSync(path) && alive(readJson<{pid:number}>(path).pid)) throw new Error(`Service ${config.stateDir} has a live owner but authentication/health is unavailable; reconcile it before switching`);
    return undefined;
  }
}
export function assertServiceReady(config: DoriConfig, status: any): void {
  const lock = readJson<{pid:number;instance:string}>(join(config.stateDir, "service.lock"));
  if (!status?.serviceReachable || status.phase !== "ready" || status.pid !== lock.pid || !alive(lock.pid)) throw new Error("Authenticated service is not ready with the exact PID/state binding");
  if (!Array.isArray(status.ingress) || config.ingress.some(source => status.ingress.filter((row: any) => row.id === source.id && row.process === "running").length !== 1)) throw new Error("Configured messenger receiver is not running");
}
export async function descendants(pid: number, runner: Runner): Promise<number[]> {
  const result = await runner(["ps", "-axo", "pid=,ppid="]);
  if (result.code) throw new Error("Cannot verify service process descendants");
  const rows = result.out.split("\n").filter(x => x.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("Ambiguous process snapshot");
    return { pid: Number(match[1]), ppid: Number(match[2]) };
  });
  const found = new Set([pid]);
  for (;;) { const before = found.size; for (const row of rows) if (found.has(row.ppid)) found.add(row.pid); if (found.size === before) return [...found]; }
}
export async function stopService(config: DoriConfig, profile: Profile, runner: Runner = run): Promise<void> {
  if (!profile.service?.stop) throw new Error(`Conflicting service ${profile.configPath} has no configured stop argv; configure its supervisor stop hook`);
  const lock = readJson<{pid:number;instance:string}>(join(config.stateDir, "service.lock"));
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !lock.instance) throw new Error("Service ownership unavailable; refusing switch");
  const pids = await descendants(lock.pid, runner);
  const result = await runner(profile.service.stop, { timeoutMs: config.runtime.startupTimeoutMs });
  if (result.code) throw new Error("Configured service stop failed; requested receiver was not started");
  const deadline = Date.now() + config.runtime.startupTimeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const stopped = pids.every(pid => !alive(pid));
    const reachable = await health(config);
    if (stopped && !reachable) {
      // A sustained quiet interval detects immediate supervisor respawn. Supervisor
      // hooks must also disable their job; we never signal launchd-owned PIDs.
      quietSince ||= Date.now();
      if (Date.now() - quietSince >= 500) {
        if (profile.service.stopped && (await runner(profile.service.stopped, { timeoutMs: config.runtime.rpcTimeoutMs })).code) throw new Error("Supervisor stopped-state verification failed");
        return;
      }
    } else quietSince = 0;
    await Bun.sleep(50);
  }
  throw new Error("Supervisor stop/child exit unconfirmed; requested receiver was not started");
}
export async function ensureService(selection: Selection, noSwitch: boolean, runner: Runner = run): Promise<void> {
  const conflicts = [];
  for (const entry of selection.registered) {
    if (resolve(entry.config.stateDir) !== resolve(selection.config.stateDir) && overlaps(selection.config, entry.config) && await health(entry.config)) conflicts.push(entry);
  }
  if (noSwitch && conflicts.length) throw new Error("Conflicting messenger receiver is running; omit --no-switch to switch using configured supervisor hooks");
  // Validate every controller before stopping any receiver.
  for (const entry of conflicts) if (!entry.profile.service?.stop) throw new Error(`Configure supervisor stop argv for ${entry.profile.configPath} before switching`);
  for (const entry of conflicts) await stopService(entry.config, entry.profile, runner);
  const existing = await health(selection.config);
  if (existing) {
    const deadline = Date.now() + selection.config.runtime.startupTimeoutMs;
    do { try { assertServiceReady(selection.config, await health(selection.config)); return; } catch { await Bun.sleep(100); } } while (Date.now() < deadline);
    throw new Error("Existing service/receiver readiness unconfirmed");
  }
  const { config, profile } = selection;
  let ownedChild: ReturnType<typeof Bun.spawn> | undefined;
  const intentPath = join(config.stateDir, "launcher-service.json");
  if (existsSync(intentPath) && readJson<any>(intentPath).phase === "starting") throw new Error("Previous service startup outcome unknown; reconcile launcher-service.json before invoking its start hook again");
  if (profile.service?.start) {
    atomicJson(intentPath, { version: 1, kind: "supervisor", configPath: profile.configPath, phase: "starting" });
    const result = await runner(profile.service.start, { timeoutMs: config.runtime.startupTimeoutMs });
    if (result.code) throw new Error("Configured service start failed; inspect supervisor before retry");
  } else {
    if (existsSync(intentPath)) {
      const prior = readJson<any>(intentPath);
      if (prior.phase === "starting" && (!prior.pid || alive(prior.pid))) throw new Error("Owned service startup outcome unknown; inspect launcher-service.json before retry");
    }
    atomicJson(intentPath, { version: 1, kind: "owned", configPath: profile.configPath, phase: "starting" });
    const log = openSync(join(config.stateDir, "launcher-service.log"), "a", 0o600);
    try {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../cli.ts"), "serve"], {
        env: { ...process.env, DORI_CONFIG: profile.configPath }, stdin: "ignore", stdout: log, stderr: log, detached: true,
      });
      ownedChild = child;
      atomicJson(intentPath, { version: 1, kind: "owned", configPath: profile.configPath, phase: "starting", pid: child.pid }); child.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + config.runtime.startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await serviceClient(config)("health", {}, 1000);
      assertServiceReady(config, status);
      if (ownedChild) {
        if (status.pid !== ownedChild.pid) throw new Error("Owned service PID changed");
        ownedServices.set(ownedChild.pid, ownedChild);
      }
      atomicJson(intentPath, { ...readJson<any>(intentPath), phase: "ready" }); return;
    } catch { /* startup only */ }
    await Bun.sleep(100);
  }
  throw new Error("Authenticated service health not ready; startup intent retained, do not start a duplicate");
}
