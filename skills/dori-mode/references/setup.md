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
