import { mkdirSync, readdirSync } from "node:fs";
import { atomicJson, Journal, SerialQueue } from "./journal.ts";
import type { RuntimeRef } from "./runtime/types.ts";
import { join } from "node:path";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly schemaVersion?: 2;
  readonly revision?: number;
  readonly runtime?: RuntimeRef;
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
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? ((await f.json()) as Lane) : null;
  }

  private queue = new SerialQueue();
  private journal: Journal | undefined;

  enableJournal(stateDir: string): void {
    this.journal = new Journal(join(stateDir, "journal"));
    for (const record of this.journal.read()) {
      if (record.type !== "lane") continue;
      const lane = record.lane as Lane;
      if (!LANE_KEY.test(lane.key)) throw new Error("Invalid journal lane key");
      atomicJson(this.path(lane.key), lane);
    }
  }

  async write(lane: Lane): Promise<void> {
    await this.queue.run(lane.key, async () => {
      const current = await this.read(lane.key);
      if ((current?.revision ?? 0) !== (lane.revision ?? 0)) throw new Error(`Revision conflict: ${lane.key}`);
      this.persist({ ...lane, schemaVersion: 2, revision: (current?.revision ?? 0) + 1 });
    });
  }

  async update(key: string, fn: (lane: Lane) => Lane): Promise<Lane> {
    return this.queue.run(key, async () => {
      const current = await this.read(key);
      if (!current) throw new Error(`Unknown lane ${key}`);
      const next = { ...fn(current), schemaVersion: 2 as const, revision: (current.revision ?? 0) + 1 };
      if (next.key !== key) throw new Error("Lane identity cannot change");
      this.persist(next); return next;
    });
  }

  private persist(lane: Lane): void {
    this.journal?.append({ type: "lane", lane });
    atomicJson(this.path(lane.key), lane);
  }

  async list(): Promise<Lane[]> {
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
