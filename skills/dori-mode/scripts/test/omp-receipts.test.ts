import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { markedText, payloadHash } from "../src/runtime/omp/contract.ts";
import { OperationJournal, persistedReceipt, ReceiptPending } from "../src/runtime/omp/receipts.ts";
import { ompFixture } from "./fixtures/omp.ts";
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });

test("OMP durable receipt requires exact persisted user content on active branch", () => {
  const f = ompFixture();
  try {
    const text = markedText("work", "op");
    f.transcript([user("one", null, text), user("other", null, "other branch")]);
    expect(persistedReceipt(f.identity, "other", "work", "op")).toBeUndefined();
    const receipt = persistedReceipt(f.identity, "one", "work", "op")!;
    expect(receipt.entryId).toBe("one"); expect(receipt.receiptId).toBe(`omp-entry:${f.identity.sessionId}:one`);
    f.transcript([{ type: "custom", id: "custom", parentId: null, customType: "receipt", data: text },
      { type: "message", id: "assistant", parentId: "custom", message: { role: "assistant", content: [{ type: "text", text }] } }, user("near", "assistant", "prefix" + text)]);
    expect(persistedReceipt(f.identity, "near", "work", "op")).toBeUndefined();
  } finally { f.cleanup(); }
});
test("OMP receipt rejects duplicate matches, partial records, missing leaf and wrong session", () => {
  const f = ompFixture(); const text = markedText("work", "op");
  try {
    f.transcript([user("one", null, text), user("two", "one", text)]);
    expect(() => persistedReceipt(f.identity, "two", "work", "op")).toThrow("Multiple exact");
    f.transcript([user("one", null, text)], '{"type":');
    expect(() => persistedReceipt(f.identity, "one", "work", "op")).toThrow(ReceiptPending);
    f.transcript([]); expect(() => persistedReceipt(f.identity, "missing", "work", "op")).toThrow(ReceiptPending);
    writeFileSync(f.identity.sessionFile, JSON.stringify({ ...f.header, id: "different" }) + "\n");
    expect(() => persistedReceipt(f.identity, null, "work", "op")).toThrow("header mismatch");
  } finally { f.cleanup(); }
});
test("OMP journal fences crash cases and rejects changed content across restart", () => {
  const f = ompFixture(), path = join(f.directory, "operations.json"), digest = payloadHash("work");
  try {
    const first = new OperationJournal(path, f.identity);
    expect(first.reserve("op", digest)).toBe(true); expect(first.reserve("op", digest)).toBe(false);
    first.attempted("op", digest);
    const recovered = new OperationJournal(path, f.identity);
    expect(recovered.get("op", digest).status).toBe("unknown"); expect(recovered.reserve("op", digest)).toBe(false);
    expect(() => recovered.get("op", payloadHash("changed"))).toThrow("content changed");
    expect(new OperationJournal(path, { ...f.identity, generation: 2 }).get("op", digest).status).toBe("unknown");
    expect(() => new OperationJournal(path, { ...f.identity, laneKey: "other" })).toThrow("cannot be verified");
    f.transcript([user("one", null, markedText("work", "op"))]);
    recovered.received(persistedReceipt(f.identity, "one", "work", "op")!);
    expect(new OperationJournal(path, f.identity).get("op", digest).status).toBe("received");
  } finally { f.cleanup(); }
});
