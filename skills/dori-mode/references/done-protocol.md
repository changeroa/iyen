# Lane completion

Run every Done signal yourself, commit/push work, then record a claim:

```sh
dori claim-done <key> --evidence "merge SHA, closed issue, published version, or verified local result"
```

The key defaults to DORI_LANE_KEY inside a managed Codex process. The command persists the claim and returns immediately; it does not interrupt the shell tool waiting for that response.

The service blocks new dispatch, stops goal continuation and the active turn, and waits until the persisted five-minute deadline. Remain idle. An identical repeated claim does not extend that deadline. A report of kind done is informational and does not replace claim-done.

The lead can object with dori object-done KEY --reason TEXT. The lane becomes not-done and receives a structured input with the reasons. Fix them and claim again. A paused lane cannot claim completion or be reactivated by an objection.

After the deadline, the service rechecks every Done signal and all explicitly owned worktrees. Untracked, uncommitted, unpushed, unreadable Git state or unconfirmed runtime inactivity blocks closure. An objection during verification invalidates that close attempt. Direct dori close uses the same checks.

After verification, the service records a cleanup fence, stops the runtime, saves worktree branch/SHA resume points, removes only owned clean worktrees, records the thread-done delivery, and closes the tab. Failed cleanup remains verified-done and is retried through checked cleanup; it is not reported closed. Unknown messenger delivery remains visible in the outbox. Codex thread history is retained for reopen.

Do not delete worktrees or close the pane yourself. Never treat Codex turn/completed or a native goal's complete status as proof that the lane's Done signals passed.
