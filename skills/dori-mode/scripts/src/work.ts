import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Registry, type Lane } from "./registry.ts";
import { iso, type Clock } from "./run.ts";

export type Work = {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly thread?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly elapsedSec?: number;
};
export type PastWork = Work & { readonly source: "direct" | "lane"; readonly endedAt: string; readonly elapsedSec: number };

export class WorkError extends Error {}

const normalize = (text: string): string => text.normalize("NFKC").toLowerCase().trim();
const terms = (title: string, tags: readonly string[]): Set<string> => {
  const words = normalize([title, ...tags].join(" ")).match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = new Set(words);
  for (const word of words) {
    const chars = [...word];
    for (let i = 0; i < chars.length - 1; i++) result.add(chars.slice(i, i + 2).join(""));
  }
  return result;
};

export class WorkTimers {
  readonly dir: string;
  constructor(readonly stateDir: string, readonly clock: Clock) {
    this.dir = join(stateDir, "work");
  }

  private path(id: string): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new WorkError("invalid work id");
    return join(this.dir, `${id}.json`);
  }

  async start(title: string, tags: readonly string[] = [], thread?: string, id = crypto.randomUUID()): Promise<Work> {
    if (!title.trim()) throw new WorkError("work title is required");
    const work: Work = {
      id, title: title.trim(),
      tags: [...new Set(tags.map(normalize).filter(Boolean))],
      ...(thread ? { thread } : {}), startedAt: iso(this.clock),
    };
    const path = this.path(id);
    if (existsSync(path)) {
      const previous: Work = await Bun.file(path).json();
      if (previous.title !== work.title || JSON.stringify(previous.tags) !== JSON.stringify(work.tags) || previous.thread !== work.thread) throw new WorkError("work id reused with different content");
      return previous;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(work, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return work;
  }

  async stop(id: string): Promise<Work> {
    const path = this.path(id);
    if (!existsSync(path)) throw new WorkError(`no started work "${id}"`);
    const work: Work = await Bun.file(path).json();
    if (work.endedAt) throw new WorkError(`work "${id}" is already stopped`);
    const endedAt = iso(this.clock);
    const elapsedSec = (Date.parse(endedAt) - Date.parse(work.startedAt)) / 1000;
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0) throw new WorkError("work end precedes its start or start is invalid");
    const stopped: Work = { ...work, endedAt, elapsedSec };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stopped, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return stopped;
  }

  async similar(title = "", tags: readonly string[] = []): Promise<PastWork[]> {
    const query = terms(title, tags);
    if (!query.size) throw new WorkError("similar needs a title or tag");
    const past: PastWork[] = [];
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
        const work: Work = await Bun.file(join(this.dir, name)).json();
        if (work.endedAt !== undefined && work.elapsedSec !== undefined) {
          past.push({ ...work, source: "direct", endedAt: work.endedAt, elapsedSec: work.elapsedSec });
        }
      }
    }
    const registry = new Registry(this.stateDir);
    // Registry.list creates its directory; history lookup itself must be read-only.
    if (existsSync(registry.dir)) {
      for (const lane of await registry.list()) {
        past.push(...completedLaneWork(lane));
      }
    }
    return past.map((work) => {
      const candidate = terms(work.title, work.tags);
      const score = [...query].filter((term) => candidate.has(term)).length / query.size;
      return { work, score };
    }).filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.work.endedAt.localeCompare(a.work.endedAt) || a.work.id.localeCompare(b.work.id))
      .map(({ work }) => work);
  }
}

/** Reopened Codex lanes retain each completed cycle, without counting idle time between tasks. */
const completedLaneWork = (lane: Lane): PastWork[] => {
  if (lane.role === "lead") return [];
  const records: PastWork[] = [];
  let startedAt = lane.openedAt, claimedAt: string | undefined;
  const add = (closedAt: string, claim = claimedAt) => {
    // Current lanes finish execution at the final done claim, before review/cleanup.
    // Legacy lanes without claims still supply their original open-to-close duration.
    const endedAt = claim ?? closedAt;
    const elapsedSec = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0 || Date.parse(endedAt) > Date.parse(closedAt)) return;
    records.push({ id: records.length ? `${lane.key}:cycle:${records.length + 1}` : lane.key, title: lane.title, tags: [], thread: lane.thread, source: "lane", startedAt, endedAt, elapsedSec });
  };
  let lastClosedAt: string | undefined;
  for (const entry of lane.history ?? []) {
    if (entry.status === "working" && entry.note === "Reopened") { startedAt = entry.at; claimedAt = undefined; }
    if (entry.status === "done-claimed") claimedAt = entry.at;
    if (entry.status === "not-done") claimedAt = undefined;
    if (entry.status === "closed") { add(entry.at); lastClosedAt = entry.at; }
  }
  if (lane.closedAt && lane.closedAt !== lastClosedAt) add(lane.closedAt, lane.claim?.at ?? claimedAt);
  return records;
};
