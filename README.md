[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex runtime

Dori is an always-on messenger lead that delegates work into independent Codex sessions in Herdr tabs. The owner still talks to one bot; the lead keeps messenger threads, lane identity, progress and verified completion together.

The lead and every lane now use **Codex app-server**. `dori serve` owns monitors and durable state; Codex owns reasoning, tools, turns and native goals; Herdr owns the tabs. Runtime control uses RPC receipts rather than terminal text. Managed agents call a scoped stdio MCP tool, preserving the command sandbox. OMO is not required.

## Install and start

Requirements: Bun 1.3+, Codex CLI **0.163.0**, Herdr, git; gh for GitHub Done signals and npm for published-package signals. Use the existing messenger integration or an ACK/replay adapter described below.

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
```

For a new installation, copy `skills/dori-mode/references/config.example.json` to `~/.dori/config.json`. Set `defaultCwd`, `laneWorkspace`, thread hooks and owner-filtered ingress. Existing config must be migrated, not overwritten.

```sh
dori doctor
dori serve
# In another terminal:
dori lead
```

Doctor checks the pinned runtime, protocol, authentication metadata and models without calling a model. A local Codex login is used normally; secrets stay out of config and logs. No default model replacement occurs on failure.

## Work and completion

```sh
dori launch fix-login --title "Fix login" --brief /path/to/brief.md \
  --cwd /path/to/repo --worktree --thread "telegram:chat/topic" \
  --done "merged acme/app#412" --operation-id fix-login-1

dori input fix-login --text-file /path/to/follow-up.txt
dori pause fix-login
dori resume fix-login
dori claim-done fix-login --evidence "merged acme/app#412 at SHA"
```

Briefs define objective, scope and evidence. Concurrent writers use `--worktree`. The five-minute claim window, objections, live Done checks, resource guards and heavy slots remain. Dirty/untracked/unpushed work and unknown runtime state block cleanup. Closing saves the Codex thread and Git resume points; `dori reopen` continues the same thread in a new completion cycle.

Use `dori report` for milestones and `dori reply` for owner replies. Reports and input have stable IDs. Unknown delivery is retained in `dori mail list` and is never blindly retried. `dori approval list/respond` binds owner answers to the exact host generation and request. A failed pause still blocks dispatch.

Before routing a request, use `dori work similar --title "Task"` (or repeated `--tag`). Similar work taking at least `workThresholdSec` (default 120 seconds) goes to a lane. Time small direct tasks with `dori work start --title "Task"` and `dori work stop ID`; include start/end timestamps and elapsed seconds in the final report. Complex work gets bounded lane briefs, isolated worktrees for concurrent writers, and combined verification. Managed Codex leads use the equivalent MCP actions `work-similar`, `work-start` and `work-stop`; operator CLI commands call the same service.


## Messenger and personality

Telegram, Discord and Slack clients, typing/draft support, presence, voice transcription and thread tracking remain available. Choose the bot name and messenger during onboarding. For Slack, explicitly choose user-token or bot-token mode. The existing per-integration consent policy and writing style remain: mirror the owner, keep messages short, avoid emojis except the read receipt, and edit evolving status messages in place.

The service supervises configured ingress commands. They emit normalized owner messages with stable IDs and advance source cursors only after a durable ACK. Raw human-readable messenger watch output is not accepted directly. Thread hooks keep account credentials outside worker environments. See the exact [adapter and approval contracts](skills/dori-mode/references/scripts.md).

## Migration and recovery

```sh
dori migrate --dry-run
dori migrate --apply --handoff-file /path/to/handoff.json
```

Stop legacy workers first. Active lanes need explicit stopped-source confirmation and handoff briefs. Migration backs up config/state and preserves messenger threads, status, claims and history; legacy session IDs are archival data, never Codex thread IDs. No messages are sent and no workers are started during migration. Recover each lane, inspect it, and explicitly resume.

- [Setup and migration](skills/dori-mode/references/setup.md)
- [Session lifecycle and Done signals](skills/dori-mode/references/sessions.md)
- [CLI, settings, ingress and recovery](skills/dori-mode/references/scripts.md)
- [Onboarding](skills/dori-mode/references/onboarding.md)
- [Technical specification](docs/specs/codex-runtime-migration.md)

## Validation

```sh
cd skills/dori-mode/scripts
bun test
bun run typecheck
```

Tests include separate daemon/session-host processes with fixture Codex and Herdr executables. They do not call real models or messenger APIs. Real CLI initialization, thread creation, paused-goal inspection and required MCP tool registration were separately checked without inference. Live model, connector and host sandbox behavior still require an isolated deployment smoke test. The local journal currently retains history without automatic rotation.

MIT. The installer retains the original upstream repository URL; that historical name is not a runtime dependency.
