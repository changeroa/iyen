# CLI and runtime

The Bun/TypeScript package exposes dori. Codex app-server runs the lead and each lane; dori serve owns lifecycle state, monitor schedules and durable input/output ledgers. Herdr owns tabs. Managed agents use the required `dori_runtime.control` stdio MCP tool; operator CLI and host control use local sockets. See sessions.md for Done signal grammar.

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

Unit tests use fake transports and clocks. The process integration test starts isolated fixture Codex/Herdr executables and Unix sockets; it never calls a model or messenger API.

## Configuration

Use ~/.dori/config.json or DORI_CONFIG. DORI_STATE_DIR overrides state placement. Config schemaVersion is 2. Legacy execution fields are rejected with a migration instruction.

| Field | Default / meaning |
|---|---|
| runtime.kind / binary / requiredVersion | codex / codex / 0.163.0 |
| runtime.roles.lead / lane | model and effort null: inherit Codex settings |
| runtime.sandbox / approvalPolicy | workspace-write / on-request |
| runtime.startupTimeoutMs / rpcTimeoutMs | 30000 / 15000 |
| runtime.heartbeatIntervalMs / heartbeatTimeoutMs | 5000 / 20000 |
| stateDir | ~/.dori/state; registry, mailboxes and direct-task timers |
| workThresholdSec | 120 seconds; historical duration at or above this means delegate next time |
| defaultCwd / laneWorkspace | home / current Herdr workspace |
| nudgeAfterMin / postAfterMin / closeAfterMin | 15 / 20 / 5 |
| heavySlots / heavyMaxLoad | 1 / 80 |
| guard | load 150/80, free memory 20%, disk 50GB, 20 panes |
| hooks | threadReply, threadDone, transcribe argv templates |
| ingress | owner-filtered, replayable JSON-line source processes |

Models must be IDs from Codex model/list. Provider/model routes and silent model fallback are not supported. The CLI requires the pinned version and doctor checks startup, authentication metadata, model selection and local tools without calling a model.

## Commands

Run dori help for all flags.

- `work start --title T [--tag TAG ...] [--thread REF] [--operation-id UUID]`: start a direct-task timer; return `{workThresholdSec,work}`. `work` contains a UUID id, title, tags, optional thread and `startedAt`. Repeat a start with the same UUID and content to retrieve its original record safely; changed content is refused.
- `work stop ID`: persist `endedAt` and `elapsedSec`, returning the record and threshold. Unknown or already-stopped ids fail without changing the record.
- `work similar [--title T] [--tag TAG ...]`: require a title or tag; return `{workThresholdSec,matches}` across completed direct tasks and completed lane cycles. Matching uses normalized words, character bigrams and tags. Running direct timers are excluded. Completed cycles remain discoverable after a lane reopens; execution ends at the final done claim when recorded, excluding the review window. Legacy lanes without claims use open-to-close time. History reads do not modify lane records.

Timers are private readable JSON at `<stateDir>/work/<id>.json` and survive service restarts. The service serializes timer writes. Start after the intake lookup and before work; stop immediately before the final reply and include start/end timestamps and elapsed seconds. Similarity supplies duration facts, not a routing verdict: delegate if similar work took at least the configured threshold; otherwise use the skill’s direct/complex-work rules. Resource HOLD still means queue.

Managed Codex leads use `dori_runtime.control` actions `work-start` (`title,tags?,thread?,operationId` with a stable UUID), `work-stop` (`id`), and `work-similar` (`title?,tags?`). These are lead/operator-only; lanes cannot read or change direct-task timers. Operators use the CLI above, which calls the same service. No sandbox CLI or extra network permission is needed.


- serve: one state writer, socket owner, monitor supervisor. A second owner is refused.
- lead: open the reserved Codex lead, once.
- launch KEY: validate Done, enforce resources, optionally create an owned worktree, create tab/host, persist thread.id, submit brief. Supply --operation-id when callers may replay requests.
- input KEY --text-file FILE: structured input; active turns are steered. Paused inputs remain queued.
- report KEY --kind KIND --text-file FILE --event-id ID: milestone/blocker/question/done event. A done report alone does not claim completion.
- reply --thread REF --text-file FILE --operation-id ID: durable messenger hook send, available to lead/operator.
- pause/resume/claim-done/object-done/close: lifecycle operations; see done-protocol.md.
- recover KEY: create a replacement host only after the old process is gone. It reuses a known thread or imports a legacy handoff into a new one. A thread created before registration is recovered from the host checkpoint. If creation itself is ambiguous, inspect Codex history and use recover KEY --thread-id ID; an already-known identity cannot be replaced.
- reopen KEY: new cycle on the same recorded thread, restoring an owned worktree when necessary.
- sync [--write]: read runtime/pane drift; write refreshes verified runtime state, never replaces a conflicting identity.
- watch/freshness/dead-panes/guard: compatibility status queries. The daemon owns the actual schedules; these do not launch duplicate loops.
- approval list: current pending server requests and generation-qualified IDs.
- approval respond ID --response-file FILE: operator response with the request's typed payload. Stale IDs are rejected.
- mail list: inbox, outbox and launch operations. Unknown delivery is visible and is not replayed automatically.
- mail resolve ID --box inbox|outbox --state sent|queued --evidence TEXT: operator reconciliation after checking external state. queued is for a proven non-execution.
- migrate --dry-run / --apply [--handoff-file FILE]: state migration with backups, no runtime launch.
- send/presence/transcribe/heavy: existing standalone utilities.
- inbound slack: existing read-only diagnostic polling output. Use a replayable adapter for supervised ingestion.

Exit codes: 0 success, 1 configuration/transport/request error, 2 refused lifecycle or failed doctor, 3 unconfirmed runtime operation, 4 queued launch HOLD. A nonzero or lost RPC result is not evidence that an external mutation failed to execute.

## Ingress adapter contract

Each configured process writes one JSON object per line to stdout:

```json
{"id":"stable-platform-message-id","thread":"telegram:chat/topic","user":"owner-id","text":"Please continue"}
```

After durable acceptance, the service writes this JSON line to the adapter's stdin:

```json
{"ack":"stable-platform-message-id","thread":"telegram:chat/topic"}
```

Advance source cursors only after the matching ACK. Replay unacknowledged messages after reconnect; deduplication keys include source, thread and message ID. stdout must contain only events; write diagnostics to stderr. Do not use ephemeral unread-count notifications as message IDs. Resolve Slack unread hints to actual messages before submitting them. Quoted/forwarded messages remain content under the authenticated sender, never a new owner identity.

The optional control field is for explicit owner UI actions. The service validates owner identity and target thread before dispatch:

```json
{"id":"control-17","thread":"telegram:chat/topic","user":"owner-id","text":"Pause","control":{"action":"pause","args":{"key":"fix-login"}}}
```

Allowed controls: pause, resume, object-done, approval-respond. Approval IDs must belong to the same messenger thread. An ordinary message saying yes is never automatically interpreted as an approval. Replies and read receipts use hooks; when a delivery result is unknown, inspect the outbox before retrying.


## Approval response examples

Command/file change: {"decision":"accept"}, {"decision":"decline"}, or {"decision":"cancel"}. Only one-shot decisions are accepted.

User input: {"answers":{"question-id":{"answers":["answer"]}}}; IDs must match the pending questions.

Permissions: {"permissions":{},"scope":"turn"} declines additional access. Explicit grants must be a subset of the request; turn/session scopes are supported. The service never broadens a grant.

MCP elicitation: {"action":"accept","content":{...}}, or action decline/cancel. Unsupported server request kinds receive a protocol error rather than implicit approval.

## Storage and recovery

state/lanes includes the lead record as lead.json. state/journal is append-only and fsynced before snapshot ACK. Host bootstrap and credentials are private files under state/hosts; runtime files record thread identity and local pause barriers. inbox/outbox/operations preserve queued, sending, sent and unknown outcomes. A crash changes incomplete sending entries to unknown on startup.

The default command sandbox can block Unix socket connections. Do not broaden network access for lifecycle operations: the required stdio MCP server calls the service with a lane-scoped capability. The local managed CLI wrapper is for operator tooling and supplies context from a private file even when parent shell filters remove variables.

The socket directory is a private /tmp/dori-UID-HASH directory derived from stateDir. Control tokens are never command-line arguments. This is local-user isolation, not a security boundary against arbitrary code running as that same OS user.

Host connection loss holds its goal and turn; failed stop confirmation terminates the owned Codex process. Reconnect does not silently resume a held lane. Inspect status/mail, then explicitly resume. For unknown external sends, inspect the actual messenger before marking sent or retrying through the original reply command.

The current journal retains history without rotation. Archive completed state only while the service is stopped, and keep the snapshot/journal pair together. Live connector compatibility, real model behavior and deployment-specific OS sandbox policy should be validated in a separate state directory before migrating production work.

## Optional real-protocol smoke test

```sh
DORI_LIVE_PROTOCOL=1 bun test test/integration.test.ts
```

This initializes the installed Codex 0.163.0 with a temporary home, creates a thread and verifies the required stdio MCP tool catalog. It does not start a model turn. The normal process integration still uses fixture runtimes. A network-off workspace-write command probe revealed that direct socket IPC is blocked on macOS; that is why managed agents use stdio MCP.

Protocol and configuration references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced). Per-thread MCP setup is also checked against the locally generated version-specific schema and the opt-in smoke test.
