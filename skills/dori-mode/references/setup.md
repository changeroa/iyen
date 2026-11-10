# Codex setup

Keep the owner's bot name, messenger account, memory and onboarding consent. Managed work lanes use the configured Codex version pin (default **0.163.0**). Attached leads validate matching CLI/daemon versions, the queue command and required read-only API response contracts instead of a release allowlist. Optional goal observation can degrade without blocking otherwise verified messaging. Use a stable `runtime.externalBinary` path for the shared daemon CLI when managed `runtime.binary` points to a pinned release. Changing externalBinary does not alter managed startup.

Compatible updates reconnect the same verified Herdr pane/thread/cwd and daemon socket automatically, preserving the existing attachment and eligible pending input. Failed reconnects use bounded retries; identity changes and operator holds require explicit intervention. `lead-attach` remains an explicit same-session retry. Do not detach just to update Codex. The service never upgrades, starts, stops or replaces the owner's daemon.

For the normal reset flow, close the previous conversation, open a new one, and ask for `iyen mode`. The activation helper invokes `lead-activate`, which verifies the old TUI no longer owns that session, validates the new pane/thread/cwd and records an empty-mail handoff. Retrying resumes the same recorded operation. Persistent persona, settings and history survive; old messages are retained without replay. Idle or held status alone does not prove closure, and owner pauses are preserved.

To deliberately replace a still-live lead or transfer selected old mail, an operator first runs `lead-handoff-preview --from-thread-id OLD --thread-id NEW --pane PANE --cwd DIR`. Apply with `lead-handoff` using the same identities, a stable `--operation-id`, and repeated `--mail-id` selections (or explicit `--no-mail`). Preview is read-only. Only selected eligible queued messages transfer; sent, sending, unknown, receipted and reconciled messages remain untouched. The operation is durable and repeatable with the same ID and arguments. Never automatically replace another live lead or replay uncertain messages.

`dori health` reports service startup/recovery and delivery health separately. Before RPC is available, the operator CLI can read sanitized startup progress; a live PID or saved ready state is not proof of readiness. Scoped clients must authenticate and cannot use this local fallback. Ingress process status is not a claim that Slack's network connection is healthy; inspect recent accepted events and delivery backlog separately.

Registry updates that do not change state do not append snapshots. Startup reads records incrementally and restores each lane once; automatic durable compaction bounds retained state. Do not delete journal or mailbox files to speed up a restart. Preserve backups before operating on durable state.

## Install

Install Bun 1.3+, git, Herdr, Codex CLI, and gh for GitHub completion signals. Authenticate Codex using its normal login flow. Do not export credentials into config files. On this Mac, required secret reads use the configured op-agent wrapper and an explicit vault; inject only references into the consuming process.

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
```

Copy references/config.example.json to ~/.dori-codex/config.json only for a new installation. Set defaultCwd and an existing laneWorkspace. Set an explicit model and reasoning effort for workers; launch validates them against the installed catalog. The current-session lead retains its existing model, effort and permissions. The private sidecar inherits the established CODEX_HOME settings/tools/plugins/auth/history and adds process-scoped Dori overrides without writing global config. Set runtime.settingsHome only when selecting another established settings home. Configure sandbox and approval policy explicitly; installation never relaxes them. Preserve existing config and use migration for legacy installs.

`dori paths` inspects persistent paths without contacting the service. CLI,
installer and activation resolve config on each invocation: explicit helper
`--config`, helper `--home`, inherited `DORI_CONFIG`, `IYEN_HOME/config.json`, then
existing `~/.dori-codex/config.json` or legacy `~/.dori/config.json`. Without an
existing installation the default is `~/.dori-codex/config.json`.
`--home` overrides inherited `DORI_CONFIG`; an explicit config wins over both.
Set the same selector for service startup and activation. New installations write
an explicit `state/` path beside the config; existing `stateDir` remains
authoritative, and older configs omitting it retain `~/.dori/state`. Persona
defaults to `persona/`, falling back to existing `memory/` in that same directory;
optional `personaDir` selects another established path. Relative configured paths
resolve beside the config. Activation returns all absolute paths and does not
move, overwrite, or initialize persistent data. Keep the running session's
`CODEX_HOME` separate from this service directory.

```sh
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
```

Keep serve running in the host's process supervisor. Link this repository's `skills/iyen` directory into `~/.codex/skills/iyen`, then ask the current Codex conversation to start Iyen mode. The skill verifies the current UUID and pane and runs:

```sh
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
```

The current conversation becomes the lead. No new lead TUI or private backend is created. The returned absolute `bridge` executable provides scoped lead commands; its status self-check must succeed before activation is reported. It requires the current sandbox to permit that executable and local socket access; permissions are never widened automatically. `stop --session UUID` revokes routing without closing the conversation. Managed worker lanes keep their own tabs, Codex processes and scoped stdio MCP tools.

## Messenger

Ask the owner to choose Telegram, Discord or Slack and finish login themselves. For Slack, retain the user-token versus bot-token choice: user accounts use their member visibility and paid seat; bots use granted scopes and invited channels. Ask before onboarding each new integration, as described in onboarding.md.

Existing messenger clients and agent-messenger can be used through argv hooks and ingress adapters. The repository does not assume an undocumented watch-output format. An adapter must normalize messages into the ACK/replay contract in scripts.md; a raw human-readable watch stream is not valid ingress.

- threadReply hook: argv with {thread}, {text}, {key}; exit zero only after the remote service accepts it.
- threadDone hook: completion marker with the same arguments.
- transcribe hook: argv with {file}; outputs a transcript.
- ingress: id, command argv and exact owner IDs. The service starts and supervises it.

Credentials belong in the environment of the service/messenger adapter. Work-lane Codex processes receive a restricted environment. The owner can answer pending approvals locally with dori approval list/respond or through authenticated structured ingress control events.

## Legacy state

Stop the old lead, monitor processes and workers before apply. Preview first:

```sh
dori migrate --dry-run
```

For active lanes, prepare a JSON handoff file:

```json
{"stoppedConfirmed":true,"lanes":{"fix-login":"/absolute/path/fix-login-handoff.md"}}
```

Each brief must record objective, changes, evidence, remaining work and owner questions. Apply:

```sh
dori migrate --apply --handoff-file /absolute/path/handoff.json
```

The migration backs up config/state, retains messenger references, histories and deadlines, and archives legacy session IDs. It creates no Codex thread and sends no messages. Active lanes remain held. Start serve, recover each lane, inspect the new context, then resume on the owner's instruction. Legacy transcripts are not imported as Codex internal history.

Keep backup data until the new runtime has been validated. Do not let an old binary read v2 state. Do not run old and new writers against the same checkout or messenger stream.

Untrusted working directories retain Codex’s real folder-trust UI. Startup reports a blocked TUI; Dori does not accept trust or write global project trust on the owner’s behalf. Use an already trusted workspace or resolve the visible trust UI explicitly before launch.

## Opt-in OMP profile alongside Codex

For deterministic legacy lead bootstrap and separate
provider/authentication readiness checks, see [OMP operations](omp-operations.md).
For existing Slack/Discord pane dispatchers, see [legacy compatibility](legacy-compat.md);
the opt-in shim preserves their receive/accept/finish/outbound stack and defaults
to installation dry-run. Source ACK, native input receipt and messenger completion
are separate stages.

The installer and `config.example.json` retain their Codex defaults. Use the
separate [OMP example](config.omp.example.json) for an opt-in profile; leave your
installed Codex config, service, credentials and state in place. The procedure
below creates a separate local profile with no messenger hooks or ingress. It
is not production activation or a migration of Codex IDs/history.

OMP requires the tested Bun >=1.4.4 and the configured native OMP binary/version.
OMP does not implement Codex OS isolation: explicitly select `danger-full-access` and an
OMP approval mode. `workspace-write` and `read-only` requests are rejected.

Choose absolute paths and a provider/model available in your isolated OMP
profile. These variables are examples to replace, not installed-machine paths:

```sh
export IYEN_REPO="/absolute/path/to/iyen"
export IYEN_OMP_HOME="/absolute/path/to/isolated-iyen-omp"
export OMP_BIN="/absolute/path/to/fork/omp"
export BUN_BIN="/absolute/path/to/compatible/bun"
export OMP_CWD="/absolute/path/to/project"
export OMP_PROVIDER="EXPLICIT_PROVIDER_ID"
export OMP_MODEL="EXPLICIT_MODEL_ID"
export IYEN_CLI="$IYEN_REPO/skills/dori-mode/scripts/src/cli.ts"
export IYEN_EXTENSION="$IYEN_REPO/skills/dori-mode/scripts/src/runtime/omp/extension.ts"
mkdir -p "$IYEN_OMP_HOME/agent" "$IYEN_OMP_HOME/controllers"
chmod 700 "$IYEN_OMP_HOME" "$IYEN_OMP_HOME/agent" "$IYEN_OMP_HOME/controllers"
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ["IYEN_REPO"])
home = Path(os.environ["IYEN_OMP_HOME"])
config = json.loads((root / "skills/dori-mode/references/config.omp.example.json").read_text())
config.update(stateDir=str(home / "state"), defaultCwd=os.environ["OMP_CWD"])
runtime = config["runtime"]
runtime.update(binary=os.environ["OMP_BIN"], settingsHome=str(home / "agent"))
runtime["omp"].update(registryDir=str(home / "controllers"), extensionPath=os.environ["IYEN_EXTENSION"], provider=os.environ["OMP_PROVIDER"])
# Never replace a pre-existing profile accidentally.
with (home / "config.json").open("x") as stream:
    json.dump(config, stream, indent=2)
(home / "config.json").chmod(0o600)
PY
```

Authenticate/configure the chosen provider in this explicit OMP settings home
through its normal supported setup. Do not copy Codex credentials, native
transcripts or production Iyen state into it. A custom extension provider must
load from this isolated profile or its explicit OMP wrapper. Model selection belongs
to the native lead session. OMP worker lanes are no longer supported.

### Load the extension in the intended native TUI

For a conversation you explicitly choose to start with OMP, open an available
Herdr shell pane and verify its pane/tab/workspace using `herdr pane current
--current`. Preserve the returned IDs; do not substitute the UI-focused pane or
another worker's inherited IDs. From that pane and the intended project cwd,
start the TUI with the private registry and extension explicitly enabled:

```sh
cd "$OMP_CWD"
# Set these to the IDs just verified for this shell pane:
export VERIFIED_PANE="RETURNED_PANE_ID"
export VERIFIED_TAB="RETURNED_TAB_ID"
export VERIFIED_WORKSPACE="RETURNED_WORKSPACE_ID"
env -i HOME="$HOME" PATH="$(dirname "$BUN_BIN"):$PATH" TERM="${TERM:-xterm-256color}" \
  HERDR_ENV=1 HERDR_PANE_ID="$VERIFIED_PANE" HERDR_TAB_ID="$VERIFIED_TAB" HERDR_WORKSPACE_ID="$VERIFIED_WORKSPACE" \
  PI_CODING_AGENT_DIR="$IYEN_OMP_HOME/agent" IYEN_OMP_REGISTRY_DIR="$IYEN_OMP_HOME/controllers" \
  "$OMP_BIN" --model "$OMP_PROVIDER/$OMP_MODEL" --thinking medium --approval-mode always-ask \
  --extension "$IYEN_EXTENSION"
```

This is an explicit new-conversation setup command, not an instruction to
restart a borrowed live conversation. For an existing TUI, attachment requires
that it already has the explicit registry environment and loaded extension.
If it does not, activation is unavailable: do not inject into it, spawn a second
observer runtime, restart it or resume its transcript automatically. Ask for
explicit user-controlled extension setup or use a separately chosen prepared
conversation. The OMP wrapper must preserve native `omp` process identity for
Herdr detection; raw `bun cli.ts` is not an equivalent launch.

### Start the isolated service and verify the native target

In a separate supervisor/shell, retain the same profile selector. Doctor is
read-only: missing controller, receipt storage or native capability is an
explicit failure, and it sends no model handshake prompt.

```sh
env -u DORI_CONTEXT -u DORI_LANE_KEY -u DORI_LANE_TOKEN \
  DORI_CONFIG="$IYEN_OMP_HOME/config.json" DORI_STATE_DIR="$IYEN_OMP_HOME/state" \
  "$BUN_BIN" "$IYEN_CLI" doctor
env -u DORI_CONTEXT -u DORI_LANE_KEY -u DORI_LANE_TOKEN \
  DORI_CONFIG="$IYEN_OMP_HOME/config.json" DORI_STATE_DIR="$IYEN_OMP_HOME/state" \
  "$BUN_BIN" "$IYEN_CLI" serve
```

Leave `serve` running. In another shell inspect `herdr agent list` and the private
registry's JSON descriptor. The descriptor contains no bearer secret; never
print its `tokenFile` contents. Match **all** of native `sessionId` UUID,
canonical `sessionFile`, `cwd`, `paneId`, `terminalId` and current controller
instance/generation. Herdr must report that exact session-file path with
`agent: omp`, `kind: path`, `source: herdr:omp` in the same pane/terminal. Do not
choose the newest descriptor, a matching cwd alone or the focused pane. Set
`OMP_SESSION_UUID`, `OMP_SESSION_FILE`, `VERIFIED_PANE`, `VERIFIED_TERMINAL` to
these verified values.

### Attach, inspect, detach and hand off

**Run activate.py from the OMP session's actual cwd.** The helper uses its own
`Path.cwd()` in the attachment request. Its Bun lookup uses PATH, so prepend the
compatible Bun binary directory. Always pass the explicit isolated `--config`:

```sh
cd "$OMP_CWD"
export PATH="$(dirname "$BUN_BIN"):$PATH"
python3 "$IYEN_REPO/skills/iyen/scripts/activate.py" start --runtime omp \
  --config "$IYEN_OMP_HOME/config.json" --session "$OMP_SESSION_UUID" \
  --session-file "$OMP_SESSION_FILE" --pane "$VERIFIED_PANE" --terminal-id "$VERIFIED_TERMINAL"
python3 "$IYEN_REPO/skills/iyen/scripts/activate.py" status --runtime omp \
  --config "$IYEN_OMP_HOME/config.json" --session "$OMP_SESSION_UUID" \
  --session-file "$OMP_SESSION_FILE" --pane "$VERIFIED_PANE" --terminal-id "$VERIFIED_TERMINAL"
python3 "$IYEN_REPO/skills/iyen/scripts/activate.py" stop --runtime omp \
  --config "$IYEN_OMP_HOME/config.json" --session "$OMP_SESSION_UUID" \
  --session-file "$OMP_SESSION_FILE" --pane "$VERIFIED_PANE" --terminal-id "$VERIFIED_TERMINAL"
```

Start is idempotent for the exact same controller/attachment. Stop revokes Iyen
routing and its scoped bridge; it leaves the borrowed native TUI and goal alive.
Public `pause`, `resume`, `close` and managed `stop` controls are unsupported for
borrowed leads. Iyen readiness/handoff delivery gates do not pause the user's
native execution. OMP lane launch/adoption and recovery are no longer supported.
Existing OMP lane records remain visible in status; use `close KEY` to retire only
the record, preserving files, panes and queued/unknown mail. Start new work in a
Codex lane under a Codex profile.

For a different explicitly verified target, run from that target's actual cwd
and reuse its native metadata. Preview is read-only; apply requires stable ID
and either selected queued mail IDs or `--no-mail`:

```sh
python3 "$IYEN_REPO/skills/iyen/scripts/activate.py" handoff-preview --runtime omp \
  --config "$IYEN_OMP_HOME/config.json" --session "$OMP_SESSION_UUID" \
  --session-file "$OMP_SESSION_FILE" --pane "$VERIFIED_PANE" --terminal-id "$VERIFIED_TERMINAL" \
  --from-session "$PREVIOUS_OMP_UUID"
python3 "$IYEN_REPO/skills/iyen/scripts/activate.py" handoff --runtime omp \
  --config "$IYEN_OMP_HOME/config.json" --session "$OMP_SESSION_UUID" \
  --session-file "$OMP_SESSION_FILE" --pane "$VERIFIED_PANE" --terminal-id "$VERIFIED_TERMINAL" \
  --from-session "$PREVIOUS_OMP_UUID" --operation-id "$STABLE_HANDOFF_ID" --no-mail
```

Use repeated `--mail-id` instead of `--no-mail` only for explicitly selected
eligible queued mail. Unknown, attempted, sent and historical operations do not
automatically replay. Unknown input reconciles only from the exact durable native
user-entry receipt; `omp-entry:...` is an opaque receipt, never a Codex turn ID.
