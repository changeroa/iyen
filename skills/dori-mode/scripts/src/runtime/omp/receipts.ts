import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OmpError, assertIdentity, exactKeys, hash, identityOf, markedText, nonempty, object, payloadHash, validReceipt,
  type OmpIdentity, type OmpOperation, type OmpReceipt } from "./contract.ts";

export const OMP_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export class ReceiptPending extends Error {}
export function readPrivateJson(path: string, maxBytes = 1024 * 1024): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new OmpError("unsafe-file", "OMP state file must be private and user-owned");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || realpathSync(path) !== path) {
    throw new OmpError("unsafe-directory", "OMP control directory must be canonical, private and user-owned", false);
  }
}
/** Atomic replacement plus file and directory fsync. Never used on the OMP transcript. */
export function durableJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
}

type JournalRow = Exclude<OmpOperation, { status: "absent" }>;
type JournalData = { protocol: 1; identity: OmpIdentity; operations: JournalRow[] };
/** One extension owns this journal. Reserved/attempted rows are permanently fenced after restart. */
export class OperationJournal {
  private readonly rows = new Map<string, JournalRow>();
  private failed = false;
  constructor(readonly path: string, readonly identity: OmpIdentity) {
    assertIdentity(identity); privateDirectory(dirname(path));
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.persist(); return; } throw error; }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o077) || info.size > 16 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe journal");
      const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!object(data) || !exactKeys(data, ["protocol", "identity", "operations"]) || data.protocol !== 1 || !Array.isArray(data.operations)) throw new Error("Invalid journal");
      assertIdentity(data.identity);
      const previousIdentity = data.identity;
      // Controller epochs change on restart; the stable session/lane journal must still fence old attempts.
      if (!["sessionId", "sessionFile", "cwd", "role", "laneKey"].every(key => previousIdentity[key as keyof OmpIdentity] === identity[key as keyof OmpIdentity])) throw new Error("Journal scope changed");
      for (const row of data.operations) {
        if (!object(row)) throw new Error("Invalid row");
        const received = row.status === "received", receipt = row.receipt;
        const id = received && object(receipt) ? receipt.operationId : row.operationId;
        const digest = received && object(receipt) ? receipt.payloadHash : row.payloadHash;
        if (!nonempty(id) || !hash(digest) || this.rows.has(id) || (received ?
          !exactKeys(row, ["status", "receipt"]) || !validReceipt(receipt, identity, id, digest) :
          !exactKeys(row, ["status", "operationId", "payloadHash"]) || !["reserved", "attempted", "unknown"].includes(row.status as string))) throw new Error("Invalid row");
        this.rows.set(id, received ? row as JournalRow : { status: "unknown", operationId: id, payloadHash: digest });
      }
    } catch { throw new OmpError("invalid-journal", "OMP operation journal cannot be verified; dispatch fenced"); }
    finally { closeSync(fd); }
    this.persist();
  }
  private persist(): void {
    try { durableJson(this.path, { protocol: 1, identity: identityOf(this.identity), operations: [...this.rows.values()] } satisfies JournalData); }
    catch (error) { this.failed = true; throw error; }
  }
  get(operationId: string, digest: string): OmpOperation {
    if (this.failed) throw new OmpError("journal-failed", "OMP journal durability failed; dispatch fenced");
    const row = this.rows.get(operationId); if (!row) return { status: "absent" };
    const saved = row.status === "received" ? row.receipt.payloadHash : row.payloadHash;
    if (saved !== digest) throw new OmpError("operation-conflict", "OMP operation content changed", row.status !== "reserved");
    return structuredClone(row);
  }
  reserve(operationId: string, digest: string): boolean {
    if (!nonempty(operationId) || !hash(digest)) throw new OmpError("invalid-operation", "Invalid operation", false);
    if (this.get(operationId, digest).status !== "absent") return false;
    this.rows.set(operationId, { status: "reserved", operationId, payloadHash: digest }); this.persist(); return true;
  }
  attempted(operationId: string, digest: string): void {
    if (this.get(operationId, digest).status !== "reserved") throw new OmpError("operation-fenced", "OMP operation already attempted; outcome unknown", true);
    this.rows.set(operationId, { status: "attempted", operationId, payloadHash: digest }); this.persist();
  }
  unknown(operationId: string, digest: string): void {
    const previous = this.get(operationId, digest);
    if (previous.status === "received" || previous.status === "absent") return;
    this.rows.set(operationId, { status: "unknown", operationId, payloadHash: digest }); this.persist();
  }
  received(receipt: OmpReceipt): void {
    if (!validReceipt(receipt, this.identity, receipt.operationId, receipt.payloadHash) || this.get(receipt.operationId, receipt.payloadHash).status === "absent") throw new OmpError("invalid-receipt", "Unreserved OMP receipt");
    this.rows.set(receipt.operationId, { status: "received", receipt }); this.persist();
  }
}

type Entry = Record<string, unknown> & { id: string; parentId: string | null };
/** Read the entire pinned local file, prove exact active-branch user content, fsync, then return evidence. */
export function persistedReceipt(identity: OmpIdentity, leafId: string | null, text: string, operationId: string): OmpReceipt | undefined {
  assertIdentity(identity);
  if (!identity.sessionFile.endsWith(".jsonl") || realpathSync(identity.sessionFile) !== identity.sessionFile || realpathSync(identity.cwd) !== identity.cwd) throw new OmpError("unsupported-storage", "OMP requires a pinned canonical local JSONL session");
  const fd = openSync(identity.sessionFile, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > OMP_MAX_TRANSCRIPT_BYTES || (process.getuid && before.uid !== process.getuid())) throw new OmpError("unsupported-storage", "OMP transcript storage or scan limit unsupported");
    const bytes = readFileSync(fd);
    if (bytes.length > OMP_MAX_TRANSCRIPT_BYTES) throw new OmpError("scan-limit", "OMP receipt scan incomplete");
    if (!bytes.length || bytes[bytes.length - 1] !== 10) throw new ReceiptPending("OMP transcript has an incomplete trailing record");
    const lines = bytes.toString("utf8").split("\n"); lines.pop();
    const records: unknown[] = lines.map(line => JSON.parse(line));
    const header = records.shift();
    if (!object(header) || header.type !== "session" || header.id !== identity.sessionId || header.cwd !== identity.cwd) throw new OmpError("identity-mismatch", "OMP persisted session header mismatch");
    const entries = new Map<string, Entry>();
    for (const record of records) {
      if (!object(record) || !nonempty(record.id) || (record.parentId !== null && !nonempty(record.parentId)) || entries.has(record.id)) throw new OmpError("invalid-transcript", "OMP transcript entry structure ambiguous");
      entries.set(record.id, record as Entry);
    }
    const branch: Entry[] = [], seen = new Set<string>();
    let current = leafId;
    while (current !== null) {
      if (seen.has(current)) throw new OmpError("invalid-transcript", "OMP transcript branch cycle");
      seen.add(current); const entry = entries.get(current);
      if (!entry) throw new ReceiptPending("OMP active branch is not yet persisted");
      branch.push(entry); current = entry.parentId;
    }
    const expected = markedText(text, operationId);
    const matches = branch.filter(entry => {
      if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "user") return false;
      const content = entry.message.content;
      // Only exact plain user text is accepted; images and mixed content cannot masquerade as this submission.
      return typeof content === "string" ? content === expected : Array.isArray(content) && content.every(part => object(part) && part.type === "text" && typeof part.text === "string") && content.map(part => part.text).join("") === expected;
    });
    if (matches.length > 1) throw new OmpError("duplicate-receipt", "Multiple exact OMP user receipts; dispatch fenced", true);
    const after = fstatSync(fd), named = statSync(identity.sessionFile);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino || realpathSync(identity.sessionFile) !== identity.sessionFile) throw new ReceiptPending("OMP transcript changed during receipt verification");
    fsyncSync(fd);
    const final = statSync(identity.sessionFile), finalFd = fstatSync(fd);
    if (final.dev !== after.dev || final.ino !== after.ino || finalFd.size !== after.size || finalFd.mtimeMs !== after.mtimeMs || finalFd.ctimeMs !== after.ctimeMs) throw new ReceiptPending("OMP transcript changed during durability verification");
    const entry = matches[0];
    return entry ? { operationId, payloadHash: payloadHash(text), sessionId: identity.sessionId, sessionFile: identity.sessionFile, entryId: entry.id, receiptId: `omp-entry:${identity.sessionId}:${entry.id}` } : undefined;
  } finally { closeSync(fd); }
}
