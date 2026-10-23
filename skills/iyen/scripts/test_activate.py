import argparse
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import activate

SESSION = "01a166ff-9c30-74c0-a458-32c6abf5c54d"
PANE = "w1M:pM"


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
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
                     "runtime": {"backend": "external-current-session", "threadId": SESSION,
                                 "state": "running", "held": False}}
        self.calls = []

    def command(self, argv, env=None, timeout=30):
        self.calls.append((argv, env))
        if argv == ["herdr", "agent", "list"]:
            return {"result": {"agents": [self.agent]}}
        if argv[0] == str(self.bridge):
            return copy.deepcopy(self.lead)
        if "lead-attach" in argv:
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
        attach, env = self.calls[1]
        self.assertTrue(Path(attach[1]).is_absolute())
        self.assertTrue(attach[1].endswith("skills/dori-mode/scripts/src/cli.ts"))
        self.assertEqual(attach[2:7], ["lead-attach", "--thread-id", SESSION, "--pane", PANE])
        self.assertEqual(env["DORI_CONFIG"], str(self.config.resolve()))
        self.assertEqual(self.calls[-1][0], [str(self.bridge), "status", "lead"])
        self.assertEqual(len(self.calls), 3)

    def test_other_pane_never_reaches_mutating_command(self):
        self.args.pane = "w1M:pZ"
        with self.assertRaisesRegex(activate.ActivationError, "different session"):
            self.run_helper()
        self.assertEqual(len(self.calls), 1)

    def test_ambiguous_session_is_not_selected_by_focus(self):
        with patch.object(activate, "command", return_value={"result": {"agents": [self.agent, self.agent]}}):
            with self.assertRaisesRegex(activate.ActivationError, "exactly one"):
                activate.current_pane(SESSION, PANE)

    def test_scoped_identity_drift_cannot_report_active(self):
        original = self.command
        def drift(argv, env=None, timeout=30):
            result = original(argv, env, timeout)
            if argv[0] == str(self.bridge):
                result["runtime"]["threadId"] = "01a16705-7293-7110-96ec-f6f912bd2628"
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
        self.assertEqual(len(self.calls), 2)

    def test_status_does_not_attach(self):
        self.args.action = "status"
        self.assertEqual(self.run_helper()["status"], "active")
        self.assertFalse(any("lead-attach" in argv for argv, _ in self.calls))


if __name__ == "__main__":
    unittest.main()
