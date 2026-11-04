#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.DORI_STATE_DIR!, args = process.argv.slice(2);
appendFileSync(join(dir, "external-codex-calls.jsonl"), JSON.stringify(args) + "\n");
if (args.join(" ") === "app-server daemon version") {
  const { socketPath, serverVersion = "0.163.0" } = await Bun.file(join(dir, "external-state.json")).json();
  console.log(JSON.stringify({ status: "running", cliVersion: process.env.DORI_EXTERNAL_FIXTURE_VERSION ?? "0.163.0", appServerVersion: serverVersion, socketPath }));
} else if (args.join(" ") === "queue --help") {
  console.log("Queue a message for an existing session\n  --thread <ID>\n  --message <TEXT>");
} else if (args[0] === "queue" && args[1] === "--thread" && args[3] === "--message") {
  const state = await Bun.file(join(dir, "external-state.json")).json();
  if (args[2] !== state.thread.id || state.thread.status.type !== "idle") throw new Error("fixture queue thread not idle");
  // queue/add acknowledgement leaves the loaded idle native thread unchanged.
  console.log("Queued without starting a turn");
} else throw new Error(`External session must not launch or mutate daemon: ${args.join(" ")}`);
