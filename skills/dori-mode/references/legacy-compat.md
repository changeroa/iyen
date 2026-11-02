# Legacy messenger lead compatibility

This opt-in artifact replaces only the legacy `runtime/lead-pane.mjs`. Slack Socket Mode, Discord Gateway, inbox persistence, source ACK, policy, media/transcription, and messenger accept/send/finish remain owned by their existing adapters and lead commands. Native input delivery is not a reply or completed task. No live installation is performed by repository tests.

Use the activated **attached-lead scoped bridge**, never the administrative CLI, an inferred session, a newest-file search, or an old OMO pane sender. The service must support these commands with machine-readable JSON:

```
EXACT_BRIDGE status lead --json
EXACT_BRIDGE input-status lead --text-file FILE --operation-id ID --json
EXACT_BRIDGE input lead --text-file FILE --operation-id ID --json
```

`status lead` must expose the current exact pane, bridge, runtime thread, native session ID/file, attachment instance/generation, `identityVerified`, and strict `inputReady`. `inputReady` means verified idle native input capability with durable receipts, no native hold, paused goal, handoff, approval, retry, compaction, disconnect or uncertain-operation fence. An older service without this API stays busy/missing. `input-status` must perform read-only exact native reconciliation even while held/busy; it must never submit/requeue input. Its status is `missing`, `queued`, `unknown`, or `received`, with the requested `operationId`. Received results include `turnId`, `receiptKind: "omp-session-entry"`, and the exact durable receipt. `turnId` equals the receipt's `receiptId`.

Create a private JSON configuration from actual activation evidence. Do not use sanitized remote placeholders as deployment values. Required fields:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `bridge` | Canonical absolute executable ending in `/clients/attached-lead/ATTACHMENT_INSTANCE/iyen` |
| `pane`, `threadId` | Exact activated pane and runtime thread |
| `attachmentInstance`, `attachmentGeneration` | Current service attachment instance and positive generation |
| `sessionId`, `sessionFile` | Exact native OMP session ID and absolute session file |
| `stateDir` | Dedicated shared private absolute ledger directory; same for BOTH adapters; never discard to bypass uncertainty |
| `inboxRoots.slack`, `inboxRoots.discord` | Canonical existing absolute **inbox** directories, not their state parents |
| `originalHash` | SHA-256 of the actual original deployed `lead-pane.mjs` |
| `dispatchers` | Exactly Slack and Discord entries, each with `source`, canonical absolute `script`, `domain` such as the actual `gui/UID`, and exact launchd `label` |

The installed shim reads adjacent `lead-pane.compat.json`. `IYEN_LEGACY_COMPAT_CONFIG` can explicitly pin a different config file for a controlled process; verify BOTH dispatchers use the same config. Do not give either dispatcher a different ledger directory. The shim never reads bridge context/token files. It executes only the pinned scoped wrapper; ambient `DORI_*` variables are removed before execution.

Stable operation IDs hash the supported prefix, source and source event ID. Supported prefixes are `DORI_SLACK_EVENT`, `DORI_DISCORD_EVENT`, `DORI_MONITOR_EVENT` (`dori-watch`, `monitor-N`), and `DORI_QA_EVENT` (Slack record with `qa:true`). The read clause must identify the exact configured inbox file and matching record ID/source. QA remains text delivered to the lead; the shim itself never posts or finishes it. Guest/ambient authority, thread IDs, attachments and transcripts are passed unchanged, preserving the existing prompt policy rather than introducing new authorization enforcement.

The shared `stateDir/lead.lock` directory serializes both adapters across processes. Payload files and operation records are mode 0600, flushed and atomically replaced; the state directory must be owned by the process user and private (0700). A record binds exact original text hash and attachment epoch before dispatch. Queued is busy; timeout, nonzero exit, malformed output, missing receipt or changed epoch is failed. Repeating a source event queries the same ID first, including while native lead is busy. Unknown or queued outcomes block fresh work. `leadState` can clear an uncertainty barrier only by querying an exact received native operation; it never submits input. Identical already-received events return their existing receipt, not another input.

For an orphaned lock, stop and disable BOTH dispatchers, verify no shim/bridge invocation remains active, inspect ledger/native receipts, then remove only the confirmed orphan `lead.lock` directory. Locks are deliberately not stolen using a guessed PID or age. Keep all payloads/records through restarts and attachment changes; an old unresolved epoch requires explicit reconciliation, not relabeling.

## Cutover and rollback

Prepare activation, exact configuration and readiness before the receive downtime. In a controlled local maintenance window, stop and disable automatic respawn of **both** launchd dispatchers. The installer verifies `launchctl print-disabled`, exact service stopped/absent evidence, and a successful process inventory with neither dispatcher script running. A lock file or a caller assertion is insufficient. Unknown/permission-denied process state refuses installation.

Default preflight, which does not mutate files:

```
node skills/dori-mode/scripts/compat/install.mjs --config /ABSOLUTE/CUTOVER.json --target /ABSOLUTE/runtime/lead-pane.mjs
```

Review the returned paths/hashes and rollback instructions. A later explicitly authorized local invocation can add `--apply`. It verifies syntax, exact original hash, both stopped dispatchers again, creates and verifies a hash-addressed original backup, writes private adjacent configuration, and atomically replaces the shim. Existing adjacent compatibility configuration is refused to prevent silent recutover. The installer does not stop, restart, enable or send anything. Preserve dispatcher stop/disable state until replacement/configuration and exact readiness are verified; restart both services promptly in the controlled window. Native provider/authentication readiness and lead bootstrap must be verified separately before claiming operational readiness.

Before rollback, stop/disable BOTH dispatchers again. Reconcile every queued/unknown/delivered operation against exact native receipts and existing source accept/finish/outbound evidence. A delivered native prompt cannot be undone by restoring a file. Do not re-enable the old pane sender until each potentially delivered source event has an explicit disposition preventing duplicate work. Verify the saved backup hash, restore only after reconciliation, and preserve the compatibility ledger and cutover record. No automatic rollback or replay is provided.

## Verification boundary

`bun test test/legacy-lead-pane.test.ts` uses a real local executable and private durable fake native store. It checks exact receipt validation, repeated/restarted delivery, queued/unknown/timeout behavior, reconciliation without reposting, attachment changes, shared locking, source metadata preservation and installer refusal/mutation boundaries. It makes no network/model calls. It does not execute the sanitized production services, prove live ACK ordering, exercise real audio downloads/transcription, or prove a lead obeys guest/reply/finish instructions. Those unchanged adapter paths remain source-traced until an explicitly authorized full adapter/model smoke test. Integration must run the parent-owned scoped API tests as well.
