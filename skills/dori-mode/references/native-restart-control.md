# Native owner-restart control

`runtime/omp/lead-restart.ts` exports `prepareLeadRestart`, `inspectLeadRestart`,
`commitLeadRestart`, `stageLeadRestartContinuation`, and `releaseLeadRestart`.
All use the existing authenticated native socket client and exact OMP target.
Generic attached-lead hold/release/stop remains forbidden.

## Preconditions owned by the parent service

Before durable acceptance, source consumption, an active-operation marker, or
owner-ingress fencing, authenticate the exact current controller with
`connectOmp(target).inspect()`. Require `capabilities.leadRestart === true`.
Old extensions omit this optional capability; new extensions advertise false
without every native idle-latch, stage, staged-release, and graceful-shutdown
method. Known unavailable/pre-submit refusal must leave source and owner
conversation untouched. The transport repeats the read-only prepare preflight,
but cannot undo a service that accepted its source too early.
Read `inspect().launchMetadata` as well: it is the actual borrowed lead's
`{agentDir, settingsHome, approvalMode, provider, model, effort?}`, not managed
lane defaults. Missing metadata is known unavailable. SDK `agentDir` and
`Settings.getAgentDir()` may differ; such split roots are not reproducible by
the single native directory flag and make restart unavailable before acceptance.
No configuration, credential, provider-internal or persona contents are exposed.
The native approval resolver includes explicit auto-approve precedence.

Persist the exact metadata in `LeadRestartIntent.launchMetadata` and bind it
into `authorizationHash` before consuming source or fencing dispatch. Validate
that the fixed native launch arguments can reproduce it before acceptance;
reject an unsupported approval/effort selector rather than substituting worker
defaults. Use `--agent-dir` from native metadata and the original
`--approval-mode`, provider/model and effective effort. A borrowed yolo lead
must not become always-ask or move to a worker account directory.


Authenticate the original configured owner/thread/source and its real native
receipt; bind the exact native and attachment epochs into `authorizationHash`.
Do not parse natural language to manufacture authorization, accept quoted/guest
content, or relabel historical inbox records. The private controller token is a
service capability, not a model-discoverable path to authority.

## Lifecycle

`LeadRestartIntent` contains `operationId`, SHA-256 `authorizationHash`,
`sourceMessageId`, required pinned `launchMetadata`, and optional `previousTarget`. `LeadRestartBootstrap` requires
`previousTarget`. The same exact bootstrap is required for fresh staging and
release. Native durable phases are `waiting-idle`, `held`, `exit-requested`,
`released`, and `failed`.
Lifecycle status also attests actual `launchMetadata`; bootstrap carries the
immutable original metadata. Native prepare, idle latch, exit commit, held
stage and staged release check the effective profile against that intent.
SDK stage/release recheck after fsync before admission opens, so settings/model
changes during an asynchronous persistence boundary remain fenced.


Prepare records and arms one intent. Busy turns finish normally. Its native
idle-to-held transition closes execution admission without aborting active
work. Pending steering/follow-up/hidden payloads are persisted as non-replayed
custom audit entries, not fake user receipts; queues are not cleared to evade
barriers. Running or pending asynchronous work defers the latch.

Inspect is observational. It attests source binding, exact native target,
actual native `process.pid`, controller instance/generation, restart bootstrap
on resumed targets, native fence session/generation/status, and an available
continuation receipt. A failed or unknown operation is never repeated as a
new irreversible attempt.

Commit requires the exact old held fence. It durably records `exit-requested`
before requesting the real native UI's graceful shutdown once. This is an
intent acknowledgement, **not process-exit proof**. The parent independently
proves that authenticated exact PID exited and Herdr detached the original
session before launching anything in the same pane. A live/reused PID keeps
the operation held; no signal fallback exists.

The resumed extension requires an exact `restart` bootstrap plus matching
`expectedSessionId`, `expectedSessionFile`, `expectedPaneId`,
`expectedTerminalId`, and `expectedCwd`. It acquires the native fence before
awaiting disk/Herdr readiness, and publishes its controller only after durable
parking and journal/bootstrap validation. The parent verifies provider, model,
effort, approval mode, native session/file, pane/terminal/cwd, and new epoch.

Stage takes `(config, resumedTarget, intent, text)`. It appends/fsyncs a real
native user entry while startup is still held, then verifies it with the
existing exact native receipt reader. It returns `LeadRestartContinuation`:
`{operationId, authorizationHash, target, textHash, receipt}`. `textHash` hashes
the original text. The receipt operation is
`lead-restart-continuation:<restart operationId>`; its payload hash equals
`textHash`. The native entry uses the ordinary durable operation marker.
The text must identify a source-bound service continuation, not forged Slack
text, and supply the exact newly generated scoped bridge/epoch without persona
contents or credentials. An attempted/unknown stage can only reconcile its
original entry; it never appends again. Inspect can recover a receipt after a
lost stage acknowledgement.

Release requires that staged receipt and matching fresh held fence. Both
layers persist an attempt before opening admission. Native release claims
exactly the staged continuation synchronously before a local input or goal
can race; no second user entry is submitted. Successful duplicates return
recorded status. Unknown release remains failed/held for reconciliation;
there is no blind retry. Actual inference and persona reads require later
native evidence and are not implied by activation, staging, or release ACKs.

The parent must keep owner messages accepted during restart durably queued
for the fresh attachment, preserve historical uncertainty, revoke old scoped
capabilities on explicit rotation, and keep generic reconnect/watchdog logic
from invalidating the coordinator-owned exit/start gap.

## Structured launch and first upgrade

Use Herdr's structured `agent start --kind omp --pane EXACT -- ARGS`, never
`pane run` (raw terminal typing). Require the configured native binary to
match Herdr's canonical executable; do not silently substitute it. Native
startup arguments `--agent-dir /absolute/settings-home` and
`--iyen-omp-bootstrap /absolute/private-bootstrap.json` are extracted before
runtime/extension loading. Ordinary extension flag values arrive too late for
factory bootstrap. Parent launcher owns all other pinned native flags and
must pass the exact original resume file without positional prompts.
The fixed bare native `--start-held` flag is also required: it installs the
execution fence in the session constructor, before startup admission. The
restart extension requires `executionHold.isRestartStartupHeld()` and adopts
that exact unbound fence; an idle observation or a previously held old process
does not satisfy startup attestation. Cache warming respects held admission
without changing the configured warming policy.


Disk deployment does not upgrade an old loaded SDK/extension. No existing
authenticated owner/reload endpoint was found for that first transition.
A normal **local operator** bootstrap and explicit attachment reconciliation
are prerequisites; the local `/restart` command is not a remote capability
and its exec replacement is not the coordinator's exit-then-launch flow.
Reject unavailable old runtimes without consuming their restart source. After
bootstrap, bind fresh authorization to a real fresh-epoch receipt; do not
silently replay old unknown requests.

## Verification ownership

Native behavioral coverage lives in `test/lead-restart-native.test.ts` and the
native SDK execution-hold/bootstrap tests. Service source authentication,
unsupported-runtime no-side-effect acceptance, launch/activation uncertainty,
queued owner delivery across rotation, watchdog gaps, and old-capability
revocation are coordinator-owned integration regressions. Parent runs the
merged checks and runtime verification; this slice does not restart production.
