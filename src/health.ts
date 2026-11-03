import { readFileSync } from "node:fs";
import { join } from "node:path";

// Operator-only fallback while the service has not opened its RPC socket yet.
// A live PID or a recorded ready phase is never evidence of current readiness.
export const readStartupHealth = (stateDir: string) => {
  const read = (name: string): any => {
    try { return JSON.parse(readFileSync(join(stateDir, name), "utf8")); } catch { return null; }
  };
  const saved = read("service-health.json"), lock = read("service.lock");
  const pid = Number.isSafeInteger(saved?.pid) && saved.pid > 0 ? saved.pid as number : undefined;
  let processAlive = false;
  if (pid && lock?.pid === pid) {
    try { process.kill(pid, 0); processAlive = true; }
    catch (error) { processAlive = (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  const phases = new Set(["starting", "replaying", "reconciling", "ready", "stopping", "failed"]);
  const recordedPhase = phases.has(saved?.phase) ? saved.phase as string : undefined;
  const recovering = processAlive && ["starting", "replaying", "reconciling"].includes(recordedPhase ?? "");
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  return {
    serviceReachable: false, phase: recovering ? recordedPhase : "unavailable", recordedPhase, pid, processAlive,
    startedAt: time(saved?.startedAt), updatedAt: time(saved?.updatedAt),
    ...(saved?.replay ? { replay: { records: count(saved.replay.records), lanes: count(saved.replay.lanes) } } : {}),
    message: recovering ? "Service is recovering; message delivery is not ready." : "Service RPC is unavailable; recorded state does not confirm readiness.",
  };
};
