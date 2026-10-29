import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { atomicJson, Journal, SerialQueue } from "./journal.ts";
import type { RuntimeRef } from "./runtime/types.ts";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;
export const JOURNAL_CHECKPOINT_RECORDS = 4096;
export const JOURNAL_CHECKPOINT_BYTES = 16 * 1024 * 1024;
export type ReplayProgress = { records: number; lanes: number };

const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const laneContent = ({ revision: _revision, schemaVersion: _schema, ...content }: Lane): unknown => jsonValue(content);

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly schemaVersion?: 2;
  readonly revision?: number;
  readonly runtime?: RuntimeRef;
  readonly runtimeHistory?: readonly RuntimeRef[];
  readonly dispatchBlocked?: boolean;
  readonly holdReason?: "owner-pause" | "done-review" | "recovery";
  readonly cycle?: number;
  readonly role?: "lead" | "lane";
  readonly repository?: string;
  readonly baseSha?: string;
  readonly resumeRefs?: Readonly<Record<string, { sha: string; branch?: string }>>;
  readonly cleanupFence?: string;
  readonly report?: { id: string; kind: string; text: string; at: number };
  readonly legacy?: { sessionId?: string };
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus;
  /** Owner pause interrupted a running turn with no native goal; consumed by explicit resume. */
  readonly pausedContinuation?: { id: string; interruptedTurnId: string; at: string };
  readonly receipt?: unknown;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new Error("Invalid lane key");
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const path = this.path(key);
    // A durable WAL append commits the state even if materializing its JSON file
    // fails. Never base a later mutation on an older or missing file snapshot.
    if (this.journal) {
      const committed = this.latest.get(key);
      return committed ? jsonValue(committed) as Lane : null;
    }
    const f = Bun.file(path);
    return (await f.exists()) ? ((await f.json()) as Lane) : null;
  }

  private queue = new SerialQueue();
  private journal: Journal | undefined;
  private latest = new Map<string, Lane>();
  private appendedRecords = 0;
  private appendedBytes = 0;

  enableJournal(stateDir: string, onProgress?: (progress: ReplayProgress) => void): void {
    const journal = new Journal(join(stateDir, "journal"));
    const latest = new Map<string, Lane>();
    let records = 0;
    onProgress?.({ records, lanes: 0 });
    for (const record of journal.records()) {
      records++;
      if (record?.type === "lane") {
        const lane = record.lane as Lane;
        if (!lane || typeof lane.key !== "string" || !LANE_KEY.test(lane.key)) throw new Error("Invalid journal lane key");
        if (lane.revision !== undefined && (!Number.isSafeInteger(lane.revision) || lane.revision < 0)) throw new Error("Invalid journal lane revision");
        if ((lane.revision ?? 0) >= (latest.get(lane.key)?.revision ?? 0)) latest.set(lane.key, lane);
      }
      if (records % 1000 === 0) onProgress?.({ records, lanes: latest.size });
    }

    // Include pre-journal snapshots in checkpoints and never regress a newer one.
    let checkpointNeeded = records > latest.size;
    const snapshots = new Map<string, Lane>();
    if (existsSync(this.dir)) for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const key = file.slice(0, -5);
      const path = this.path(key);
      let snapshot: Lane;
      try { snapshot = JSON.parse(readFileSync(path, "utf8")) as Lane; }
      catch (error) { if (error instanceof SyntaxError && latest.has(key)) continue; throw error; }
      if (!snapshot || snapshot.key !== key || (snapshot.revision !== undefined && (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0))) {
        if (latest.has(key)) continue;
        throw new Error("Invalid lane snapshot");
      }
      snapshots.set(key, snapshot);
      if (!latest.has(key) || (snapshot.revision ?? 0) > (latest.get(key)!.revision ?? 0)) {
        latest.set(key, snapshot);
        checkpointNeeded = true;
      }
    }
    for (const [key, lane] of latest) {
      if (!isDeepStrictEqual(jsonValue(snapshots.get(key) ?? null), jsonValue(lane))) atomicJson(this.path(key), lane);
    }
    // Synchronous replay/checkpoint/append sections cannot interleave across the
    // async per-lane queues. There is no await between choosing and replacing a log.
    if (checkpointNeeded) journal.checkpoint(Array.from(latest.values(), lane => ({ type: "lane", lane })));
    this.latest = latest;
    this.journal = journal;
    this.appendedRecords = this.appendedBytes = 0;
    onProgress?.({ records, lanes: latest.size });
  }

  async write(lane: Lane): Promise<void> {
    await this.queue.run(lane.key, async () => {
      const current = await this.read(lane.key);
      if ((current?.revision ?? 0) !== (lane.revision ?? 0)) throw new Error(`Revision conflict: ${lane.key}`);
      if (current && isDeepStrictEqual(laneContent(current), laneContent(lane))) return;
      this.persist({ ...lane, schemaVersion: 2, revision: (current?.revision ?? 0) + 1 });
    });
  }

  async update(key: string, fn: (lane: Lane) => Lane): Promise<Lane> {
    return this.queue.run(key, async () => {
      const current = await this.read(key);
      if (!current) throw new Error(`Unknown lane ${key}`);
      const before = laneContent(current);
      const revision = current.revision ?? 0;
      const next = { ...fn(current), schemaVersion: 2 as const, revision: revision + 1 };
      if (next.key !== key) throw new Error("Lane identity cannot change");
      if (isDeepStrictEqual(before, laneContent(next))) return current;
      this.persist(next); return next;
    });
  }

  private persist(lane: Lane): void {
    // Detach checkpoint state from caller-owned nested objects and update results.
    const snapshot = jsonValue(lane) as Lane;
    if (this.journal) {
      this.appendedBytes += this.journal.append({ type: "lane", lane: snapshot });
      this.appendedRecords++;
      // Update immediately after the durable append, even if snapshot writing fails.
      this.latest.set(snapshot.key, snapshot);
    }
    atomicJson(this.path(snapshot.key), snapshot);
    if (this.journal && (this.appendedRecords >= JOURNAL_CHECKPOINT_RECORDS || this.appendedBytes >= JOURNAL_CHECKPOINT_BYTES)) {
      this.journal.checkpoint(Array.from(this.latest.values(), lane => ({ type: "lane", lane })));
      this.appendedRecords = this.appendedBytes = 0;
    }
  }

  async list(): Promise<Lane[]> {
    if (this.journal) return Array.from(this.latest.values(), lane => jsonValue(lane) as Lane);
    mkdirSync(this.dir, { recursive: true });
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) lanes.push((await Bun.file(join(this.dir, f)).json()) as Lane);
    return lanes;
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}
