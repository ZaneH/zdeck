import asyncio
import copy
import io
from importlib.resources import files
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from zdeck_plugin_sdk import LIMITS, PluginError, serve, validate_arguments, validate_manifest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "examples/hello/manifest.json").read_text())


def request(kind, **extra):
    return (json.dumps({"protocolVersion": 1, "id": "r1", "type": kind, **extra}) + "\n").encode()


class FakePlugin:
    manifest = MANIFEST

    def __init__(self):
        self.calls = []

    def state(self, signal):
        return {"ready": True}

    def execute(self, action, args, signal):
        self.calls.append((action, args))
        return {"ready": True}


def session(wire, plugin=None):
    plugin = plugin or FakePlugin()
    output = io.BytesIO()
    serve(plugin, input=io.BytesIO(wire), output=output)
    return [json.loads(line) for line in output.getvalue().splitlines()], plugin.calls


class SDKTests(unittest.TestCase):
    def test_describe_state_execute(self):
        responses, calls = session(request("describe") + request("state") + request("execute", action="set-level", args={"level": 100}))
        self.assertEqual(responses[0]["manifest"], MANIFEST)
        self.assertEqual(responses[1]["state"], {"ready": True})
        self.assertEqual(calls, [("set-level", {"level": 100})])
        self.assertEqual(session(b"")[0], [])

    def test_arguments_are_strict_and_step_aligned(self):
        for value in [-1, 101, 1.5, True, "50", None, 1, 2**53, 10**400, math.nan, math.inf]:
            with self.subTest(value=value):
                responses, calls = session(request("execute", action="set-level", args={"level": value}))
                self.assertEqual(responses[0]["type"], "error")
                self.assertEqual(responses[0]["error"]["outcome"], "not_started")
                self.assertFalse(calls)
        for args in [{}, {"level": 5, "other": 2}, None, []]:
            with self.assertRaises(PluginError):
                validate_arguments(MANIFEST["actions"][0], args)
        for value in [0, 5, 100, 5.0]:
            self.assertEqual(validate_arguments(MANIFEST["actions"][0], {"level": value}), {"level": value})
        for value in [0, 1, "true"]:
            with self.assertRaises(PluginError):
                validate_arguments(MANIFEST["actions"][1], {"enabled": value})

    def test_invalid_requests(self):
        wires = [b"{\n", b"\n", b"null\n", b"[]\n", b"\xff\n", request("state", protocolVersion=True),
                 request("state", protocolVersion=2), request("state", id=""), request("state", extra=True),
                 request("shutdown"), request("execute", action="missing", args={})]
        responses, calls = session(b"".join(wires))
        self.assertEqual(len(responses), len(wires))
        self.assertTrue(all(response["type"] == "error" for response in responses))
        self.assertEqual(responses[0]["id"], None)
        self.assertEqual(responses[-1]["error"]["code"], "unknown_action")
        self.assertFalse(calls)

    def test_bounded_framing_crlf_and_eof(self):
        line = request("state").rstrip(b"\n")
        boundary = line + b" " * (LIMITS["request_bytes"] - len(line))
        wire = request("state").replace(b"\n", b"\r\n") + boundary + b"\n" + boundary + b" \n" + request("describe") + b"{"
        responses, _ = session(wire)
        self.assertEqual([r["type"] for r in responses], ["result", "result", "error", "result", "error"])
        self.assertEqual(responses[2]["error"]["code"], "request_too_large")
        self.assertEqual(responses[-1]["error"]["code"], "invalid_request")
        self.assertEqual(session(b"x" * 100000)[0][0]["error"]["code"], "request_too_large")

    def test_handler_failures_are_sanitized(self):
        for value in [None, [], {"token": object()}, {"number": math.nan}, {1: "invalid key"}, {"tuple": (1, 2)}]:
            plugin = FakePlugin()
            plugin.state = lambda signal: value
            response = session(request("state"), plugin)[0][0]
            self.assertEqual(response["type"], "error")
            self.assertNotIn("token", json.dumps(response))
        plugin = FakePlugin()

        def fail(*args):
            raise RuntimeError("secret /private/token")

        plugin.execute = fail
        response = session(request("execute", action="set-level", args={"level": 5}), plugin)[0][0]
        self.assertEqual(response["error"]["outcome"], "unknown")
        self.assertNotIn("secret", json.dumps(response))
        plugin.state = lambda signal: {"text": "x" * 65536}
        self.assertEqual(session(request("state"), plugin)[0][0]["error"]["code"], "response_too_large")
        self.assertEqual(PluginError("untrusted").code, "internal_error")
        def tampered(signal):
            error = PluginError("internal_error")
            error.code = ["private token"]
            raise error
        plugin.state = tampered
        self.assertEqual(session(request("state"), plugin)[0][0]["error"]["code"], "internal_error")

    def test_async_handlers_and_snapshot(self):
        plugin = FakePlugin()
        plugin.manifest = copy.deepcopy(MANIFEST)

        async def state(signal):
            await asyncio.sleep(0)
            plugin.manifest["id"] = "mutated"
            return {"async": True}

        plugin.state = state
        responses, _ = session(request("state") + request("describe"), plugin)
        self.assertEqual(responses[0]["state"], {"async": True})
        self.assertEqual(responses[1]["manifest"]["id"], "hello-python")

    def test_timeout_signals_and_stops_queued_actions(self):
        for kind in ["state", "execute"]:
            signal_seen = []
            release = threading.Event()
            plugin = FakePlugin()

            def hang(*args):
                signal_seen.append(args[-1])
                release.wait(1)
                return {}

            setattr(plugin, kind, hang)
            try:
                with patch("zdeck_plugin_sdk.LIMITS", {**LIMITS, "request_timeout_ms": 5}):
                    responses, calls = session(request(kind, **({"action": "set-level", "args": {"level": 5}} if kind == "execute" else {})) + request("execute", action="set-level", args={"level": 10}), plugin)
                self.assertEqual(len(responses), 1)
                self.assertEqual(responses[0]["error"]["code"], "timeout")
                self.assertEqual(responses[0]["error"]["outcome"], "unknown" if kind == "execute" else "not_started")
                self.assertTrue(signal_seen[0].is_set())
                self.assertFalse(calls)
            finally:
                release.set()

    def test_write_errors_propagate(self):
        class Broken(io.BytesIO):
            def write(self, value):
                raise OSError("closed pipe")
        with self.assertRaises(OSError):
            serve(FakePlugin(), input=io.BytesIO(request("describe")), output=Broken())

    def test_manifest_contract_matches_typescript(self):
        good = copy.deepcopy(MANIFEST)
        icon = {"id": "go", "title": "Go", "category": "Media", "src": "data:image/svg+xml;base64,PHN2Zy8+"}
        cases = [good, {**good, "icons": [icon], "icon": icon["src"]}, None, {},
                 {**good, "id": "../escape"}, {**good, "protocolVersion": True},
                 {**good, "entrypoint": "evil.py"}, {**good, "actions": []},
                 {**good, "actions": [good["actions"][0]] * 2}, {**good, "icons": [icon, icon]},
                 {**good, "icon": "https://example.com/icon.png"}, {**good, "version": "latest"},
                 {**good, "actions": [{"id": "go", "title": "😀" * 40, "config": {}}]},
                 {**good, "actions": [{"id": "go", "title": "😀" * 41, "config": {}}]},
                 {**good, "icons": [{**icon, "id": f"icon-{i}", "src": "data:image/png;base64," + "AAAA" * 1000} for i in range(5)]}]
        for field in [{"type": "integer", "minimum": True, "maximum": 100},
                      {"type": "integer", "minimum": 0, "maximum": 100, "control": {"step": 3}},
                      {"type": "boolean", "control": {"stateKey": "../bad"}},
                      {"type": "integer", "minimum": 0, "maximum": 2**53},
                      {"type": "string"}]:
            cases.append({**good, "actions": [{"id": "go", "title": "Go", "config": {"value": field}}]})
        results = []
        for case in cases:
            try:
                self.assertIs(validate_manifest(case), case)
                results.append(True)
            except TypeError:
                results.append(False)
        js = ROOT.parent / "plugin-sdk/index.js"
        script = "import {validateManifest} from " + json.dumps(js.as_uri()) + "; let s=''; for await (const c of process.stdin) s+=c; console.log(JSON.stringify(JSON.parse(s).map(v=>{try{validateManifest(v);return true}catch{return false}})));"
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(cases), text=True, capture_output=True, check=True)
        self.assertEqual(results, json.loads(result.stdout))

    def test_self_contained_example_from_another_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "hello-python"
            shutil.copytree(ROOT / "examples/hello", folder)
            sdk = folder / "zdeck_plugin_sdk"
            sdk.mkdir()
            for name in ["__init__.py", "types.py", "py.typed"]:
                (sdk / name).write_bytes(files("zdeck_plugin_sdk").joinpath(name).read_bytes())
            wire = request("describe") + request("execute", action="set-level", args={"level": 25}) + request("state")
            process = subprocess.run([sys.executable, "-E", "-s", "-B", str(folder / "main.py")], input=wire, cwd=temp, capture_output=True, check=True)
            responses = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual(responses[0]["manifest"], MANIFEST)
            self.assertEqual(responses[1]["state"], {"level": 25, "enabled": False})
            self.assertEqual(responses[2]["state"], responses[1]["state"])
            self.assertEqual(process.stderr, b"")
            self.assertFalse(list(folder.rglob("__pycache__")))


if __name__ == "__main__":
    unittest.main()
