// Run: bun test/storage-benchmark.ts [record-count]. Uses generated temp data only.
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { Registry, type Lane } from "../src/registry.ts";
import { withState } from "./fakes.ts";

const lanes = 16;
if (process.argv[2] === "--replay") {
  const stateDir = process.argv[3]!;
  const records = Number(process.argv[4]);
  const registry = new Registry(stateDir);
  const path = join(stateDir, "journal/events.jsonl");
  const originalBytes = fs.statSync(path).size;
  const rename = fs.renameSync;
  let snapshotWrites = 0;
  let progressCalls = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  const writes = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).startsWith(registry.dir + "/")) snapshotWrites++;
    return rename(from, to);
  });
  const started = performance.now();
  registry.enableJournal(stateDir, () => {
    progressCalls++;
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  });
  const replayMs = performance.now() - started;
  for (let i = 0; i < lanes; i++) {
    const value = (await registry.read(`synthetic-${i}`))!;
    const expectedRevision = records - ((records - 1 - i) % lanes);
    if (value.revision !== expectedRevision) throw new Error(`Lost revision for lane ${i}`);
  }
  if (snapshotWrites !== lanes) throw new Error(`Unexpected snapshot writes: ${snapshotWrites}`);
  snapshotWrites = 0;
  const restarted = performance.now();
  new Registry(stateDir).enableJournal(stateDir);
  const restartMs = performance.now() - restarted;
  writes.mockRestore();
  if (snapshotWrites) throw new Error("Restart rewrote identical snapshots");
  console.log(JSON.stringify({ records, lanes, originalBytes, checkpointBytes: fs.statSync(path).size, replayMs: Math.round(replayMs), restartMs: Math.round(restartMs), snapshotWrites: lanes, restartSnapshotWrites: snapshotWrites, progressCalls, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10, sampledPeakHeapMiB: Math.round(peakHeapBytes / 1024 / 1024 * 10) / 10 }));
} else {
  const records = Number(process.argv[2] ?? 500_000);
  if (!Number.isSafeInteger(records) || records < lanes) throw new Error(`Record count must be an integer >= ${lanes}`);
  const state = withState();
  try {
    fs.mkdirSync(join(state.dir, "journal"));
    const fd = fs.openSync(join(state.dir, "journal/events.jsonl"), "wx", 0o600);
    try {
      for (let i = 0; i < records; i++) {
        const lane: Lane = { key: `synthetic-${i % lanes}`, schemaVersion: 2, revision: i + 1, title: "synthetic lane", thread: "none", brief: "synthetic only ".repeat(12), done: "done", openedAt: "now" };
        fs.writeFileSync(fd, JSON.stringify({ type: "lane", lane }) + "\n");
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // A fresh process excludes generation allocations from the replay measurement.
    const result = Bun.spawnSync([process.execPath, import.meta.path, "--replay", state.dir, String(records)], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    process.stdout.write(result.stdout);
  } finally { state.done(); }
}
