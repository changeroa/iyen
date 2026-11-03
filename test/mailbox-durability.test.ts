import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { Mailbox } from "../src/mailbox.ts";
import { withState } from "./fakes.ts";

test("failed inbox creation and reassignment cannot get ahead of durable state on same-process retry", () => {
  const state = withState();
  try {
    const box = new Mailbox(state.dir, "inbox"), path = join(state.dir, "inbox.json");
    const row = { id: "selected", target: "lead", text: "saved input", state: "queued" as const, at: "2026-10-29T00:00:00Z", attachmentInstance: "old" };
    const rename = fs.renameSync;
    const failWrite = () => spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path) throw new Error("injected inbox replacement failure");
      return rename(from, to);
    });
    let failure = failWrite();
    try { expect(() => box.put(row)).toThrow("injected"); } finally { failure.mockRestore(); }
    expect(box.get(row.id)).toBeUndefined();
    box.put(row);
    failure = failWrite();
    try { expect(() => box.mark(row.id, { attachmentInstance: "new" })).toThrow("injected"); } finally { failure.mockRestore(); }
    expect(box.get(row.id)?.attachmentInstance).toBe("old");
    box.mark(row.id, { attachmentInstance: "new" });
    expect(new Mailbox(state.dir, "inbox").get(row.id)).toMatchObject({ state: "queued", attachmentInstance: "new" });
  } finally { state.done(); }
});

test("failure to persist sending state prevents the delivery side effect", async () => {
  const state = withState();
  try {
    const box = new Mailbox(state.dir, "inbox"), path = join(state.dir, "inbox.json");
    box.put({ id: "input", target: "lead", text: "task", state: "queued", at: "now" });
    const rename = fs.renameSync;
    const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path) throw new Error("injected sending write failure");
      return rename(from, to);
    });
    let submitted = 0;
    try { await expect(box.deliver("input", async () => { submitted++; return { turnId: "receipt" }; })).rejects.toThrow("injected"); }
    finally { failure.mockRestore(); }
    expect(submitted).toBe(0); expect(box.get("input")?.state).toBe("queued");
    await box.deliver("input", async () => { submitted++; return { turnId: "receipt" }; });
    expect(submitted).toBe(1); expect(new Mailbox(state.dir, "inbox").get("input")?.state).toBe("sent");
  } finally { state.done(); }
});
