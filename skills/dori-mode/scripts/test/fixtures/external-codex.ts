#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../src/journal.ts";
const dir = process.env.DORI_STATE_DIR!, args = process.argv.slice(2);
appendFileSync(join(dir, "external-codex-calls.jsonl"), JSON.stringify(args) + "\n");
if (args.join(" ") === "app-server daemon version") {
  const { socketPath, serverVersion = "0.163.0" } = await Bun.file(join(dir, "external-state.json")).json();
  console.log(JSON.stringify({ status: "running", cliVersion: process.env.DORI_EXTERNAL_FIXTURE_VERSION ?? "0.163.0", appServerVersion: serverVersion, socketPath }));
} else if (args[0] === "queue" && args[1] === "--thread" && args[3] === "--message") {
  const state = await Bun.file(join(dir, "external-state.json")).json();
  if (args[2] !== state.thread.id || state.thread.status.type !== "idle") throw new Error("fixture queue thread not idle");
  const turnId = crypto.randomUUID();
  const failed = args[4]?.startsWith("fixture-fail-auth");
  state.turns.push({ id: turnId, status: failed ? "failed" : "completed", items: [{ type: "userMessage", content: [{ type: "text", text: args[4] }] }],
    error: failed ? { codexErrorInfo: "unauthorized", message: "Authorization: Bearer fixture-secret" } : null });
  atomicJson(join(dir, "external-state.json"), state);
  console.log("Submitted");
} else throw new Error(`External session must not launch or mutate daemon: ${args.join(" ")}`);
