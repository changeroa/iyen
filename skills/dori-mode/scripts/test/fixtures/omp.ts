import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import type { OmpIdentity, OmpSnapshot, OmpTarget } from "../../src/runtime/omp/contract.ts";
export function ompFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omp-")));
  const identity: OmpIdentity = { kind: "omp", protocol: 1, sessionId: "019a4190-0000-7000-8000-000000000001", sessionFile: join(directory, "session.jsonl"), cwd: directory,
    paneId: "w1:p1", terminalId: "term_fixture", instanceId: "instance", generation: 1, role: "managed-lane", laneKey: "worker", runtimeVersion: "18.15.0" };
  const target: OmpTarget = { ...identity, socketPath: join(directory, "control.sock"), tokenFile: join(directory, "token") };
  writeFileSync(target.tokenFile, "fixture-bearer", { mode: 0o600 });
  const snapshot: OmpSnapshot = { identity, state: "idle", held: false, goal: null, model: "test", provider: "fixture", eventSequence: 0,
    capabilities: { inspect: true, input: true, durableReceipts: true, durableFailures: true, hold: true, release: true, stop: true, goals: true } };
  const header = { type: "session", version: 3, id: identity.sessionId, cwd: identity.cwd, timestamp: new Date().toISOString() };
  const transcript = (entries: unknown[], suffix = "") => writeFileSync(identity.sessionFile, [header, ...entries].map(row => JSON.stringify(row) + "\n").join("") + suffix, { mode: 0o600 });
  let server: Server | undefined;
  return { directory, identity, target, snapshot, header, transcript,
    async serve(handle: (request: any) => unknown | Promise<unknown>) {
      server = createServer(socket => {
        let buffer = "";
        socket.on("error", () => {});
        socket.on("data", chunk => {
          buffer += chunk.toString(); const end = buffer.indexOf("\n"); if (end < 0) return;
          const request = JSON.parse(buffer.slice(0, end)); buffer = "";
          Promise.resolve(handle(request)).then(response => { if (response !== undefined) socket.end(JSON.stringify(response) + "\n"); }).catch(() => socket.destroy());
        });
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(target.socketPath, resolve); });
    },
    cleanup() { server?.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
