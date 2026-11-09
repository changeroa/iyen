[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex runtime

Iyen mode turns the current Codex conversation into the messenger lead. Ask “이연 모드 시작” with the `iyen` skill installed: the same session receives owner messages and delegates work into independent worker sessions. No separate lead session is created.

OMP (oh-my-pi) is also available through an [opt-in, isolated runtime profile](skills/dori-mode/references/setup.md#opt-in-omp-profile-alongside-codex). Codex remains the default. OMP supports attaching an explicitly prepared native conversation and launching managed workers; managed pause and recovery require the linked OMP fork with `executionHold` support.

Activation requires the current Herdr session to be loaded in the running local Codex shared daemon; an unobservable standalone session is refused. The lead uses that existing session and daemon. Each worker lane runs a **real interactive Codex TUI in Herdr** connected to its own app-server endpoint. `dori serve` owns monitors and durable state; Codex owns reasoning, tools, turns and native goals; Herdr owns TUI start/resume, prompts, controls and exit. A read-only observer verifies exact persisted operation markers and turn/goal state; idle status is never a delivery receipt. Workers call a scoped stdio MCP tool. The existing lead uses a generation-scoped command bridge without changing its sandbox or loading a new MCP server. OMO is not required.

## Install and start

Requirements: Bun 1.3+, Herdr, git, and Codex CLI. Attached leads validate the matching CLI/daemon pair and required messaging capabilities instead of requiring each release in a version allowlist. Managed workers retain their configured version pin (default **0.163.0**). Use gh for GitHub Done signals and npm for published-package signals. Use the existing messenger integration or an ACK/replay adapter described below.

For attached leads, Herdr identifies the pane/session and supplies execution status; the Codex adapter verifies loaded identity and actual delivery receipts. Compatible updates reconnect the same session automatically using `runtime.externalBinary`. After closing the previous session, start a new conversation and ask for `iyen mode`: activation verifies that the old lead ended and records a handoff without replaying old mail. A still-live or unverified former lead requires explicit reconciliation. `dori health` distinguishes service recovery, ingress activity and held delivery; the ingress adapter's storage ACK is not a turn receipt. See [runtime recovery and handoff](skills/dori-mode/references/setup.md).

```sh
cd skills/dori-mode/scripts
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
dori launch fix-login --title "Fix login" --model MODEL --effort medium --brief /path/to/brief.md \
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

The Iyen skill guides read receipts and replies: for an owner message actually directed to Iyen, the lead adds an `eyes` reaction as the configured bot to that exact message, then answers in the original thread. The service does not generate routine working/completed/waiting acknowledgments or react automatically. In a group/channel, ambient owner conversation is context: reply only to a direct Iyen request or an unambiguous continuation of an Iyen exchange/task. Ordinary DMs addressed to Iyen need no mention. Preserve ingress grants; this is lead prompt judgment, not a mention-only filter. There is no fixed status-posting or thread-renaming cycle.

Ordinary authenticated owner messages always go to the lead, including follow-ups in a worker's report thread. The lead explicitly forwards worker instructions; a lane/thread association never captures the conversation. Explicit owner UI controls retain their lane/thread checks. Previously accepted queued or unknown entries are preserved for reconciliation, not automatically moved or replayed.

Native `ask` remains available. The native interaction bridge relays the actual pending question, selection, input or approval to its original owner thread and applies the owner's reply to the same native UI request. It is not a new prompt into a worker or a notification-only substitute. Replies are correlated with request IDs and exact session/controller generations; ambiguous or approval answers require the advertised request token. Local completion, expiration and session changes invalidate stale messenger replies. Secret-entry dialogs are not a credential collection channel through Slack.

This path requires native SDK support for listing and answering real pending UI requests. Restarting the Iyen service does not retrofit an already-running older native process. Preserve the same native session when updating it; a changed controller epoch requires explicit activation and verification of the new scoped binding. A version string or configured profile alone does not establish interaction readiness.

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
cd skills/dori-mode/scripts
bun test
bun run typecheck
```

Tests include separate daemon/session-host processes with fixture Codex and Herdr executables. They do not call real models or messenger APIs. Real CLI initialization, thread creation, paused-goal inspection and required MCP tool registration were separately checked without inference. Live model, connector and host sandbox behavior still require an isolated deployment smoke test. The local journal currently retains history without automatic rotation.

MIT. The installer retains the original upstream repository URL; that historical name is not a runtime dependency.

### Independent delivery watchdog

Run `dori watchdog loop` under a separate supervisor from `dori serve`. It polls every 10 seconds, records sustained faults after 60 seconds, and flags current-attachment mail overdue by 120 seconds. `dori watchdog once` performs one poll; `dori watchdog status` reads the retained incident ledger without contacting the service or sending anything. An unchanged `checkedAt` means the watchdog itself needs attention. RPC health responses include `serviceReachable: true` and a fresh `sampledAt`; fallback snapshots explicitly report `serviceReachable: false`.

The watchdog requires Python 3 for a kernel-held interprocess fence. It uses the resolved persistent `DORI_CONFIG`/`IYEN_HOME` installation, follows each current attachment dynamically, and retains up to 100 sanitized incidents in `STATE_DIR/watchdog/state.json` (owner-only permissions). It never records message bodies, credentials or raw CLI/RPC errors. It notifies only the exact currently bound conversation with `codex queue --thread UUID --message ...`, without `--resume`. A validated loaded observer UUID, canonical cwd, daemon socket and coherent active turn are required; approval, input, goal holds, owner pause, done review, detach, handoff and rebind all defer notification. Herdr mapping faults may be reported through this incident-only UUID route; normal owner mail retains strict Herdr verification. Queue acceptance does not prove prompt consumption; a durable exact user-message receipt confirms notification. Pending incidents survive recovery and missing targets. Uncertain attempts are reconciled by receipt and never blindly replayed or redirected to a newer generation.

On macOS, preview `dori watchdog install`, then run `dori watchdog install --apply` to write the versioned LaunchAgent plist. This writes configuration only. Use the returned `launchctl bootstrap gui/$(id -u) ...` command to load it; after updating merged source, use `launchctl kickstart -k gui/$(id -u)/dev.iyen.delivery-watchdog-v1` to restart only the watchdog. Stop it with `launchctl bootout gui/$(id -u)/dev.iyen.delivery-watchdog-v1`. The plist pins the resolved persistent config/state path and installed Bun/source paths; regenerate it after relocating those paths. The normal installer does not automatically activate this agent. On other systems, supervise `dori watchdog loop` with the same installation environment. SIGINT/SIGTERM stop polling and drain any bounded submission before releasing its fence. Neither watchdog installation nor its loop restarts global Herdr/Codex or the serving process.

### Native one-command launcher

After installation, use `iyen codex` or `iyen omp` to open or resume the exact
native lead and reconnect its Iyen bridge. `dori` remains the service/operator
CLI. Existing profiles/configuration are required; the launcher does not create
provider credentials or migrate history between runtimes.

Create `${XDG_CONFIG_HOME:-~/.config}/iyen/launchers.json`:

```json
{
  "version": 1,
  "profiles": {
    "codex": {
      "configPath": "~/.dori-codex/config.json",
      "service": {
        "start": ["my-supervisor", "start", "iyen-codex"],
        "stop": ["my-supervisor", "unload", "iyen-codex"],
        "stopped": ["my-supervisor", "verify-unloaded", "iyen-codex"]
      }
    },
    "omp": {
      "configPath": "~/.config/iyen/omp/config.json"
    }
  }
}
```

Replace the example supervisor argv with your own commands. `start` and `stop`
are paired, optional hooks; `stopped` is an optional additional zero-exit-code
check proving the supervisor job is unloaded. A stop hook must disable/unload
KeepAlive or equivalent restart behavior, wait for its job, and return success
only after that contract is satisfied. The launcher also waits for the pinned
service PID and its known descendants to exit; it never kills supervisor PIDs.
Without hooks, the launcher can start an owned service and records its intent,
but switching away requires explicit service control rather than guessing how
to stop it. Configure both profiles' hooks for automatic switching in both
directions.

Each config must exist, match its profile's exact `runtime.kind`, and use an
isolated state directory. Herdr's canonical `codex`/`omp` executable must match
the configured native executable (`runtime.externalBinary` for Codex when set).
The shared Codex daemon must already be available. OMP needs its configured
isolated settings, extension, provider, model, effort and approval mode. Ensure
the native executable's environment uses a compatible Bun version. Optional
profile `leadInstructionsPath` points to existing legacy LEAD instructions;
without it the launcher supplies the repository Iyen skill and configured
persona directory. Config and instruction paths may be absolute, home-relative,
or relative to the registry file.

```sh
iyen codex
iyen omp --no-switch
iyen codex --config /absolute/existing/config.json --registry /absolute/launchers.json
iyen omp --model MODEL_ID --effort high --json
iyen --help
```

Automatic switching is the default for registered receivers with the same
ingress ID and overlapping owners. It stops only the conflicting service and
preserves its native TUI. `--no-switch` refuses the conflict. Model/effort
precedence is explicit flags, saved effective lead values, then configured lead
values; worker/lane defaults never select the lead model.

Repeated commands reuse an already attached conversation, including a busy
lead, without another bootstrap. An exited TUI resumes its saved exact UUID
(and exact OMP JSONL file); a missing old pane creates a dedicated tab without
changing focus, then uses guarded reconnect after old ownership is proven absent.
Occupied or ambiguous panes, owner pauses, completion holds, pending restarts,
and unresolved lead delivery barriers require reconciliation. Unrelated worker
mail and old attachment histories stay untouched. The launcher never selects
`--last` or an arbitrary idle agent, clears an owner hold, or posts an activation
message to a messenger.

When `iyen omp` resumes an exited OMP from the original interactive shell, it
starts OMP as an inherited-terminal child and waits until that TUI exits. Only
the native child reads terminal input. The launcher first proves its foreground
job, exact owned lock helpers, and authenticated launcher-owned service are the
only processes directly under that shell job. Helpers and owned services run in
separate process groups;
background or suspended processes block startup. A different target pane still
uses Herdr's shell-prompt startup path. No pane move or ownership guard bypass
is needed for same-shell resume.

`--json` includes the scoped bridge and native identity for automation; ordinary
output only shows the session and pane. With an inherited-terminal OMP child,
the JSON result is printed after the TUI exits so it does not interrupt the TUI;
use a separate shell for immediate machine-readable launcher output.
A verified bootstrap receipt confirms
native delivery, not that the model has finished reading its instructions.
Durable intent is kept in `stateDir/launcher/launch.json` and service startup
intent in `stateDir/launcher-service.json`. After an uncertain native start or
prompt, repeat the same command to reconcile receipts without replay. An
explicit structured Herdr refusal before dispatch is recorded separately and
can be retried; timeouts, input failures, and lost responses retain their exact
startup intent and diagnostics without relaunching. An
uncertain service startup needs supervisor/process inspection before clearing
its startup intent; do not delete journals to force an unverified second start.
The launcher is operator-only and refuses scoped `DORI_CONTEXT`/lane credentials.
