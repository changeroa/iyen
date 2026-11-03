import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";
import { JOURNAL_CHECKPOINT_RECORDS, Registry, type Lane, type ReplayProgress } from "../src/registry.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => { state.done(); });
const lane: Lane = { key: "storage-lane", title: "one", thread: "none", brief: "/b", done: "done", openedAt: "now" };
const journal = () => new Journal(join(state.dir, "journal"));
const row = (value: Lane) => ({ type: "lane", lane: value });

test("unchanged holds, cloned and reordered JSON content do not bump revisions or touch disk", async () => {
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  await registry.write({ ...lane, dispatchBlocked: true, holdReason: "recovery", resumeRefs: { one: { sha: "abc", branch: "work" } } });
  const initial = (await registry.read(lane.key))!;
  const file = fs.statSync(registry.path(lane.key));
  const log = fs.readFileSync(journal().path, "utf8");
  for (let i = 0; i < 100; i++) {
    const result = await registry.update(lane.key, current => ({ ...current, dispatchBlocked: true, holdReason: "recovery", resumeRefs: { one: { branch: "work", sha: "abc" } }, lastSeenReport: undefined }));
    expect(result.revision).toBe(initial.revision);
  }
  await registry.write({ ...initial, lastSeenReport: undefined });
  expect(fs.readFileSync(journal().path, "utf8")).toBe(log);
  expect(fs.statSync(registry.path(lane.key)).ino).toBe(file.ino);
  expect(fs.statSync(registry.path(lane.key)).mtimeMs).toBe(file.mtimeMs);
  await registry.update(lane.key, current => ({ ...current, dispatchBlocked: false }));
  await expect(registry.write(initial)).rejects.toThrow("Revision conflict");
  expect((await registry.read(lane.key))!.revision).toBe(2);
});

test("replay streams repetitive history, reports progress and writes each changed lane once", async () => {
  const log = journal();
  const count = 30_000;
  const fd = fs.openSync(log.path, "w", 0o600);
  try {
    for (let i = 1; i <= count; i++) fs.writeFileSync(fd, JSON.stringify(row({ ...lane, key: `storage-${i % 3}`, revision: i, title: `revision ${i}` })) + "\n");
  } finally { fs.closeSync(fd); }
  const registry = new Registry(state.dir);
  const progress: ReplayProgress[] = [];
  const rename = fs.renameSync;
  const writes: string[] = [];
  const renames = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).startsWith(registry.dir + "/")) writes.push(String(to));
    return rename(from, to);
  });
  // Array materialization is retained only for compatibility, never for replay.
  const arrayRead = spyOn(Journal.prototype, "read").mockImplementation(() => { throw new Error("array replay forbidden"); });
  try { registry.enableJournal(state.dir, value => progress.push(value)); }
  finally { arrayRead.mockRestore(); renames.mockRestore(); }
  expect(writes.sort()).toEqual([0, 1, 2].map(i => registry.path(`storage-${i}`)));
  expect(progress[0]).toEqual({ records: 0, lanes: 0 });
  expect(progress.at(-1)).toEqual({ records: count, lanes: 3 });
  expect(progress.length).toBeLessThanOrEqual(count / 1000 + 2);
  expect(progress.some(value => value.records === 1000 && value.lanes === 3)).toBe(true);
  expect((await registry.read("storage-0"))!.revision).toBe(count);
  expect(log.read()).toHaveLength(3);
  const inode = fs.statSync(registry.path("storage-0")).ino;
  new Registry(state.dir).enableJournal(state.dir);
  expect(fs.statSync(registry.path("storage-0")).ino).toBe(inode);
});

test("replay preserves highest revisions and checkpoints pre-journal and newer snapshots", async () => {
  const registry = new Registry(state.dir);
  await registry.write(lane);
  await registry.update(lane.key, current => ({ ...current, title: "newer snapshot" }));
  await registry.write({ ...lane, key: "legacy-lane" });
  const log = journal();
  log.append(row({ ...lane, revision: 1 }));
  registry.enableJournal(state.dir);
  expect((await registry.read(lane.key))!.title).toBe("newer snapshot");
  fs.unlinkSync(registry.path(lane.key));
  fs.unlinkSync(registry.path("legacy-lane"));
  log.append(row({ ...lane, revision: 1, title: "out of order" }));
  new Registry(state.dir).enableJournal(state.dir);
  expect((await registry.read(lane.key))!.revision).toBe(2);
  expect((await registry.read("legacy-lane"))!.revision).toBe(1);
});

test("stream reader handles UTF-8 and large records across chunks and durably quarantines raw tail", () => {
  const log = journal();
  const record = row({ ...lane, brief: "한🙂".repeat(30_000) });
  log.append(record);
  const tail = Buffer.from('{"unterminated":"' + "한🙂".repeat(20_000));
  fs.appendFileSync(log.path, tail);
  expect(log.read()).toEqual([record]);
  const partial = fs.readdirSync(join(state.dir, "journal")).find(file => file.includes(".partial-"))!;
  expect(fs.readFileSync(join(state.dir, "journal", partial))).toEqual(tail);
  expect(fs.statSync(join(state.dir, "journal", partial)).mode & 0o777).toBe(0o600);
  expect(log.read()).toEqual([record]);
  expect(fs.readFileSync(log.path, "utf8").endsWith("\n")).toBe(true);
});

test("corrupt snapshots recover from the journal while malformed complete records fail closed", async () => {
  const log = journal();
  log.append(row({ ...lane, revision: 3 }));
  const registry = new Registry(state.dir);
  fs.mkdirSync(registry.dir);
  for (const content of ['{"broken":', '{"key":"wrong-key","revision":99}', '{"key":"storage-lane","revision":-1}']) {
    fs.writeFileSync(registry.path(lane.key), content);
    registry.enableJournal(state.dir);
    expect((await registry.read(lane.key))!.revision).toBe(3);
  }
  fs.appendFileSync(log.path, '{"complete-but-invalid":}\n');
  expect(() => new Registry(state.dir).enableJournal(state.dir)).toThrow();
});

test("interrupted checkpoint leaves old journal authoritative, restart ignores staging and retries", async () => {
  const log = journal();
  log.append(row({ ...lane, revision: 1 }));
  log.append(row({ ...lane, revision: 2, title: "latest" }));
  const before = fs.readFileSync(log.path, "utf8");
  function* interrupted() {
    yield row({ ...lane, revision: 2 });
    throw new Error("interrupted before replacement");
  }
  expect(() => log.checkpoint(interrupted())).toThrow("interrupted before replacement");
  expect(fs.readFileSync(log.path, "utf8")).toBe(before);
  fs.writeFileSync(`${log.path}.interrupted.tmp`, '{"type":');
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  expect((await registry.read(lane.key))!.title).toBe("latest");
  expect(log.read()).toHaveLength(1);
  await registry.update(lane.key, current => ({ ...current, title: "after checkpoint" }));
  fs.unlinkSync(registry.path(lane.key));
  new Registry(state.dir).enableJournal(state.dir);
  expect(await registry.read(lane.key)).toMatchObject({ revision: 3, title: "after checkpoint" });
});

test("concurrent per-lane mutations cross automatic checkpoints without lost records", async () => {
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  const keys = ["storage-first", "storage-second", "storage-third"];
  await Promise.all(keys.map(key => registry.write({ ...lane, key, cycle: 0 })));
  const checkpoints = spyOn(Journal.prototype, "checkpoint");
  const rounds = Math.ceil(JOURNAL_CHECKPOINT_RECORDS / keys.length) + 4;
  try {
    await Promise.all(keys.flatMap(key => Array.from({ length: rounds }, () => registry.update(key, current => ({ ...current, cycle: (current.cycle ?? 0) + 1 })))));
    expect(checkpoints).toHaveBeenCalledTimes(1);
  } finally { checkpoints.mockRestore(); }
  expect(journal().read().length).toBeLessThan(keys.length + 30);
  for (const key of keys) fs.unlinkSync(registry.path(key));
  const recovered = new Registry(state.dir);
  recovered.enableJournal(state.dir);
  for (const key of keys) expect(await recovered.read(key)).toMatchObject({ revision: rounds + 1, cycle: rounds });
}, 30_000);

test("automatic checkpoint failure retains every committed concurrent mutation for restart", async () => {
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  await registry.write(lane);
  const original = fs.renameSync;
  let failed = false;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === journal().path && !failed) { failed = true; throw new Error("checkpoint rename interrupted"); }
    return original(from, to);
  });
  // Oversized data reaches the byte bound without thousands of fsyncs.
  const big = "x".repeat(16 * 1024 * 1024);
  try { await expect(registry.update(lane.key, current => ({ ...current, brief: big }))).rejects.toThrow("checkpoint rename interrupted"); }
  finally { rename.mockRestore(); }
  expect(journal().read()).toHaveLength(2);
  await registry.write({ ...lane, key: "other-lane" });
  await registry.update(lane.key, current => ({ ...current, brief: "small again" }));
  for (const key of [lane.key, "other-lane"]) fs.unlinkSync(registry.path(key));
  const recovered = new Registry(state.dir);
  recovered.enableJournal(state.dir);
  expect(await recovered.read(lane.key)).toMatchObject({ revision: 3, brief: "small again" });
  expect(await recovered.read("other-lane")).toMatchObject({ revision: 1 });
});

test("snapshot failure cannot drop a durable mutation from the next checkpoint", async () => {
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  await registry.write(lane);
  const stale = (await registry.read(lane.key))!;
  const original = fs.renameSync;
  let failed = false;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === registry.path(lane.key) && !failed) { failed = true; throw new Error("snapshot interrupted"); }
    return original(from, to);
  });
  try { await expect(registry.update(lane.key, current => ({ ...current, title: "committed in journal" }))).rejects.toThrow("snapshot interrupted"); }
  finally { rename.mockRestore(); }
  expect(JSON.parse(fs.readFileSync(registry.path(lane.key), "utf8"))).toMatchObject({ revision: 1, title: "one" });
  expect(await registry.read(lane.key)).toMatchObject({ revision: 2, title: "committed in journal" });
  expect(await registry.list()).toEqual([expect.objectContaining({ revision: 2, title: "committed in journal" })]);
  await expect(registry.write({ ...stale, thread: "stale overwrite" })).rejects.toThrow("Revision conflict");
  await registry.update(lane.key, current => ({ ...current, thread: "next committed field" }));
  expect(await registry.read(lane.key)).toMatchObject({ revision: 3, title: "committed in journal", thread: "next committed field" });
  // Another lane's byte-bound checkpoint must include the failed snapshot's WAL.
  await registry.write({ ...lane, key: "checkpoint-lane", brief: "x".repeat(16 * 1024 * 1024) });
  for (const key of [lane.key, "checkpoint-lane"]) fs.unlinkSync(registry.path(key));
  const recovered = new Registry(state.dir);
  recovered.enableJournal(state.dir);
  expect(await recovered.read(lane.key)).toMatchObject({ revision: 3, title: "committed in journal", thread: "next committed field" });
});

test("checkpoint snapshots are detached from caller-owned nested objects", async () => {
  const registry = new Registry(state.dir);
  registry.enableJournal(state.dir);
  const refs = { main: { sha: "original" } };
  await registry.write({ ...lane, resumeRefs: refs });
  refs.main.sha = "caller mutation";
  const result = await registry.update(lane.key, current => ({ ...current, title: "updated" }));
  result.resumeRefs!.main!.sha = "mutated result";
  (await registry.read(lane.key))!.resumeRefs!.main!.sha = "mutated read";
  (await registry.list())[0]!.resumeRefs!.main!.sha = "mutated list";
  await registry.write({ ...lane, key: "checkpoint-lane", brief: "x".repeat(16 * 1024 * 1024) });
  fs.unlinkSync(registry.path(lane.key));
  new Registry(state.dir).enableJournal(state.dir);
  expect((await registry.read(lane.key))!.resumeRefs!.main!.sha).toBe("original");
});
