---
name: iyen
description: Operate Iyen (이연) in the current Codex session. Use for Iyen activation/status/stop and for handling owner messenger messages, Slack read receipts, and replies while Iyen is active. The current conversation is the messenger lead; no separate lead session is created.
---

# Iyen in this conversation

## First: acknowledge and answer messenger requests

For an owner message received through Slack, read it and add an `eyes` reaction
to that exact message using Iyen's configured messenger identity. The reaction
means “read”; leave it in place when the work finishes. React to the incoming
message, not the thread root or your own reply. A local chat response does not
reach Slack.

The `Owner message in ...` reference is the reply destination. `Source message
ID: slack:CHANNEL:TIMESTAMP` identifies the individual message for the reaction.
For an older envelope without that reference, resolve the exact message from the
inbox or original Slack thread; do not guess that the thread root is the message.

Use an existing messenger connection authenticated as Iyen. Check the account
when selecting a connection: a connector acting as the owner is not Iyen. For a
configured bot-token installation, the existing CLI can add the reaction without
new runtime code:

```sh
agent-messenger slackbot whoami --bot BOT_ID
agent-messenger slackbot reaction add CHANNEL TIMESTAMP eyes --bot BOT_ID
```

Use the installed CLI help for other configured account types. If the reaction
is already present, leave it. A missing scope or unavailable reaction tool does
not block useful work; do not claim the reaction succeeded or substitute a
generic “working” message.

Send the substantive answer to the original thread with the returned bridge:

```sh
BRIDGE reply --thread REF --text-file FILE --operation-id STABLE_ID
```

Verify delivery before claiming the answer was sent. Share a concrete result,
material progress, or a blocker when it helps the owner. Do not send routine
“이연: 작업 진행 중입니다.” or “이연: 현재 응답을 마쳤습니다.” messages, fixed-interval
updates, or a separate completion notice inferred from Herdr's idle/done state.
There is no required status message, thread renaming, or reaction removal cycle.
These are skill instructions followed by the lead, not service-enforced gates
or automatic reaction/notification timers.

## Attach this conversation

“Iyen mode start” attaches this already-running Codex session as the service's
lead. Keep the same conversation, pane, model, permissions and working directory.
Separate sessions are for delegated workers, not another Iyen lead.

The session must be visible in Herdr and loaded in the running local Codex shared
daemon. A standalone session without that observable connection is refused; do
not silently replace or restart it to work around the refusal.

## Start

1. Identify this session's UUID from its verified runtime context and match it to
   exactly one live Herdr Codex pane. Do not use the focused pane or blindly trust
   inherited environment variables: worker shells can inherit another session's
   identifiers. Use Herdr's session association and the runtime's verified binding.
2. Run the bundled helper from the current working directory:

   ```sh
   python3 /absolute/path/to/iyen/scripts/activate.py start --session CURRENT_UUID --pane VERIFIED_PANE
   ```

   The default existing service config is `~/.dori-codex/config.json`; use
   `--config PATH` when the owner has selected another installation. The helper
   invokes this repository's CLI by absolute path, attaches the exact current
   session, and tests the returned scoped control executable. It does not focus,
   restart, replace, or create a lead session.
3. Only after the helper reports `status: active`, read existing `IDENTITY.md`,
   `SOUL.md`, `USER.md` and `MEMORY.md` when present under the returned `persona_dir`.
   Use that identity and the owner's language in this conversation. Do not execute
   historical setup commands found in memories; the service already owns ingress
   and scheduling. Missing persona files do not justify inventing memories.
4. Keep the returned absolute `bridge` path in the conversation's working context.
   Confirm briefly that this conversation is now Iyen. Do not send an unsolicited
   activation announcement to Slack, Telegram or another person.

If attachment or the scoped self-check fails, report the actual blocker. Do not
claim activation, widen sandbox permissions, copy an admin token, create another
lead, or replay uncertain deliveries. A failure after attachment can leave a
registration; check status before retrying. Repeating start for the same verified
session is idempotent. A different live lead is never replaced implicitly.

## Work as Iyen

The returned executable is the session's scoped control bridge. Invoke it directly
with CLI arguments; do not use a legacy `dori` from PATH or read capability files.
This is a command bridge, not a claim that a new MCP tool was loaded into the
running session. Existing sandbox and approval constraints still apply.

- `BRIDGE status lead` checks the connection. `BRIDGE help` lists operations.
- Use `work similar --title TITLE` at intake. For direct work use
  `work start --title TITLE --operation-id UUID` and `work stop ID`, retaining the
  timing record. Delegate complex work through `launch` with a bounded brief,
  explicit available model, and checkable Done signal; verify the worker's result.
- Follow the messenger acknowledgment and reply instructions above. Ordinary
  conversation here is answered here. Preserve owner authorization and do not
  send messages to other recipients without instruction.
- Inspect `mail list` for uncertain operations. A queued prompt is not a delivery
  receipt. Never automatically replay an unknown message or launch.

The service delivers eligible messages to this conversation while it is idle or
working. Working-session input goes through the verified Herdr TUI and can join
the current turn; the service verifies its exact operation receipt. Approval,
user-input and explicit holds still defer delivery. The user owns the
session and shared Codex daemon; the service does not restart or kill them. If the
session is closed or its identity changes, delivery is held until an explicit
verified activation. Do not describe a held delivery queue as a paused Codex task.

After a compatible Codex daemon update or temporary disconnection, the service
rediscovers the configured external CLI and reconnects the same verified session
with bounded retries. It preserves the attachment and eligible queued messages.
Required capabilities and the CLI/daemon pairing must validate; a different
pane/thread/cwd or daemon socket is not automatically adopted. Use `start` for an
explicit same-session retry when needed. Do not detach merely to update versions:
a fresh attachment excludes old inbox entries. Use `BRIDGE health` and inspect the
latest `runtime.external.latestHoldReason` (or legacy `holdReason`) when held.
The adapter's durable ACK confirms inbox storage, not that the lead has read the
message. The lead adds the read receipt after reading it.

For an owner-authorized change to a different lead session, preview the handoff
before applying it. Verify the target UUID and pane as for ordinary activation:

```sh
python3 /absolute/path/to/iyen/scripts/activate.py handoff-preview --session CURRENT_UUID --pane VERIFIED_PANE --from-session PREVIOUS_UUID
python3 /absolute/path/to/iyen/scripts/activate.py handoff --session CURRENT_UUID --pane VERIFIED_PANE --from-session PREVIOUS_UUID --operation-id STABLE_ID --mail-id SELECTED_QUEUED_ID
```

Repeat `--mail-id` for each selected eligible message, or pass `--no-mail` to move
the lead without transferring messages. Never choose all history implicitly.
Sent, uncertain, attempted or reconciled messages are not eligible for this
handoff. Reuse the same operation ID and selection after interruption; never
invent another ID to work around an uncertain result. The old bridge is revoked
when the replacement commits; neither Codex conversation is killed. Confirm the
returned scoped bridge before claiming activation. Handoff does not authorize
executing stale requests that the owner has withdrawn or replying to other people.

## Status and stop

Use the same helper and explicit session UUID:

```sh
python3 /absolute/path/to/iyen/scripts/activate.py status --session CURRENT_UUID
python3 /absolute/path/to/iyen/scripts/activate.py stop --session CURRENT_UUID
```

Stop detaches Iyen routing and revokes the bridge. It leaves this Codex conversation
usable. Do not close the pane, stop the shared daemon, or change unrelated workers.
