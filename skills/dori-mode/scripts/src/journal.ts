import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const atomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};
export class Journal {
  readonly path: string;
  constructor(dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); this.path = join(dir, "events.jsonl"); }
  append(record: unknown): void {
    const fd = openSync(this.path, "a", 0o600);
    try { writeSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): any[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    if (end !== text.length) {
      writeFileSync(`${this.path}.partial-${Date.now()}`, text.slice(end), { mode: 0o600 });
      writeFileSync(this.path, text.slice(0, end), { mode: 0o600 });
    }
    return text.slice(0, end).split("\n").filter(Boolean).map(line => JSON.parse(line));
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
