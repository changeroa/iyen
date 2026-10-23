#!/usr/bin/env python3
"""Activate Iyen in an explicitly identified, already-running Codex session."""
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


def current_pane(session, requested):
    agents = command(["herdr", "agent", "list"]).get("result", {}).get("agents", [])
    matches = [a for a in agents if a.get("agent") == "codex"
               and a.get("agent_session", {}).get("kind") == "id"
               and a.get("agent_session", {}).get("agent") == "codex"
               and a.get("agent_session", {}).get("value") == session]
    if len(matches) != 1:
        raise ActivationError("The session must have exactly one live Herdr Codex pane")
    pane = matches[0].get("pane_id")
    if not isinstance(pane, str) or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", pane):
        raise ActivationError("Herdr did not return a valid public pane ID")
    if requested and requested != pane:
        raise ActivationError("The requested pane belongs to a different session")
    return pane


def verify_lead(lead, session, pane):
    if not isinstance(lead, dict):
        raise ActivationError("Service did not return a lead record")
    runtime = lead.get("runtime") or {}
    if (lead.get("key") != "lead" or lead.get("role") != "lead"
            or lead.get("pane") != pane or runtime.get("threadId") != session
            or runtime.get("backend") != "external-current-session"):
        raise ActivationError("Service lead does not match this attached session")
    if (lead.get("dispatchBlocked") or runtime.get("held")
            or lead.get("status") != "working"
            or lead.get("identityVerified") is not True
            or lead.get("readiness") not in ("ready", "busy")
            or runtime.get("state") not in ("idle", "running")):
        hold = (runtime.get("external") or {}).get("holdReason")
        if isinstance(hold, dict) and isinstance(hold.get("message"), str):
            raise ActivationError(f"The attached lead is not ready: {hold['message']}")
        raise ActivationError("The attached lead is not ready; inspect service status")


def activate(args):
    try:
        session = str(uuid.UUID(args.session))
    except ValueError as exc:
        raise ActivationError("--session must be the current Codex session UUID") from exc
    if os.environ.get("DORI_CONTEXT") or os.environ.get("DORI_LANE_KEY"):
        raise ActivationError("Managed Dori sessions must use scoped controls; activation cannot elevate a lane")
    config = Path(args.config).expanduser().resolve() if args.config else Path.home() / ".dori-codex" / "config.json"
    if not config.is_file():
        raise ActivationError(f"Existing Iyen service configuration not found: {config}")
    cli = Path(__file__).resolve().parents[3] / "skills/dori-mode/scripts/src/cli.ts"
    bun = shutil.which("bun")
    if not bun or not cli.is_file():
        raise ActivationError("Install this skill with its Iyen repository and Bun runtime")
    env = os.environ.copy()
    for name in ("DORI_STATE_DIR", "DORI_LANE_TOKEN"):
        env.pop(name, None)
    env["DORI_CONFIG"] = str(config)
    base = [bun, str(cli)]
    pane = current_pane(session, args.pane)
    if args.action == "stop":
        result = command(base + ["lead-detach", "--thread-id", session], env)
        return {"status": "detached", "session": session, "pane": pane, "result": result}
    if args.action == "start":
        result = command(base + ["lead-attach", "--thread-id", session, "--pane", pane,
                                 "--cwd", str(Path.cwd().resolve())], env, timeout=60)
        if result.get("attached") is not True:
            raise ActivationError("Service did not confirm attachment")
        lead = result.get("lead")
        bridge = result.get("bridge")
    else:
        lead = command(base + ["status", "lead"], env)
        bridge = lead.get("bridge")
    verify_lead(lead, session, pane)
    if not isinstance(bridge, str) or not Path(bridge).is_absolute() or not os.access(bridge, os.X_OK):
        raise ActivationError("The attached lead has no executable scoped control bridge")
    # Check this session's actual ability to use the scoped service channel.
    scoped = command([bridge, "status", "lead"], env)
    verify_lead(scoped, session, pane)
    return {"status": "active", "session": session, "pane": pane, "bridge": bridge,
            "persona_dir": str(config.parent / "persona"),
            "runtime_state": scoped["runtime"]["state"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "status", "stop"), nargs="?", default="start")
    parser.add_argument("--session", required=True, help="Explicit current Codex UUID; never infer from focus")
    parser.add_argument("--pane", help="Verified pane ID; otherwise resolve uniquely by session")
    parser.add_argument("--config", help="Existing config; defaults to ~/.dori-codex/config.json")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(activate(args), ensure_ascii=False))
        return 0
    except (ActivationError, OSError, ValueError, TypeError, AttributeError, KeyError) as exc:
        print(json.dumps({"status": "unconfirmed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
