[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Iyen — Codex and OMP runtimes

Iyen is the messenger lead and lane orchestration system. Codex and OMP (oh-my-pi) are runtime components of this repository, not separate Iyen products. The `iyen` skill attaches the current verified conversation as the lead; it does not create a separate lead session.

| Component | Source | Responsibility |
|---|---|---|
| Iyen core | `src/` | Owner routing, scoped control, durable delivery, lane lifecycle and completion |
| Codex runtime | `src/runtime/codex/` | Codex RPC, generated protocol types, read-only observation and current-session attachment |
| OMP runtime | `src/runtime/omp/` | OMP extension, receipts, scoped tool, attachment and managed-worker integration |
| Shared runtime host | `src/runtime/` | Host lifecycle, Herdr coordination and runtime state contracts |
| Agent skills | `skills/` | Lead operating instructions, activation helpers and configuration examples |

Select the component with `runtime.kind`: `codex` (the existing default) or `omp`. Both use the same Iyen service and lane/messenger lifecycle. OMP setup uses an [isolated runtime profile](skills/dori-mode/references/setup.md#opt-in-omp-profile-alongside-codex); managed pause and recovery require the documented OMP fork with `executionHold` support. Runtime-native model, permission and identity checks remain unchanged.

Run installation, type checking and tests from the repository root. The `dori` command and existing persistent config/persona locations are unchanged. When upgrading an installed checkout from the former skill-local package layout, regenerate source-pinned launchers/attachments and watchdog configuration through the documented operator lifecycle, and update an OMP profile's `extensionPath` to `/absolute/iyen/src/runtime/omp/extension.ts`. Do not relocate a serving checkout underneath an active lead or replay pending sends. This source refactor does not perform a live deployment.

## Install and start

Requirements: Bun 1.3+, Herdr, git, and the selected runtime (Codex CLI or the configured OMP binary/extension). Codex attached leads validate the matching CLI/daemon pair and required messaging capabilities; managed Codex workers retain their configured version pin (default **0.163.0**). OMP validates its configured version and exact native identity. Use gh for GitHub Done signals and npm for published-package signals.

For attached leads, Herdr identifies the pane/session and supplies execution status; the Codex adapter verifies loaded identity and actual delivery receipts. Compatible updates reconnect the same session automatically using `runtime.externalBinary`. After closing the previous session, start a new conversation and ask for `iyen mode`: activation verifies that the old lead ended and records a handoff without replaying old mail. A still-live or unverified former lead requires explicit reconciliation. `dori health` distinguishes service recovery, ingress activity and held delivery; the ingress adapter's storage ACK is not a turn receipt. See [runtime recovery and handoff](skills/dori-mode/references/setup.md).

```sh
cd /path/to/iyen
bun install --frozen-lockfile
bun link
```

For a new installation, copy `skills/dori-mode/references/config.example.json` to `~/.dori-codex/config.json`. Set `defaultCwd`, an existing `laneWorkspace` for workers, thread hooks and owner-filtered ingress. Existing config must be migrated, not overwritten.

The installation directory persists independently of Codex conversations. CLI,
installer and activation share config discovery: `DORI_CONFIG`, then
`IYEN_HOME/config.json`, then existing `~/.dori-codex/config.json` or legacy
`~/.dori/config.json` (new installations default to `~/.dori-codex`). The helper
also accepts `--config PATH` or `--home DIR`. Run `dori paths` to see the selected
absolute config, state and persona paths without contacting the service.
Discovery happens on every invocation. Set `IYEN_HOME` consistently for service
startup and activation when choosing a different persistent directory.

For new installations, `config.json` holds settings, an explicit `state/` store
holds durable service history and `persona/` holds `IDENTITY.md`, `SOUL.md`,
`USER.md` and `MEMORY.md`. Existing `stateDir` and optional `personaDir` are
honored; existing configs omitting `stateDir` retain the historical `~/.dori/state`
default. Relative configured paths resolve against the config directory. If `persona/`
does not exist, an existing installation-local `memory/` is used for legacy
compatibility. No data is moved or overwritten during activation. This home is
separate from `CODEX_HOME`; attaching does not change the running Codex session's
settings or authentication.

```sh
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
# In the current Codex session, with its verified UUID and Herdr pane:
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
```

Install the activation skill by linking `/path/to/iyen/skills/iyen` into `~/.codex/skills/iyen`. The helper returns a scoped executable; lead commands use that path rather than an old `dori` from PATH. `stop --session UUID` detaches routing while leaving the Codex conversation open. Eligible messages reach a working session through its verified Herdr TUI without waiting for the current response to finish. Delivery remains held while the session is unavailable, awaiting approval or user input, or explicitly held.

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

The Iyen skill guides read receipts and replies: after reading an owner message, the lead adds an `eyes` reaction as the configured bot to that exact message, then answers in the original thread. The service does not generate routine working/completed/waiting acknowledgments or react automatically. There is no fixed status-posting or thread-renaming cycle.

Ordinary authenticated owner messages always go to the lead, including follow-ups in a worker's report thread. The lead explicitly forwards worker instructions; a lane/thread association never captures the conversation. Explicit owner UI controls retain their lane/thread checks. Previously accepted queued or unknown entries are preserved for reconciliation, not automatically moved or replayed.

The service supervises configured ingress commands. They emit normalized owner messages with stable IDs and advance source cursors only after a durable protocol ACK. The delivered envelope includes the source message ID separately from the reply thread. This internal ACK is not a messenger reply or a read receipt. Raw human-readable messenger watch output is not accepted directly. Thread hooks keep account credentials outside worker environments. See the exact [adapter and approval contracts](skills/dori-mode/references/scripts.md).

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
cd /path/to/iyen
bun test
bun run typecheck
```

Tests include separate daemon/session-host processes with fixture Codex and Herdr executables. They do not call real models or messenger APIs. Real CLI initialization, thread creation, paused-goal inspection and required MCP tool registration were separately checked without inference. Live model, connector and host sandbox behavior still require an isolated deployment smoke test. The local journal currently retains history without automatic rotation.

MIT. The installer uses the `changeroa/iyen` repository.

### Independent delivery watchdog

Run `dori watchdog loop` under a separate supervisor from `dori serve`. It polls every 10 seconds, records sustained faults after 60 seconds, and flags current-attachment mail overdue by 120 seconds. `dori watchdog once` performs one poll; `dori watchdog status` reads the retained incident ledger without contacting the service or sending anything. An unchanged `checkedAt` means the watchdog itself needs attention. RPC health responses include `serviceReachable: true` and a fresh `sampledAt`; fallback snapshots explicitly report `serviceReachable: false`.

The watchdog requires Python 3 for a kernel-held interprocess fence. It uses the resolved persistent `DORI_CONFIG`/`IYEN_HOME` installation, follows each current attachment dynamically, and retains up to 100 sanitized incidents in `STATE_DIR/watchdog/state.json` (owner-only permissions). It never records message bodies, credentials or raw CLI/RPC errors. It notifies only the exact currently bound conversation with `codex queue --thread UUID --message ...`, without `--resume`. A validated loaded observer UUID, canonical cwd, daemon socket and coherent active turn are required; approval, input, goal holds, owner pause, done review, detach, handoff and rebind all defer notification. Herdr mapping faults may be reported through this incident-only UUID route; normal owner mail retains strict Herdr verification. Queue acceptance does not prove prompt consumption; a durable exact user-message receipt confirms notification. Pending incidents survive recovery and missing targets. Uncertain attempts are reconciled by receipt and never blindly replayed or redirected to a newer generation.

On macOS, preview `dori watchdog install`, then run `dori watchdog install --apply` to write the versioned LaunchAgent plist. This writes configuration only. Use the returned `launchctl bootstrap gui/$(id -u) ...` command to load it; after updating merged source, use `launchctl kickstart -k gui/$(id -u)/dev.iyen.delivery-watchdog-v1` to restart only the watchdog. Stop it with `launchctl bootout gui/$(id -u)/dev.iyen.delivery-watchdog-v1`. The plist pins the resolved persistent config/state path and installed Bun/source paths; regenerate it after relocating those paths. The normal installer does not automatically activate this agent. On other systems, supervise `dori watchdog loop` with the same installation environment. SIGINT/SIGTERM stop polling and drain any bounded submission before releasing its fence. Neither watchdog installation nor its loop restarts global Herdr/Codex or the serving process.
