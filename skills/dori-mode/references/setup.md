# Codex setup

Keep the owner's bot name, messenger account, memory and onboarding consent. Managed work lanes use the configured Codex version pin (default **0.163.0**). Attached leads support matching CLI/daemon pairs **0.163.0/0.163.0** and **0.164.0/0.164.0**, validated against the local protocol and attachment tests. Other pairs remain held. Use `runtime.externalBinary` for the shared daemon CLI when managed `runtime.binary` points to a pinned release. Changing externalBinary does not alter managed startup. After a supported daemon update, explicitly attach the same session again; do not detach first, because eligible pending input belongs to the existing attachment.

## Install

Install Bun 1.3+, git, Herdr, Codex CLI, and gh for GitHub completion signals. Authenticate Codex using its normal login flow. Do not export credentials into config files. On this Mac, required secret reads use the configured op-agent wrapper and an explicit vault; inject only references into the consuming process.

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
```

Copy references/config.example.json to ~/.dori-codex/config.json only for a new installation. Set defaultCwd and an existing laneWorkspace. Set an explicit model and reasoning effort for workers; launch validates them against the installed catalog. The current-session lead retains its existing model, effort and permissions. The private sidecar inherits the established CODEX_HOME settings/tools/plugins/auth/history and adds process-scoped Dori overrides without writing global config. Set runtime.settingsHome only when selecting another established settings home. Configure sandbox and approval policy explicitly; installation never relaxes them. Preserve existing config and use migration for legacy installs.

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
