# Sessions (lanes)

Every lane and the lead run a separate Codex app-server in a Herdr tab, managed by session-host. The service records the returned thread.id; it never inspects process environments or guesses session files.

## Launch

```sh
dori launch fix-login --title "Fix login" --brief ~/briefs/fix-login.md \
  --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --cwd ~/code/app --worktree
```

Write the objective, evidence, expected behavior, scope and forbidden changes into the brief. The service generates a separate brief with the lane contract, leaving the original intact. --worktree records a base SHA and creates an owned branch/worktree for concurrent writers. Without it, the supplied cwd is used and is never owned for deletion.

STARTUP_OK requires a registered Codex thread and an accepted first input. A missing response yields STARTUP_UNCONFIRMED; inspect status and mail list instead of relaunching. Reusing --operation-id deduplicates a completed launch. Resource HOLD leaves the request queued.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## Registry and reporting

The service is the only writer. Lane snapshots live in state/lanes; append-only journal records are flushed before ACK. A lane revision prevents stale overwrites. The lead is a reserved lane named lead and is never automatically closed.

- thread: messenger reference; runtime.threadId: Codex RPC identity. They are different namespaces.
- pane/tab: Herdr placement; runtime.generation: fences old host events.
- status: working, paused, done-claimed, verified-done, not-done, closed.
- dispatchBlocked and holdReason: fail-closed barrier independent of business status.
- claim/history/receipt: evidence, deadline and cleanup history.
- worktrees/resumeRefs: explicit ownership and saved Git resume points.

Use dori report KEY --kind milestone --text-file PATH --event-id ID. The service persists the event and forwards it to the lead; configured threadReply hooks post milestones. Identical event IDs are not reposted. Do not infer progress from terminal text.

## Pause and recovery

Pause persists a dispatch barrier, deactivates an active native goal, interrupts the current turn and verifies inactivity. Unknown responses leave the barrier in place. Resume is explicit and restores the previous status without resetting goal usage.

Use dori recover KEY after a host dies. An existing live host/process prevents a second writer. Use dori resume KEY to release a recovery hold after reconciliation. An unknown mail is not retried automatically: inspect actual work/history, then use dori mail resolve ID --box inbox --state sent|queued --evidence TEXT. Choose queued only after proving it was not executed.

A closed lane is reopened with dori reopen KEY --text-file PATH. It keeps the Codex thread and messenger reference, increments cycle, and removes the old claim deadline from the active cycle. Owned worktrees are restored from saved branch/SHA references. A genuinely missing Codex thread is an error, never silently replaced.

To transfer an existing external Codex thread, stop its other client first and use dori adopt KEY --thread-id ID --pane ID --title T --brief FILE --done SIGNALS --transfer-confirmed. Adoption starts held. Resume only after verifying ownership and context.
