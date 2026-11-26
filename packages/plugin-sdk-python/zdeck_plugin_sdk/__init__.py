"""Protocol v1 SDK for trusted local zDeck plugins (Python 3.10+)."""
from __future__ import annotations

import asyncio
import copy
import inspect
import json
import math
import queue
import re
import sys
import threading
from types import MappingProxyType
from typing import Any, Awaitable, BinaryIO, Protocol

from .types import Action, Args, BooleanConfig, Icon, IntegerConfig, Json, Manifest, State

__all__ = ["PROTOCOL_VERSION", "LIMITS", "Action", "Args", "BooleanConfig", "Icon", "IntegerConfig",
           "Json", "Manifest", "State", "Plugin", "PluginError", "validate_manifest", "validate_arguments", "serve"]

PROTOCOL_VERSION = 1
LIMITS = MappingProxyType({"request_bytes": 16384, "response_bytes": 65536,
                           "manifest_bytes": 16384, "request_timeout_ms": 10000})


class Plugin(Protocol):
    manifest: Manifest

    def state(self, signal: threading.Event) -> State | Awaitable[State]: ...

    def execute(self, action: str, args: Args,
                signal: threading.Event) -> State | Awaitable[State]: ...


_ERRORS = {
    "invalid_request": ("Invalid protocol v1 request.", "Check the request shape, version, ID and newline framing."),
    "request_too_large": ("Request exceeds 16384 bytes.", "Send a smaller request."),
    "unknown_action": ("Action is not declared by this plugin.", "Use describe to discover supported action IDs."),
    "invalid_arguments": ("Action arguments do not match its configuration.", "Use only declared fields with bounded, step-aligned integers or boolean values."),
    "internal_error": ("Plugin operation failed.", "Check trusted local stderr diagnostics; do not automatically retry actions."),
    "response_too_large": ("Plugin response exceeds 65536 bytes.", "Reduce the state returned by the plugin."),
    "timeout": ("Plugin operation timed out.", "Restart the plugin; inspect state before manually retrying an action."),
    "unsupported_platform": ("Plugin does not support this platform.", "Check the plugin's platform requirements."),
    "app_missing": ("Required application was not found.", "Install the application required by this plugin."),
    "app_not_running": ("Required application is not running.", "Open the application manually, then try again."),
    "automation_denied": ("OS permission was denied.", "Review the application's OS permissions before retrying."),
    "command_failed": ("Application control failed.", "Check the application is responsive; inspect state before manually retrying an action."),
    "invalid_state": ("Plugin returned unreadable state.", "Check plugin compatibility and restart the plugin."),
    "outcome_unknown": ("Action may have applied, but state could not be read.", "Read state before deciding whether to retry; never automatically retry."),
}


class PluginError(Exception):
    def __init__(self, code: str):
        self.code = code if isinstance(code, str) and code in _ERRORS else "internal_error"
        super().__init__(_ERRORS[self.code][0])


def _exact(value, keys):
    return type(value) is dict and value.keys() == set(keys)


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value) is not None


def _request_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) is not None


def _integer(value):
    # bool is an int subclass; JSON numbers must match JavaScript's safe-integer range.
    return type(value) in (int, float) and abs(value) <= 9007199254740991 and math.isfinite(value) and value == int(value)


def _text(value):
    return isinstance(value, str) and 0 < len(value.encode("utf-16-le", errors="surrogatepass")) // 2 <= 80 and not re.search(r"[\x00-\x1f\x7f]", value)


def _icon(value):
    return isinstance(value, str) and len(value) <= 8192 and not value.endswith(",") and re.fullmatch(
        r"data:image/(?:png|jpeg|webp|gif|svg\+xml);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value) is not None


def _field(field):
    if type(field) is not dict:
        return False
    controlled = "control" in field
    control = field.get("control")
    if field.get("type") == "boolean":
        return _exact(field, ["type"] + (["control"] if controlled else [])) and (
            not controlled or _exact(control, ["stateKey"]) and _identifier(control["stateKey"]))
    if not (_exact(field, ["type", "minimum", "maximum"] + (["control"] if controlled else []))
            and field["type"] == "integer" and _integer(field["minimum"])
            and _integer(field["maximum"]) and field["minimum"] <= field["maximum"]):
        return False
    span = field["maximum"] - field["minimum"]
    return not controlled or (_exact(control, ["step"]) and _integer(control["step"])
                              and 0 < control["step"] <= span and _integer(span) and span % control["step"] == 0)


def _encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _json_value(value):
    if type(value) is dict:
        return all(type(key) is str and _json_value(item) for key, item in value.items())
    if type(value) is list:
        return all(_json_value(item) for item in value)
    return value is None or type(value) in (str, bool, int) or type(value) is float and math.isfinite(value)


def validate_manifest(value: Any) -> Manifest:
    """Validate the wire schema; return the original manifest or raise TypeError."""
    try:
        keys = ["id", "version", "protocolVersion", "actions"]
        if type(value) is not dict:
            raise ValueError
        keys += [key for key in ("icon", "icons") if key in value]
        if not (_exact(value, keys) and _identifier(value["id"])
                and isinstance(value["version"], str) and re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", value["version"])
                and _integer(value["protocolVersion"]) and value["protocolVersion"] == 1
                and type(value["actions"]) is list and 1 <= len(value["actions"]) <= 32):
            raise ValueError
        if "icon" in value and not _icon(value["icon"]):
            raise ValueError
        if "icons" in value:
            icons = value["icons"]
            if type(icons) is not list or len(icons) > 32:
                raise ValueError
            seen = set()
            for icon in icons:
                if not (_exact(icon, ["id", "title", "category", "src"]) and _identifier(icon["id"])
                        and icon["id"] not in seen and _text(icon["title"]) and icon["title"].strip()
                        and _text(icon["category"]) and icon["category"].strip() and _icon(icon["src"])):
                    raise ValueError
                seen.add(icon["id"])
        seen = set()
        for action in value["actions"]:
            if not (_exact(action, ["id", "title", "config"]) and _identifier(action["id"])
                    and action["id"] not in seen and _text(action["title"])
                    and type(action["config"]) is dict and len(action["config"]) <= 8):
                raise ValueError
            seen.add(action["id"])
            if not all(_identifier(key) and _field(field) for key, field in action["config"].items()):
                raise ValueError
            if sum("control" in field for field in action["config"].values()) > 1:
                raise ValueError
        # Measure UTF-8 as the JS SDK does, not Python's ASCII-escaped representation.
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > LIMITS["manifest_bytes"]:
            raise ValueError
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise TypeError("Invalid plugin manifest.") from None
    return value


def validate_arguments(action: dict, args: Any) -> Args:
    if not _exact(args, action["config"]):
        raise PluginError("invalid_arguments")
    for key, field in action["config"].items():
        value = args[key]
        if field["type"] == "boolean":
            valid = type(value) is bool
        else:
            valid = _integer(value) and field["minimum"] <= value <= field["maximum"] and (
                "control" not in field or (value - field["minimum"]) % field["control"]["step"] == 0)
        if not valid:
            raise PluginError("invalid_arguments")
    return args


def _validate_request(value):
    if not (type(value) is dict and _integer(value.get("protocolVersion")) and value["protocolVersion"] == 1
            and _request_id(value.get("id")) and value.get("type") in ("describe", "state", "execute")
            and _exact(value, ["protocolVersion", "id", "type"] + (["action", "args"] if value["type"] == "execute" else []))):
        raise PluginError("invalid_request")
    if value["type"] == "execute" and not (_identifier(value["action"]) and type(value["args"]) is dict):
        raise PluginError("invalid_request")


def _frames(stream):
    # readline's size bound prevents a hostile unterminated line from allocating indefinitely.
    while True:
        frame = stream.readline(LIMITS["request_bytes"] + 2)
        if not frame:
            return
        size = len(frame) - (1 if frame.endswith(b"\n") else 0)
        if size > LIMITS["request_bytes"]:
            while not frame.endswith(b"\n"):
                frame = stream.readline(LIMITS["request_bytes"] + 2)
                if not frame:
                    break
            yield None
        else:
            yield frame[:-1] if frame.endswith(b"\n") else False


def _invoke(handler, args, signal):
    result = queue.Queue(maxsize=1)

    async def await_result(value):
        return await value

    def run():
        try:
            value = handler(*args, signal)
            if inspect.isawaitable(value):
                value = asyncio.run(await_result(value))
            result.put((True, value))
        except BaseException as error:
            result.put((False, error))

    # Timed-out user code cannot be safely killed. A daemon lets the process exit;
    # serve never starts another request after timeout, even if the handler ignores signal.
    threading.Thread(target=run, daemon=True).start()
    try:
        success, value = result.get(timeout=LIMITS["request_timeout_ms"] / 1000)
    except queue.Empty:
        signal.set()
        raise PluginError("timeout") from None
    if not success:
        raise value
    return value


def _reject_constant(value):
    raise ValueError("Non-JSON numeric constant")


def serve(plugin: Plugin, *, input: BinaryIO | None = None, output: BinaryIO | None = None) -> None:
    """Serve newline-delimited binary stdio until EOF or timeout. Log to stderr only.

    Handlers run sequentially in worker threads, may be sync or async, and receive a
    threading.Event set on timeout. No action is retried. Transport errors propagate.
    """
    source = sys.stdin.buffer if input is None else input
    target = sys.stdout.buffer if output is None else output
    manifest = copy.deepcopy(validate_manifest(plugin.manifest))
    for frame in _frames(source):
        request_id = None
        invoked = timed_out = False
        try:
            if frame is None:
                raise PluginError("request_too_large")
            if frame is False:
                raise PluginError("invalid_request")
            try:
                request = json.loads(frame.decode("utf-8"), parse_constant=_reject_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise PluginError("invalid_request") from None
            if type(request) is dict and _request_id(request.get("id")):
                request_id = request["id"]
            _validate_request(request)
            if request["type"] == "describe":
                result = {"manifest": manifest}
            else:
                if request["type"] == "execute":
                    action = next((item for item in manifest["actions"] if item["id"] == request["action"]), None)
                    if action is None:
                        raise PluginError("unknown_action")
                    validate_arguments(action, request["args"])
                invoked = request["type"] == "execute"
                signal = threading.Event()
                state = _invoke(plugin.execute if invoked else plugin.state,
                                (request["action"], request["args"]) if invoked else (), signal)
                if type(state) is not dict or not _json_value(state):
                    raise PluginError("invalid_state")
                result = {"state": state}
            response = _encode({"protocolVersion": 1, "id": request_id, "type": "result", **result})
            if len(response) > LIMITS["response_bytes"]:
                raise PluginError("response_too_large")
        except Exception as error:
            code = error.code if isinstance(error, PluginError) and isinstance(error.code, str) and error.code in _ERRORS else "internal_error"
            timed_out = code == "timeout"
            message, hint = _ERRORS[code]
            response = _encode({"protocolVersion": 1, "id": request_id, "type": "error", "error": {
                "code": code, "message": message, "hint": hint, "outcome": "unknown" if invoked else "not_started"}})
        target.write(response + b"\n")
        target.flush()
        if timed_out:
            return
