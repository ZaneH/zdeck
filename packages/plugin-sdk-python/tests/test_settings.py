import copy
import io
import json
from pathlib import Path
import subprocess
import unittest

from zdeck_plugin_sdk import PluginError, serve, validate_manifest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = {"id": "gated", "version": "0.1.0", "protocolVersion": 1,
            "actions": [{"id": "go", "title": "Go", "config": {}}],
            "settings": {"token": {"type": "secret", "label": "Token"},
                         "name": {"type": "text", "label": "Name"}}}


def request(kind, **extra):
    return (json.dumps({"protocolVersion": 1, "id": "r1", "type": kind, **extra}) + "\n").encode()


class FakePlugin:
    manifest = MANIFEST

    def __init__(self):
        self.calls = []

    def state(self, signal):
        return {"ready": True}

    def execute(self, action, args, signal):
        return {"ready": True}

    def configure(self, settings, signal):
        self.calls.append((settings, signal))


def session(wire, plugin=None):
    plugin = plugin or FakePlugin()
    output = io.BytesIO()
    serve(plugin, input=io.BytesIO(wire), output=output)
    return [json.loads(line) for line in output.getvalue().splitlines()], plugin.calls, output.getvalue()


class SettingsTests(unittest.TestCase):
    def test_configure_gates_state_and_returns_empty_state(self):
        before, calls, _ = session(request("state") + request("execute", action="go", args={}))
        self.assertEqual([r["error"]["code"] for r in before], ["invalid_request", "invalid_request"])
        self.assertFalse(calls)
        responses, calls, _ = session(request("configure", settings={"token": "s3cret", "name": "Ada"}) + request("state"))
        self.assertEqual(responses[0]["state"], {})
        self.assertEqual(responses[1]["state"], {"ready": True})
        self.assertEqual(calls[0][0], {"token": "s3cret", "name": "Ada"})

        class IgnoresReturn(FakePlugin):
            def configure(self, settings, signal):
                return {"should": "not escape"}

        self.assertEqual(session(request("configure", settings={"token": "a", "name": "b"}), IgnoresReturn())[0][0]["state"], {})

    def test_failed_reconfiguration_invalidates_old_state_and_handler_timeout_stops_queue(self):
        configured = request("configure", settings={"token": "s3cret", "name": "Ada"})
        responses, _, _ = session(configured + request("configure", settings={}) + request("state"))
        self.assertEqual(responses[1]["error"]["code"], "invalid_arguments")
        self.assertEqual(responses[2]["error"]["code"], "invalid_request")

        class TimedOut(FakePlugin):
            def state(self, signal):
                raise PluginError("timeout")

            def execute(self, action, args, signal):
                raise AssertionError("A handler-raised timeout must not admit another action")

        responses, _, _ = session(configured + request("state") + request("execute", action="go", args={}), TimedOut())
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[1]["error"]["code"], "timeout")

    def test_configure_rejects_undeclared_missing_extra_and_oversized_values(self):
        for settings in [{}, {"token": "only"}, {"token": "a", "name": "b", "extra": "c"},
                         {"token": 1, "name": "b"}, {"token": "x" * 2049, "name": "b"}]:
            with self.subTest(settings=settings):
                responses, calls, _ = session(request("configure", settings=settings))
                self.assertEqual(responses[0]["error"]["code"], "invalid_arguments")
                self.assertFalse(calls)
        self.assertEqual(session(request("configure", settings={"token": "x" * 2048, "name": ""}))[0][0]["state"], {})

    def test_missing_handler_and_failures_do_not_leak_secrets(self):
        plugin = FakePlugin()
        plugin.configure = None
        response, _, _ = session(request("configure", settings={"token": "a", "name": "b"}), plugin)
        self.assertEqual(response[0]["error"]["code"], "internal_error")

        def fail(settings, signal):
            raise RuntimeError("secret-token /private/token")

        plugin = FakePlugin()
        plugin.configure = fail
        responses, _, output = session(request("configure", settings={"token": "secret-token", "name": "Ada"}), plugin)
        self.assertEqual(responses[0]["error"]["code"], "internal_error")
        self.assertNotIn(b"secret-token", output)
        self.assertNotIn(b"/private/token", output)

        plain = dict(MANIFEST)
        del plain["settings"]
        response, _, _ = session(request("configure", settings={}), type("Plain", (FakePlugin,), {"manifest": plain})())
        self.assertEqual(response[0]["error"]["code"], "invalid_request")

    def test_settings_and_choices_manifest_parity_with_typescript(self):
        choices = {"type": "integer", "minimum": 0, "maximum": 3, "choicesKey": "levels"}
        cases = [copy.deepcopy(MANIFEST), {**MANIFEST, "settings": {}}, {**MANIFEST, "settings": None},
                 {**MANIFEST, "settings": {"bad key": {"type": "text", "label": "x"}}},
                 {**MANIFEST, "settings": {"ok": {"type": "password", "label": "x"}}},
                 {**MANIFEST, "settings": {"ok": {"type": "text", "label": "x" * 81}}},
                 {**MANIFEST, "settings": {"ok": {"type": "secret", "label": "Label", "extra": 1}}},
                 {**MANIFEST, "actions": [{"id": "go", "title": "Go", "config": {"value": choices}}]},
                 {**MANIFEST, "actions": [{"id": "go", "title": "Go", "config": {"value": {**choices, "choicesKey": "../bad"}}}]},
                 {**MANIFEST, "actions": [{"id": "go", "title": "Go", "config": {"value": {**choices, "control": {"step": 1}}}}]},
                 {**MANIFEST, "actions": [{"id": "go", "title": "Go", "config": {"value": {**choices, "type": "boolean"}}}]}]
        results = []
        for case in cases:
            try:
                self.assertIs(validate_manifest(case), case)
                results.append(True)
            except TypeError:
                results.append(False)
        js = ROOT.parent / "plugin-sdk/index.js"
        script = ("import {validateManifest} from " + json.dumps(js.as_uri())
                  + "; let s=''; for await (const c of process.stdin) s+=c;"
                  + " console.log(JSON.stringify(JSON.parse(s).map(v=>{try{validateManifest(v);return true}catch{return false}})));")
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(cases),
                                text=True, capture_output=True, check=True)
        self.assertEqual(results, json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()
