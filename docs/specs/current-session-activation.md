# Activate Iyen in the current Codex session

## Requested behavior

The owner opens an ordinary Codex session and asks to start Iyen mode. That same
session becomes the messenger lead: its conversation, pane, model and permissions
remain in place. There is no existing live lead to transfer. Starting a different
lead TUI or focusing an old one does not satisfy this request.

Keep the existing service's owner-filtered ingress, durable inbox/outbox, work
timers and delegated lanes. Do not replay unknown historical deliveries or failed
launches as part of activation. Existing failed lead records are preserved as
history; a live lead must never be replaced implicitly.

## Implementation direction

The owner explicitly approved a single activation mode: current session only.
Remove the separate managed-lead creation entry point; managed sessions remain
for workers. Add current-session attachment distinct from managed lane startup. Verify the
explicit session UUID against the live Herdr pane and the running Codex daemon.
The service borrows the session and daemon; it does not own or terminate either.
Activation must work while the owner's activation request is running and must be
idempotent for the same verified session.

The activation skill loads the owner's existing persona and connects the current
session to the service. A scoped control bridge supplies the lead operations when
the session was not started with the managed `dori_runtime` MCP server. Do not
claim that MCP was installed or loaded when only a command bridge is available.
Do not change global Codex permissions, model configuration or unrelated sessions.

Use the installed Codex protocol for read-only observation and an established
input path for delivery. A successful queue/prompt submission is not proof of a
delivered turn: preserve the exact operation marker and confirm its persisted
user-message receipt. Unknown outcomes remain unknown and are not auto-replayed.

## Acceptance

- Activation preserves the exact current session and pane and starts no lead TUI.
- Repeating activation does not create another lead or duplicate input.
- Missing/mismatched identity and another live lead are rejected before mutation.
- Owner intake reaches the attached session with a durable delivery receipt.
- Lead controls are scoped; lane credentials cannot activate or impersonate a lead.
- Disconnects hold dispatch. Deactivation detaches without terminating the user's
  session or shared daemon.
- Existing managed worker lanes remain supported and existing tests continue to
  pass. An integration test covers the attached-session path.
- Installed activation uses the current executable and is discoverable as `iyen`.

## Evidence and release

Baseline `7797bcf88a75a3a3b86863628daf71dd658a2b3f`: 138 tests passed, zero failed.
The previous connection helper only focused an existing ready lead and invoked a
legacy `dori` from PATH. Managed startup's session guard rejects a missing as well
as a different session association; its historical failure log did not record the
observed identity. This implementation must not weaken that managed guard to
attach an ordinary session.

Validate and review the change, merge the PR into `main`, then install the merged
source and verify the deployed SHA. Keep the canonical checkout recoverable; temporary writer worktrees must be
removed after their changes are integrated and preserved.

## Shared daemon update recovery

An owner message was acknowledged but remained queued after the shared daemon
updated from 0.163.0 to 0.164.0. The attachment still used the 0.163.0 client and
the external observer reused the managed-worker version pin. The resulting hold
was invisible in the acknowledgment. Read-only inspection confirmed that the
same session remained loaded and that the required 0.164.0 read protocol and
queue arguments were compatible.

External attachment supports explicitly tested matching client/daemon pairs,
independently of managed worker version configuration. An explicit attachment
request may rebind the same thread, pane, canonical cwd and socket to a supported
binary after identity verification. It preserves the generation, capability and
historical inbox exclusions. Pending eligible messages remain pending; uncertain
deliveries never replay. Rebinding must fence stale observations and remain
retryable after an interrupted persistence operation. Status exposes a sanitized
hold reason; an acknowledgment during a hold must describe saved input waiting
for reconnection rather than imply that processing started.

## OMP native owner interactions

Native UI relay requires `ExtensionContext.userInteractions`
(`list`, `respond`, `responseStatus`). Older SDKs advertise interaction capability
as unavailable; doctor reports that the UI relay is not ready. Existing borrowed
lead ordinary durable messaging remains available during a staged service upgrade.
New managed startup requires the native interaction capability. Updating service
code does not upgrade an already-running native session: native reload/restart and
any new attachment activation require explicit owner authorization.
The extension observes `user_interaction_requested` and
`user_interaction_resolved`; polling also discovers dialogs already open at
reconnect. The exact-target control channel supports `interactions`,
`interaction-respond` and `interaction-response-status` for both borrowed leads
and managed lanes. These methods never inject a user message or abort an ask.

Configure the existing owner-filtered `ingress` and `hooks.threadReply`; no
additional account, daemon or notification hook is used. Native requests are
correlated using their initiating entry ID/operation hash and durable inbox
receipt. Source message IDs, owner IDs and metadata are retained. A lead whose
request omits source provenance is relayed only when its current attachment has
one unambiguous authenticated owner thread. Explicit unmatched or contradictory
lead provenance is withheld. A worker's unmapped launch source may use its
registered report thread only when one configured ingress/owner can be identified;
contradictory known provenance cannot use that fallback.
A shared Slack/Discord ingress may configure multiple owner identities. A worker
may bind its exact registered report thread to one authenticated owner proved by
a durable receipt in the current lead attachment; owner, controller and generation
must all match. Other threads, old epochs, missing receipts or multiple owners in
that thread do not qualify. Historical records without owner identity are not
backfilled by guessing: a fresh authenticated owner message supplies the binding.

Slack notices retain the actual native question, plan, labels, option IDs,
descriptions and execution tiers, with Korean instructions and a stable
`iyen-…` token. Reply using `답변 TOKEN RESPONSE`. A single ask accepts an exact
label or displayed number (numeric text always means the displayed index), or
`직접:<TEXT>`; every character after the colon, including whitespace, is preserved.
Multi-question/multi-select replies use the advertised native JSON response with
all ordered question IDs; an empty multi-selection is valid. Confirm uses
`true`/`false`; input/editor preserve raw text, ordinary JSON and incomplete code,
or accept an explicit native submit/cancel JSON envelope. Select/approval use exact
offered IDs. Plan review supports execute/compact/keep/refine/save; approval requires
an explicit offered role when tiers are shown, and feedback applies only to refine.
Remote approval/save authorizes exactly the advertised plan snapshot, never a newer
local draft. Remote execution gets a separate durable plan reference and does not
overwrite newer draft edits. Dismiss/reopen a review to advertise a new revision.
Disabled choices are rejected. Approval never treats a generic
“yes” as permission or widens an offered grant. Cancellation is `답변 TOKEN 취소`.
Secret dialogs expose only a redacted local-required notice and reject all
remote responses.

All native answers require the advertised token. Bare selections receive a
clarification, not an inferred answer. Guests, quoted tokens, cross-thread
responses, obsolete epochs and locally completed/expired requests cannot resolve
a dialog. Ordinary conversation remains lead-only, including conversation in a
worker report thread; validated native answers are control traffic.
Malformed or stale authenticated native answers are recorded as handled control
and receive thread feedback, rather than restarting the ingress producer. Replayed
or edited source IDs cannot become a fresh answer when a later question opens.
Native owner/operator answers cannot cross a paused/held or dispatch-blocked lane.
Resume/reconcile first, then send a fresh answer; a rejected old source is not replayed.
OMP lanes are not automatically nudged for periodic progress merely because they
are idle or old. Explicit reports still follow the configured durable report path.
The existing Codex freshness policy is unchanged.

`approval list` includes real native payloads instead of an OMP TUI placeholder.
Unrouted native questions are also visible locally with `relayBlocked` and a
`native-blocked:…` diagnostic ID. That ID is not an answer token and cannot be used
to bypass missing authenticated owner/thread binding; no question is sent externally
until that binding is established.
For authenticated operator tooling, `approval respond TOKEN --response-file FILE
--operation-id SOURCE_MESSAGE_ID` resolves the same native dialog. Preserve that
operation identity when reconciling. Codex approval commands are unchanged.
`native-interactions.json` durably stores advertised bindings and response
operations before submission. After an uncertain response, only read-only native
status is queried in that same epoch; missing/pending status is not permission to
retry. Existing durable outbox unknown outcomes are likewise never replayed.
Native epoch replacement invalidates pending replies and requires explicit
attachment reconciliation; it does not recover a dialog in another session.

Existing OMP borrowed-lead observation reconciles at most one unknown input receipt
read-only per inspection, with exact payload, controller and attachment fences.
Only a real durable native receipt marks it sent; absence remains held. This clears
lost-ACK delivery barriers without resubmitting owner input or report messages.

Integration must run the behavioral suite, including
`test/native-interactions.test.ts`, against the merged implementation, then
verify a real owner Slack/native roundtrip. Native SDK deployment, extension
reload and explicit activation/reconciliation belong to the integrator.
