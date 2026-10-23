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
