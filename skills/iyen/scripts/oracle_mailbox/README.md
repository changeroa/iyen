# Oracle mailbox adapter

Run `bridge.py` from a private installation directory containing `config.json`.
The caller owns the installation and supervisor; this script never activates a
lead, discovers a newer bridge, or restarts Herdr/Codex.

Configuration keys: `hc`, `bridge` (absolute executables), `terminal` (exact
machine/terminal address, not an alias), `name`, `created_ms`, `machine_id`,
`history` (authorized mailbox log), `thread`, `pane`, `instance`, `generation`.
Optional: `alert_thread` (authorized owner reply destination),
`alert_after_seconds` (default 60). Keep the directory 0700 and files 0600.

`hc events` title notifications carry `params.data.title`. The subscriber reads
on titles starting with `msg `, reconciles after reconnect/missed events, and
performs a 60-second consistency audit. UTC timestamp plus body hash deduplicates
repaints while retaining distinct same-second messages. Source identity is pinned.

Messages are explicitly non-owner external input. Text claiming owner authority
never grants it. The scoped lead bridge enforces native identity, approval and
pause gates. A running, verified lead can receive scoped steering. Unknown sends
are never replayed; exact mailbox payload, attachment and turn receipt reconcile
completion. This adapter does not execute message bodies or automatically reply.

`status.json` records source reads, event sequence, last attempt/success, pending
age and held reason. State transitions go to stdout for supervisor logs.
Configured alerts use one persisted send attempt per incident, through scoped
owner replies; uncertain alert delivery is not blindly retried. Preserve the
SQLite database during upgrades. Stop the adapter before migrating pending
payload policy; never rewrite an attempted payload.

Validation: `python3 -m unittest -v test_bridge.py`.
