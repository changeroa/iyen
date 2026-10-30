import argparse
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import activate

SESSION = "11111111-1111-4111-8111-111111111111"
PANE = "w1:p1"


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.config = root / "config.json"
        self.config.write_text("{}")
        self.bridge = root / "scoped-dori"
        self.bridge.write_text("#!/bin/sh\nexit 0\n")
        self.bridge.chmod(0o700)
        self.args = argparse.Namespace(action="start", session=SESSION, pane=PANE,
                                       config=str(self.config))
        self.agent = {"agent": "codex", "pane_id": PANE,
                      "agent_session": {"agent": "codex", "kind": "id", "value": SESSION}}
        self.lead = {"key": "lead", "role": "lead", "pane": PANE, "status": "working",
                     "bridge": str(self.bridge), "dispatchBlocked": False,
                     "identityVerified": True, "readiness": "busy",
                     "runtime": {"backend": "external-current-session", "threadId": SESSION,
                                 "state": "running", "held": False}}
        self.calls = []

    def command(self, argv, env=None, timeout=30):
        self.calls.append((argv, env.copy() if env is not None else None))
        if argv[-1] == "paths":
            return {"config_path": str(self.config), "home_dir": str(self.config.parent),
                    "state_dir": str(self.config.parent / "state"),
                    "persona_dir": str(self.config.parent / "memory"), "config_exists": True}
        if argv == ["herdr", "agent", "list"]:
            return {"result": {"agents": [self.agent]}}
        if argv[0] == str(self.bridge):
            return copy.deepcopy(self.lead)
        if "lead-activate" in argv:
            return {"attached": True, "bridge": str(self.bridge), "lead": copy.deepcopy(self.lead)}
        if "lead-handoff-preview" in argv:
            return {"eligible": ["saved-message"]}
        if "lead-handoff" in argv:
            return {"attached": True, "bridge": str(self.bridge), "lead": copy.deepcopy(self.lead)}
        if "lead-detach" in argv:
            return {"detached": True}
        if argv[-2:] == ["status", "lead"]:
            return copy.deepcopy(self.lead)
        self.fail(f"Unexpected command {argv}")

    def run_helper(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(activate.shutil, "which", return_value="/usr/bin/bun"), patch.object(activate, "command", side_effect=self.command):
            return activate.activate(self.args)

    def test_activation_uses_current_source_and_scoped_bridge_without_spawning(self):
        result = self.run_helper()
        self.assertEqual(result["status"], "active")
        self.assertEqual(result["session"], SESSION)
        attach, env = self.calls[2]
        self.assertTrue(Path(attach[1]).is_absolute())
        self.assertTrue(attach[1].endswith("skills/dori-mode/scripts/src/cli.ts"))
        self.assertEqual(attach[2:7], ["lead-activate", "--thread-id", SESSION, "--pane", PANE])
        self.assertEqual(env["DORI_CONFIG"], str(self.config.resolve()))
        self.assertEqual(self.calls[-1][0], [str(self.bridge), "status", "lead"])
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(result["persona_dir"], str(self.config.parent / "memory"))
        self.assertEqual(result["state_dir"], str(self.config.parent / "state"))

    def test_other_pane_never_reaches_mutating_command(self):
        self.args.pane = "w1:p9"
        with self.assertRaisesRegex(activate.ActivationError, "different session"):
            self.run_helper()
        self.assertEqual(len(self.calls), 2)

    def test_ambiguous_session_is_not_selected_by_focus(self):
        with patch.object(activate, "command", return_value={"result": {"agents": [self.agent, self.agent]}}):
            with self.assertRaisesRegex(activate.ActivationError, "exactly one"):
                activate.current_pane(SESSION, PANE)

    def test_scoped_identity_drift_cannot_report_active(self):
        original = self.command
        def drift(argv, env=None, timeout=30):
            result = original(argv, env, timeout)
            if argv[0] == str(self.bridge):
                result["runtime"]["threadId"] = "22222222-2222-4222-8222-222222222222"
            return result
        with patch.dict(os.environ, {}, clear=True), patch.object(activate.shutil, "which", return_value="/usr/bin/bun"), patch.object(activate, "command", side_effect=drift):
            with self.assertRaisesRegex(activate.ActivationError, "does not match"):
                activate.activate(self.args)

    def test_managed_lane_cannot_use_operator_activation(self):
        with patch.dict(os.environ, {"DORI_CONTEXT": "/private/lane-context.json"}), patch.object(activate, "command") as command:
            with self.assertRaisesRegex(activate.ActivationError, "cannot elevate"):
                activate.activate(self.args)
            command.assert_not_called()

    def test_stop_targets_expected_session_and_never_closes_pane(self):
        self.args.action = "stop"
        self.assertEqual(self.run_helper()["status"], "detached")
        self.assertEqual(self.calls[-1][0][-3:], ["lead-detach", "--thread-id", SESSION])
        self.assertEqual(len(self.calls), 3)

    def test_status_does_not_attach(self):
        self.args.action = "status"
        self.assertEqual(self.run_helper()["status"], "active")
        self.assertFalse(any("lead-activate" in argv for argv, _ in self.calls))

    def test_handoff_preview_never_detaches_or_claims_activation(self):
        self.args.action = "handoff-preview"
        self.args.from_session = "22222222-2222-4222-8222-222222222222"
        result = self.run_helper()
        self.assertEqual(result["status"], "preview")
        self.assertEqual(len(self.calls), 3)
        self.assertIn("lead-handoff-preview", self.calls[-1][0])
        self.assertFalse(any("lead-detach" in argv for argv, _ in self.calls))

    def test_handoff_requires_explicit_mail_selection_and_stable_operation(self):
        self.args.action = "handoff"
        self.args.from_session = "22222222-2222-4222-8222-222222222222"
        with self.assertRaisesRegex(activate.ActivationError, "operation-id"):
            self.run_helper()
        self.args.operation_id = "handoff-1"
        with self.assertRaisesRegex(activate.ActivationError, "mail-id"):
            self.run_helper()
        self.assertEqual(self.calls, [])
        self.args.mail_id = ["message-one", "message-two"]
        self.assertEqual(self.run_helper()["status"], "active")
        argv = self.calls[2][0]
        self.assertEqual(argv.count("--mail-id"), 2)
        self.assertIn("handoff-1", argv)
        self.assertIn(self.args.from_session, argv)
        self.assertEqual(self.calls[-1][0], [str(self.bridge), "status", "lead"])

    def test_handoff_with_no_mail_is_explicit(self):
        self.args.action = "handoff"
        self.args.from_session = "22222222-2222-4222-8222-222222222222"
        self.args.operation_id = "handoff-empty"
        self.args.no_mail = True
        self.assertEqual(self.run_helper()["status"], "active")
        self.assertIn("--no-mail", self.calls[2][0])

    def test_handoff_cannot_omit_expected_source_or_bypass_target_identity(self):
        self.args.action = "handoff-preview"
        with self.assertRaisesRegex(activate.ActivationError, "from-session"):
            self.run_helper()
        self.assertEqual(self.calls, [])
        self.args.from_session = "22222222-2222-4222-8222-222222222222"
        self.args.pane = "w1:p9"
        with self.assertRaisesRegex(activate.ActivationError, "different session"):
            self.run_helper()
        self.assertEqual(len(self.calls), 2)

    def test_unverified_public_status_cannot_report_active(self):
        self.lead["identityVerified"] = False
        with self.assertRaisesRegex(activate.ActivationError, "not ready"):
            self.run_helper()

    def test_held_status_explains_runtime_version_change_without_reattaching(self):
        self.args.action = "status"
        self.lead["dispatchBlocked"] = True
        self.lead["readiness"] = "held"
        self.lead["runtime"]["external"] = {"holdReason": {
            "code": "runtime-version-changed",
            "message": "Codex client 0.163.0 and daemon 0.164.0 differ; explicitly reattach."
        }}
        with self.assertRaisesRegex(activate.ActivationError, "daemon 0.164.0 differ"):
            self.run_helper()
        self.assertFalse(any("lead-activate" in argv for argv, _ in self.calls))

    def test_held_status_prefers_latest_cause_over_original_failure(self):
        self.args.action = "status"
        self.lead["dispatchBlocked"] = True
        self.lead["runtime"]["external"] = {
            "holdReason": {"message": "Original temporary disconnect"},
            "latestHoldReason": {"message": "Current session identity changed"},
        }
        with self.assertRaisesRegex(activate.ActivationError, "Current session identity changed"):
            self.run_helper()

    def test_explicit_home_and_config_precedence_and_inherited_state_is_cleared(self):
        self.args.home = str(self.config.parent)
        self.args.config = None
        with patch.dict(os.environ, {"DORI_CONFIG": "/wrong/config.json", "DORI_STATE_DIR": "/wrong/state"}, clear=True), patch.object(activate.shutil, "which", return_value="/usr/bin/bun"), patch.object(activate, "command", side_effect=self.command):
            result = activate.activate(self.args)
        paths_env = self.calls[0][1]
        self.assertEqual(paths_env["IYEN_HOME"], str(self.config.parent))
        self.assertNotIn("DORI_CONFIG", paths_env)
        self.assertNotIn("DORI_STATE_DIR", paths_env)
        self.assertEqual(result["config_path"], str(self.config))
        self.calls.clear()
        self.args.config = str(self.config)
        self.args.home = "/ignored/home"
        self.run_helper()
        self.assertEqual(self.calls[0][1]["DORI_CONFIG"], str(self.config))
        self.assertNotIn("IYEN_HOME", self.calls[0][1])

    def test_installation_is_resolved_again_for_each_activation(self):
        first = self.run_helper()
        other = self.config.parent / "second"
        other.mkdir()
        self.config = other / "config.json"
        self.config.write_text("{}")
        self.args.config = str(self.config)
        second = self.run_helper()
        self.assertNotEqual(first["home_dir"], second["home_dir"])
        self.assertEqual(second["persona_dir"], str(other / "memory"))

    def test_bad_installation_path_or_missing_config_never_mutates_service(self):
        original = self.command
        def invalid(argv, env=None, timeout=30):
            result = original(argv, env, timeout)
            if argv[-1] == "paths":
                result["state_dir"] = "relative/state"
            return result
        with patch.dict(os.environ, {}, clear=True), patch.object(activate.shutil, "which", return_value="/usr/bin/bun"), patch.object(activate, "command", side_effect=invalid):
            with self.assertRaisesRegex(activate.ActivationError, "invalid installation path"):
                activate.activate(self.args)
        self.assertEqual(len(self.calls), 1)
        self.calls.clear()
        self.config.unlink()
        with self.assertRaisesRegex(activate.ActivationError, "configuration not found"):
            self.run_helper()
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
