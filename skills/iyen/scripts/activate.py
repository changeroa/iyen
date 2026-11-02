#!/usr/bin/env python3
"""Activate Iyen in an explicitly identified, already-running native session (Codex default, explicit OMP)."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


class ActivationError(Exception):
    pass


def command(argv, env=None, timeout=30):
    try:
        result = subprocess.run(argv, capture_output=True, text=True,
                                timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ActivationError(f"{Path(argv[0]).name}: {exc}") from exc
    if result.returncode:
        raise ActivationError((result.stderr or result.stdout).strip()[:1500])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ActivationError(f"{Path(argv[0]).name} returned invalid JSON") from exc


def current_pane(session, requested, runtime="codex", session_file=None, terminal_id=None):
    agents = command(["herdr", "agent", "list"]).get("result", {}).get("agents", [])
    if runtime == "omp":
        matches = [a for a in agents if a.get("agent") == "omp"
                   and a.get("agent_session", {}).get("agent") == "omp"
                   and a.get("agent_session", {}).get("kind") == "path"
                   and a.get("agent_session", {}).get("source") == "herdr:omp"
                   and a.get("agent_session", {}).get("value") == session_file
                   and a.get("terminal_id") == terminal_id]
    else:
        matches = [a for a in agents if a.get("agent") == "codex"
               and a.get("agent_session", {}).get("kind") == "id"
               and a.get("agent_session", {}).get("agent") == "codex"
               and a.get("agent_session", {}).get("value") == session]
    if len(matches) != 1:
        raise ActivationError("The session must have exactly one live Herdr native pane")
    pane = matches[0].get("pane_id")
    if not isinstance(pane, str) or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", pane):
        raise ActivationError("Herdr did not return a valid public pane ID")
    if requested and requested != pane:
        raise ActivationError("The requested pane belongs to a different session")
    return pane


def verify_lead(lead, session, pane, runtime_kind="codex", session_file=None, terminal_id=None):
    if not isinstance(lead, dict):
        raise ActivationError("Service did not return a lead record")
    runtime = lead.get("runtime") or {}
    if (lead.get("key") != "lead" or lead.get("role") != "lead"
            or lead.get("pane") != pane or runtime.get("threadId") != session
            or runtime.get("backend") != "external-current-session"):
        raise ActivationError("Service lead does not match this attached session")
    if runtime_kind == "omp":
        native = (runtime.get("omp") or {}).get("target") or {}
        if (runtime.get("kind") != "omp" or native.get("sessionId") != session
                or native.get("sessionFile") != session_file or native.get("terminalId") != terminal_id
                or native.get("paneId") != pane):
            raise ActivationError("Service OMP lead does not match native session metadata")
    if (lead.get("dispatchBlocked") or runtime.get("held")
            or lead.get("status") != "working"
            or lead.get("identityVerified") is not True
            or lead.get("readiness") not in ("ready", "busy")
            or runtime.get("state") not in ("idle", "running")):
        external = runtime.get("external") or {}
        hold = external.get("latestHoldReason") or external.get("holdReason")
        if isinstance(hold, dict) and isinstance(hold.get("message"), str):
            raise ActivationError(f"The attached lead is not ready: {hold['message']}")
        raise ActivationError("The attached lead is not ready; inspect service status")


def activate(args):
    try:
        session = str(uuid.UUID(args.session))
    except ValueError as exc:
        raise ActivationError("--session must be the current native session UUID") from exc
    if any(name in os.environ for name in ("DORI_CONTEXT", "DORI_LANE_KEY", "DORI_LANE_TOKEN")):
        raise ActivationError("Managed Dori sessions must use scoped controls; activation cannot elevate a lane")
    runtime_kind = getattr(args, "runtime", "codex")
    session_file = getattr(args, "session_file", None)
    terminal_id = getattr(args, "terminal_id", None)
    if runtime_kind == "omp":
        if not session_file or not terminal_id or not (getattr(args, "config", None) or getattr(args, "home", None)):
            raise ActivationError("OMP requires explicit --session-file, --terminal-id and isolated --config or --home")
        session_file = str(Path(session_file).expanduser().resolve(strict=True))
    handoff = args.action in ("handoff-preview", "handoff")
    if handoff:
        try:
            source_session = str(uuid.UUID(getattr(args, "from_session", "") or ""))
        except ValueError as exc:
            raise ActivationError("--from-session must identify the registered previous lead") from exc
        mail_ids = getattr(args, "mail_id", None) or []
        no_mail = getattr(args, "no_mail", False)
        if no_mail and mail_ids:
            raise ActivationError("Choose --mail-id or --no-mail, not both")
        if args.action == "handoff":
            if not getattr(args, "operation_id", None):
                raise ActivationError("--operation-id is required for repeatable handoff")
            if not mail_ids and not no_mail:
                raise ActivationError("Explicit --mail-id selections or --no-mail required")
    cli = Path(__file__).resolve().parents[3] / "skills/dori-mode/scripts/src/cli.ts"
    bun = shutil.which("bun")
    if not bun or not cli.is_file():
        raise ActivationError("Install this skill with its Iyen repository and Bun runtime")
    env = os.environ.copy()
    for name in ("DORI_STATE_DIR", "DORI_LANE_TOKEN"):
        env.pop(name, None)
    base = [bun, str(cli)]
    if args.config:
        env["DORI_CONFIG"] = str(Path(args.config).expanduser().resolve())
    elif getattr(args, "home", None):
        env.pop("DORI_CONFIG", None)
        env["IYEN_HOME"] = str(Path(args.home).expanduser().resolve())
    paths = command(base + ["paths"], env)
    for key in ("config_path", "home_dir", "state_dir", "persona_dir"):
        if not isinstance(paths.get(key), str) or not Path(paths[key]).is_absolute():
            raise ActivationError(f"Service returned an invalid installation path: {key}")
    config = Path(paths["config_path"])
    if not config.is_file():
        raise ActivationError(f"Existing Iyen service configuration not found: {config}")
    if runtime_kind == "omp":
        try:
            configured_kind = json.loads(config.read_text()).get("runtime", {}).get("kind", "codex")
        except (OSError, ValueError, AttributeError) as exc:
            raise ActivationError("Cannot verify explicit OMP service profile") from exc
        if configured_kind != "omp":
            raise ActivationError("OMP activation requires an explicit OMP service profile; Codex config is preserved")
    env["DORI_CONFIG"] = str(config)
    pane = current_pane(session, args.pane, runtime_kind, session_file, terminal_id)
    native_flags = (["--session-file", session_file, "--terminal-id", terminal_id]
                    if runtime_kind == "omp" else [])
    if handoff:
        argv = base + ["lead-" + args.action, "--from-thread-id", source_session,
                       "--thread-id", session, "--pane", pane,
                       "--cwd", str(Path.cwd().resolve())]
        for mail_id in mail_ids:
            argv.extend(["--mail-id", mail_id])
        if args.action == "handoff":
            argv.extend(["--operation-id", args.operation_id])
            if no_mail:
                argv.append("--no-mail")
        result = command(argv + native_flags, env, timeout=60)
        if args.action == "handoff-preview":
            return {"status": "preview", "session": session, "pane": pane,
                    "from_session": source_session, "result": result}
    if args.action == "stop":
        result = command(base + ["lead-detach", "--thread-id", session], env)
        return {"status": "detached", "session": session, "pane": pane, "result": result}
    if args.action in ("start", "handoff"):
        if args.action == "start":
            result = command(base + ["lead-activate", "--thread-id", session, "--pane", pane,
                                     "--cwd", str(Path.cwd().resolve())] + native_flags, env, timeout=60)
        if result.get("attached") is not True:
            raise ActivationError("Service did not confirm attachment")
        lead = result.get("lead")
        bridge = result.get("bridge")
    else:
        lead = command(base + ["status", "lead"], env)
        bridge = lead.get("bridge")
    verify_lead(lead, session, pane, runtime_kind, session_file, terminal_id)
    if not isinstance(bridge, str) or not Path(bridge).is_absolute() or not os.access(bridge, os.X_OK):
        raise ActivationError("The attached lead has no executable scoped control bridge")
    # Check this session's actual ability to use the scoped service channel.
    scoped = command([bridge, "status", "lead"], env)
    verify_lead(scoped, session, pane, runtime_kind, session_file, terminal_id)
    return {"status": "active", "session": session, "pane": pane, "bridge": bridge,
            **paths,
            "runtime_state": scoped["runtime"]["state"], "runtime": runtime_kind,
            **({"session_file": session_file, "terminal_id": terminal_id} if runtime_kind == "omp" else {})}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "status", "stop", "handoff-preview", "handoff"), nargs="?", default="start")
    parser.add_argument("--session", required=True, help="Explicit current native UUID; never infer from focus")
    parser.add_argument("--runtime", choices=("codex", "omp"), default="codex", help="Explicit native runtime kind")
    parser.add_argument("--session-file", help="Exact existing OMP JSONL session path")
    parser.add_argument("--terminal-id", help="Exact Herdr OMP terminal ID")
    parser.add_argument("--pane", help="Verified pane ID; otherwise resolve uniquely by session")
    parser.add_argument("--config", help="Existing service config; overrides home and environment discovery")
    parser.add_argument("--home", help="Persistent Iyen directory containing config.json; defaults to IYEN_HOME or existing installation")
    parser.add_argument("--from-session", help="Expected previous lead UUID for explicit handoff")
    parser.add_argument("--operation-id", help="Stable ID reused when retrying the same handoff")
    parser.add_argument("--mail-id", action="append", help="Explicit queued message ID to transfer; repeat for each message")
    parser.add_argument("--no-mail", action="store_true", help="Explicitly hand off without transferring messages")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(activate(args), ensure_ascii=False))
        return 0
    except (ActivationError, OSError, ValueError, TypeError, AttributeError, KeyError) as exc:
        print(json.dumps({"status": "unconfirmed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
