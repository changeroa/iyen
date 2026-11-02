import { expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FailureJournal, drainOmpFailures, failureCursorPath, type OmpFailureEvent } from "../src/runtime/omp/failures.ts";
import { parseRequest, validateFailurePage, validateFailureRecord } from "../src/runtime/omp/contract.ts";
import { ompFixture } from "./fixtures/omp.ts";

test("failure journal persists 101+ records in exact pages and preserves original source epochs", () => {
  const f = ompFixture(), path = join(f.directory, "failures.json");
  try {
    const journal = new FailureJournal(path, f.identity);
    for (let i = 0; i < 103; i++) journal.append(`run:${i}`, "model", "runtime");
    journal.append("run:0", "model", "authentication"); // immutable first terminal outcome
    const first = journal.page(0), second = journal.page(100);
    expect(first.records).toHaveLength(100); expect(first.hasMore).toBe(true); expect(second.records.map(r => r.sequence)).toEqual([101, 102, 103]);
    expect(validateFailurePage(first, f.identity, 0)).toBe(true);
    expect(journal.page(103)).toMatchObject({ after: 103, through: 103, highWatermark: 103, hasMore: false, records: [] });
    const restarted = new FailureJournal(path, { ...f.identity, instanceId: "replacement", generation: 2 });
    expect(restarted.page(0)).toEqual(first); expect(first.records[0]!.sourceInstanceId).toBe("instance");
    restarted.append("run:new", "compaction", "configuration");
    expect(restarted.page(103).records[0]).toMatchObject({ sourceInstanceId: "replacement", sourceGeneration: 2, phase: "compaction" });
    expect(() => restarted.page(105)).toThrow("failure channel unavailable");
  } finally { f.cleanup(); }
});

test("failure journal rejects corruption, changed binding, gaps and storage failure without healthy empty success", () => {
  const f = ompFixture(), directory = join(f.directory, "journal"), path = join(directory, "failures.json");
  try {
    const journal = new FailureJournal(path, f.identity); journal.append("run", "model", "runtime");
    for (const changed of [{ sessionId: "019a4190-0000-7000-8000-000000000099" }, { sessionFile: "/other/session" }, { laneKey: "other" }]) {
      expect(() => new FailureJournal(path, { ...f.identity, ...changed })).toThrow("failure channel unavailable");
    }
    const saved = JSON.parse(readFileSync(path, "utf8")); saved.records[0].sequence = 2;
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
    expect(() => new FailureJournal(path, f.identity)).toThrow("failure channel unavailable");
    renameSync(directory, `${directory}-moved`); writeFileSync(directory, "blocked", { mode: 0o600 });
    expect(() => journal.append("second", "model", "runtime")).toThrow("failure channel unavailable");
    expect(journal.available).toBe(false); expect(() => journal.page(0)).toThrow("failure channel unavailable");
  } finally { f.cleanup(); }
});

test("strict failure validators reject missing, extra, reordered, duplicate, oversized and cross-session pages", () => {
  const f = ompFixture();
  try {
    const journal = new FailureJournal(join(f.directory, "failures.json"), f.identity);
    journal.append("first", "model", "runtime"); journal.append("second", "compaction", "authentication");
    const page = journal.page(0), [a, b] = page.records;
    for (const changed of [{ extra: true }, { records: [b, a] }, { records: [a, a] }, { records: [a] }, { through: 1 }, { highWatermark: -1 }, { hasMore: true }, { laneKey: "other" }, { sessionFile: "/other" }, { sessionId: "other" }, { streamId: "invalid" }, { after: 1 }, { records: Array(101).fill(a) }]) {
      expect(validateFailurePage({ ...page, ...changed }, f.identity, 0)).toBe(false);
    }
    expect(validateFailureRecord({ ...a, errorMessage: "secret" }, page.streamId)).toBe(false);
    expect(validateFailureRecord({ ...a, category: "raw error" }, page.streamId)).toBe(false);
    expect(validateFailureRecord({ ...a, observedAt: "2026-02-30T01:00:00.000Z" }, page.streamId)).toBe(false);
    for (const params of [{ after: -1, limit: 100 }, { after: 0.5, limit: 100 }, { after: 0, limit: 101 }, { after: 0, limit: 0 }, { after: 0 }, { after: 0, limit: 100, extra: true }]) {
      expect(() => parseRequest({ protocol: 1, id: "request", token: "token", target: f.identity, method: "failures", params })).toThrow("Invalid OMP parameters");
    }
  } finally { f.cleanup(); }
});

test("host durable cursor advances only through accepted records; restart replays uncertain ACK and drains idle history", async () => {
  const f = ompFixture();
  try {
    const journal = new FailureJournal(join(f.directory, "failures.json"), f.identity), cursor = failureCursorPath(f.directory, f.identity);
    journal.append("first", "model", "authentication"); journal.append("second", "model", "usage-limit");
    const controller = { failures: async (after: number, limit?: number) => journal.page(after, limit) };
    const inserted = new Map<string, OmpFailureEvent>(), calls: number[] = [];
    const accept = async (event: OmpFailureEvent) => {
      expect(Object.keys(event)).toEqual(["method", "params"]); expect(event.params.runtime).toBe("omp");
      calls.push(event.params.failure.sequence); inserted.set(event.params.failure.failureId, event); return { accepted: true };
    };
    await expect(drainOmpFailures(controller, f.identity, cursor, async event => {
      await accept(event); throw new Error("host crashed after durable service insertion before cursor save");
    })).rejects.toThrow("host crashed");
    expect(JSON.parse(readFileSync(cursor, "utf8")).after).toBe(0);
    expect(await drainOmpFailures(controller, f.identity, cursor, accept)).toBe(2);
    expect(calls).toEqual([1, 1, 2]); expect(inserted.size).toBe(2); expect(JSON.parse(readFileSync(cursor, "utf8")).after).toBe(2);
    expect(await drainOmpFailures(controller, f.identity, cursor, accept)).toBe(0);
    journal.append("third", "compaction", "runtime");
    await expect(drainOmpFailures(controller, f.identity, cursor, async () => ({ accepted: false }))).rejects.toThrow("failure channel unavailable");
    expect(JSON.parse(readFileSync(cursor, "utf8")).after).toBe(2);
    expect(await drainOmpFailures(controller, f.identity, cursor, accept)).toBe(1);
    const reset = new FailureJournal(join(f.directory, "reset.json"), f.identity);
    for (let i = 0; i < 3; i++) reset.append(`reset:${i}`, "model", "runtime");
    await expect(drainOmpFailures({ failures: async after => reset.page(after) }, f.identity, cursor, accept)).rejects.toThrow("failure channel unavailable");
  } finally { f.cleanup(); }
});

test("host page budget never skips unacknowledged records or keys cursor by ephemeral epoch", async () => {
  const f = ompFixture();
  try {
    const journal = new FailureJournal(join(f.directory, "failures.json"), f.identity), cursor = failureCursorPath(f.directory, f.identity);
    for (let i = 0; i < 101; i++) journal.append(`run:${i}`, "model", "runtime");
    const controller = { failures: async (after: number) => journal.page(after) };
    expect(await drainOmpFailures(controller, f.identity, cursor, async () => ({ accepted: true }))).toBe(100);
    expect(JSON.parse(readFileSync(cursor, "utf8")).after).toBe(100);
    expect(failureCursorPath(f.directory, { ...f.identity, instanceId: "new" } as typeof f.identity)).toBe(cursor);
    expect(await drainOmpFailures(controller, f.identity, cursor, async () => ({ accepted: true }))).toBe(1);
  } finally { f.cleanup(); }
});
