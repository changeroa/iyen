import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const syncDirectory = (path: string): void => {
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

const atomicFile = (path: string, write: (fd: number) => void): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { write(fd); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDirectory(path);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
};

export const atomicJson = (path: string, value: unknown): void =>
  atomicFile(path, fd => writeFileSync(fd, JSON.stringify(value, null, 2)));

export class Journal {
  readonly path: string;
  constructor(dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); this.path = join(dir, "events.jsonl"); }
  append(record: unknown): number {
    const line = JSON.stringify(record) + "\n";
    const existed = existsSync(this.path);
    const fd = openSync(this.path, "a", 0o600);
    try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
    if (!existed) syncDirectory(this.path);
    return Buffer.byteLength(line);
  }

  /** Memory is bounded by a read buffer and the largest individual record. */
  *records(): Generator<any> {
    if (!existsSync(this.path)) return;
    const fd = openSync(this.path, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let fragments: Buffer[] = [];
    let offset = 0;
    let complete = 0;
    try {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) break;
        let start = 0;
        for (let end = 0; end < count; end++) {
          if (buffer[end] !== 10) continue;
          const last = buffer.subarray(start, end);
          const line = fragments.length ? Buffer.concat([...fragments, last]).toString("utf8") : last.toString("utf8");
          fragments = [];
          complete = offset + end + 1;
          start = end + 1;
          if (line) yield JSON.parse(line);
        }
        if (start < count) fragments.push(Buffer.from(buffer.subarray(start, count)));
        offset += count;
      }
      if (offset !== complete) this.quarantineTail(fd, complete, offset);
    } finally { closeSync(fd); }
  }

  /** Compatibility for small-journal consumers; replay should use records(). */
  read(): any[] { return Array.from(this.records()); }

  /** The old journal survives until the complete replacement has been fsynced. */
  checkpoint(records: Iterable<unknown>): void {
    atomicFile(this.path, fd => {
      for (const record of records) writeFileSync(fd, JSON.stringify(record) + "\n");
    });
  }

  private quarantineTail(source: number, start: number, end: number): void {
    const partial = `${this.path}.partial-${Date.now()}-${crypto.randomUUID()}`;
    // Durably preserve the tail before removing it from the authoritative log.
    atomicFile(partial, fd => {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (let offset = start; offset < end;) {
        const count = readSync(source, buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!count) throw new Error("Journal changed during tail quarantine");
        writeFileSync(fd, buffer.subarray(0, count));
        offset += count;
      }
    });
    const fd = openSync(this.path, "r+");
    try { ftruncateSync(fd, start); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.tails.set(key, next);
    void next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => {});
    return next;
  }
}
