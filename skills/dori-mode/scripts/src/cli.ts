#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig, defaultConfig } from "./config.ts";
import { serviceClient } from "./ipc.ts";
import { serve } from "./service.ts";
import { runSessionHost, startSessionHost } from "./runtime/session-host.ts";
import { doctor } from "./doctor.ts";
import { migrate } from "./migrate.ts";
import { mcpServer } from "./mcp.ts";
import { utilities } from "./utilities.ts";
import { atomicJson } from "./journal.ts";
import { join } from "node:path";
const help = `dori — Codex-only messenger lead and lanes

  doctor | serve | status [key]
  lead-attach --thread-id UUID --pane ID --cwd DIR
  lead-detach --thread-id UUID
  launch KEY --title T --brief FILE --done SIGNALS [--thread REF] [--cwd DIR] [--model M] [--worktree]
  input KEY --text-file FILE [--operation-id ID]
  report KEY --kind milestone|blocker|question|done --text-file FILE --event-id ID
  reply --thread REF --text-file FILE [--operation-id ID]
  claim-done [KEY] --evidence TEXT
  object-done KEY --reason TEXT [--reason TEXT]
  pause KEY | resume KEY | close KEY [--note TEXT]
  recover KEY | reopen KEY [--text-file FILE] [--new-session --handoff-file FILE]
  adopt KEY --thread-id ID --pane ID --title T --brief FILE --done SIGNALS --transfer-confirmed
  sync [--write] | can-launch | watch | freshness | dead-panes | guard
  approval list | approval respond ID --response-file FILE
  mail list | mail resolve ID --box inbox|outbox --state queued|sent --evidence TEXT
  migrate --dry-run | migrate --apply
  work start --title T [--tag TAG ...] [--thread REF] [--operation-id UUID]
  work stop ID | work similar [--title T] [--tag TAG ...]
  heavy LABEL -- COMMAND ...
  send slack|telegram|discord --to TARGET --text TEXT [--thread ID] [--edit ID]
  presence slack|discord | transcribe FILE | inbound slack [--loop MIN]

Always start dori serve before lifecycle commands. Operations with unknown delivery are not replayed.
Use --operation-id to repeat a request safely; status/mail list show durable outcomes.`;
const [command = "", ...rest] = process.argv.slice(2);
const flags = parseArgs({ args: rest, allowPositionals: true, strict: true, options: Object.fromEntries([
  ...["title", "brief", "done", "thread", "model", "cwd", "pane", "evidence", "note", "loop", "to", "text", "edit", "text-file", "operation-id", "event-id", "kind", "thread-id", "response-file", "state-dir", "handoff-file", "key", "box", "state"].map(k => [k, { type: "string" }]),
  ...["write", "worktree", "transfer-confirmed", "dry-run", "apply", "help", "new-session"].map(k => [k, { type: "boolean" }]),
  ["reason", { type: "string", multiple: true }],
  ["tag", { type: "string", multiple: true }],
]) as any });
const values = flags.values as Record<string, string | boolean | string[] | undefined>;
const opt = (name: string): string | undefined => typeof values[name] === "string" ? String(values[name]) : undefined;
const need = (name: string): string => { const value = opt(name); if (!value) throw new Error(`--${name} required`); return value; };
const output = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
try {
  if (!command || values.help || command === "help") { console.log(help); process.exit(0); }
  if (command === "migrate") { output(await migrate(Boolean(values.apply), undefined, opt("handoff-file") ? await Bun.file(need("handoff-file")).json() : undefined)); process.exit(0); }
  if (command === "session-host") {
    const stateDir = opt("state-dir") ?? process.env.DORI_STATE_DIR ?? defaultConfig().stateDir;
    try { await runSessionHost(stateDir, need("key")); }
    catch (error) { atomicJson(join(stateDir, "hosts", `${need("key")}.error.json`), { at: new Date().toISOString(), message: error instanceof Error ? error.message : "Runtime host failed" }); throw error; }
    process.exit(0);
  }
  if (command === "session-host-start") { startSessionHost(need("state-dir"), need("key")); process.exit(0); }
  const config = await loadConfig();
  if (command === "mcp-server") { await mcpServer(config); process.exit(0); }
  if (command === "serve") { await serve(config); process.exit(0); }
  if (command === "doctor") { const result = await doctor(config); output(result); process.exit(result.ok ? 0 : 2); }
  const key = flags.positionals[0] ?? process.env.DORI_LANE_KEY;
  if (await utilities(command, key, rest, config, opt)) process.exit(process.exitCode ?? 0);
  const call = serviceClient(config);
  const text = opt("text-file") ? await Bun.file(need("text-file")).text() : opt("text");
  const operationId = opt("operation-id") ?? crypto.randomUUID();
  let result: any;
  switch (command) {
    case "lead": case "lead-attach": result = await call("lead-attach", { threadId: need("thread-id"), pane: need("pane"), cwd: need("cwd") }); break;
    case "lead-detach": result = await call(command, { threadId: need("thread-id") }); break;
    case "work":
      if (key === "start") result = await call("work-start", { title: need("title"), tags: values.tag ?? [], thread: opt("thread"), operationId });
      else if (key === "stop") result = await call("work-stop", { id: flags.positionals[1] ?? (() => { throw new Error("work stop needs a work id"); })() });
      else if (key === "similar") result = await call("work-similar", { title: opt("title"), tags: values.tag ?? [] });
      else throw new Error("usage: dori work start --title T | stop ID | similar [--title T] [--tag TAG ...]");
      break;
    case "launch": case "adopt":
      result = await call(command, { key, title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), cwd: opt("cwd"), model: opt("model"), worktree: Boolean(values.worktree), operationId, pane: opt("pane"), threadId: opt("thread-id"), transferConfirmed: Boolean(values["transfer-confirmed"]) }); break;
    case "input": case "reply": result = await call(command, { key, text, thread: opt("thread"), operationId }); break;
    case "report": result = await call(command, { key, text, kind: need("kind"), eventId: need("event-id") }); break;
    case "claim-done": result = await call(command, { key, evidence: need("evidence") }); break;
    case "object-done": result = await call(command, { key, reasons: values.reason }); break;
    case "pause": case "resume": case "close": result = await call(command, { key, note: opt("note") }); break;
    case "reopen": case "recover": result = await call(command, { key, text, operationId, threadId: opt("thread-id"), newSession: Boolean(values["new-session"]), handoff: opt("handoff-file") ? await Bun.file(need("handoff-file")).text() : undefined }); break;
    case "status": case "can-launch": result = await call(command, { key }); break;
    case "sync": result = await call(command, { write: Boolean(values.write) }); break;
    case "approval":
      result = key === "list" ? await call("approval-list") : key === "respond" ? await call("approval-respond", { id: flags.positionals[1], response: await Bun.file(need("response-file")).json() }) : (() => { throw new Error("approval list|respond required"); })(); break;
    case "mail":
      result = key === "list" ? await call("mail-list") : await call("mail-resolve", { id: flags.positionals[1], box: need("box"), state: need("state"), evidence: need("evidence") }); break;
    case "watch": case "freshness": case "dead-panes": case "guard":
      result = await call("status"); break;
    default: throw new Error(`Unknown command ${command}`);
  }
  output(result);
  if (result?.code) process.exitCode = result.code;
  if (result?.startup && !result.startup.startsWith("STARTUP_OK")) process.exitCode = 3;
  if (command === "can-launch" && !result.ok) process.exitCode = 4;
  if (command === "close" && !result.closed) process.exitCode = 2;
} catch (error) { console.error(error instanceof Error ? error.message : "Command failed"); process.exitCode = 1; }
