# zDeck Python plugin SDK

Python 3.10+ SDK for the same **protocol v1** used by `@zdeck/plugin-sdk`. Python plugins contribute the same actions, sliders, toggles and embedded icons as JavaScript/TypeScript plugins. No Node runtime is required for a Python plugin. MIT licensed; no runtime dependencies. This package is not yet published to PyPI.

## Quick start (from this repository)

Run from the repository root with Python 3.10 or newer installed. Create a **new** staging folder, then copy the example and SDK into it (PowerShell users can use `New-Item` and `Copy-Item` instead):

```sh
mkdir -p build/python-plugins
mkdir build/python-plugins/hello-python
cp packages/plugin-sdk-python/examples/hello/main.py build/python-plugins/hello-python/
cp packages/plugin-sdk-python/examples/hello/manifest.json build/python-plugins/hello-python/
mkdir build/python-plugins/hello-python/zdeck_plugin_sdk
cp packages/plugin-sdk-python/zdeck_plugin_sdk/*.py build/python-plugins/hello-python/zdeck_plugin_sdk/
cp packages/plugin-sdk-python/zdeck_plugin_sdk/py.typed build/python-plugins/hello-python/zdeck_plugin_sdk/
cp packages/plugin-sdk-python/LICENSE build/python-plugins/hello-python/
printf '{"protocolVersion":1,"id":"hello","type":"describe"}\n' \
  | python3 -E -s -B build/python-plugins/hello-python/main.py
```

On Windows use `python` for the interpreter. This example only updates in-memory values; it does not control an external application. `describe` never calls handlers.

Copy the **entire `hello-python` folder** into zDeck's plugin folder (Settings → External plugins → Open plugin folder), then Refresh, review, trust and enable it. The folder name must equal `manifest.id`. Do not copy a virtual environment, source checkout, symlinks, `__pycache__` or `.pyc` files into a distribution. Desktop runtime detection uses PATH plus common Python install locations on Windows, macOS and Linux. Install Python separately; zDeck does not bundle/download it or run pip. On Windows the Python executable, not just the `py` launcher, must be available.

A Python installation contains `manifest.json`, **one fixed `main.py`**, and the regular local `zdeck_plugin_sdk` directory (including `__init__.py` and `types.py`) alongside it. Folders with both `main.js` and `main.py` are rejected. Manifests contain no executable paths or runtime flags. Python is launched without a shell, using `-E -s -B`: ignore `PYTHON*` environment settings, disable user-site packages, and avoid bytecode writes that would change trusted package fingerprints. Global site packages are not disabled; process separation is **not a sandbox**.

For additional dependencies, vendor real files beside `main.py` using your developer environment and include their licenses. Recipients should not run pip or install from a source tree. The existing package fingerprint limits (4096 files / 64 MiB) apply; large dependency stacks cannot be installed this way.

## API

```python
from threading import Event
from zdeck_plugin_sdk import Args, Manifest, State, serve

class MyPlugin:
    manifest: Manifest = {
        "id": "my-plugin", "version": "0.1.0", "protocolVersion": 1,
        "actions": [{"id": "go", "title": "Go", "config": {}}],
    }

    def state(self, signal: Event) -> State:
        return {"ready": True}

    def execute(self, action: str, args: Args, signal: Event) -> State:
        # Perform the action once, then return observed JSON state.
        return self.state(signal)

if __name__ == "__main__":
    serve(MyPlugin())
```

- `serve(plugin, *, input=None, output=None)` blocks until EOF or timeout. Optional streams are **binary** file-like objects. Stdout is reserved for one UTF-8 JSON response per line; send local diagnostics to stderr, never secrets.
- Handlers may be `def` or `async def`. They run sequentially in worker threads; async handlers get a new event loop per call. Create loop/thread-bound resources inside the handler, not in the main thread or an earlier request. Main-thread-only OS APIs must be marshalled explicitly by the plugin.
- `signal` is a `threading.Event`, set at the 10-second deadline. Check `signal.is_set()` during long work and give blocking I/O its own timeout. Python cannot forcibly cancel arbitrary handler code: after a deadline the SDK sends `timeout` and returns without admitting another request. Use `serve` as the main process's final operation; never restart it or retry timed-out actions. A daemon worker permits process exit even when a handler ignores cancellation.
- `validate_manifest(value)` returns the original object or raises `TypeError`; `serve` snapshots metadata before reading requests.
- `validate_arguments(action, args)` returns the original dict or raises `PluginError`. Integer fields accept only finite, safe integral JSON numbers (not booleans), with declared bounds and `minimum + n * step` alignment. All configured fields are required; extras are rejected. Boolean fields accept only `bool`.
- `PluginError(code)` exposes a fixed public error code/message/hint. Unknown codes become `internal_error`; raw exception text is never returned. Supported codes match the TypeScript SDK; application-specific hints are platform-neutral in Python. Once an execute handler is invoked, failures report `outcome: "unknown"`, never imply the action was not applied. No automatic retry.
- State must be a dict of JSON values (string keys, dict/list/null/bool/int/finite float/string). Non-JSON values, non-finite numbers and cycles produce sanitized errors. Transport errors propagate rather than printing protocol noise.
- `PROTOCOL_VERSION` is `1`; read-only `LIMITS` exposes `request_bytes=16384`, `response_bytes=65536`, `manifest_bytes=16384`, `request_timeout_ms=10000`.

Wire field names remain camelCase (`protocolVersion`, `stateKey`); Python API names are snake_case. The manifest schema, icon limits, control metadata and request/error framing are documented in [the TypeScript SDK](../plugin-sdk/README.md) and [the plugin contract](../../docs/plugins.md). Only one control-bearing field per action is supported. Live state is session-only; persist explicit user configuration in the host, not action results.

## Development and verification

```sh
cd packages/plugin-sdk-python
python3 -B -m unittest discover -s tests -v
```

Tests use the standard library, plus installed Node for cross-language contract checks. They cover strict validation, framing bounds, cancellation, sanitization, sync/async handlers and a self-contained consumer in a temporary directory. Rust integration tests launch the Python example through the real host, test trust, execute, restart/restore, disable persistence and fingerprint stability. The cross-platform CI matrix runs both suites on Python 3.10 and builds a wheel, then reruns the SDK tests against that wheel's public import (including a consumer copied from its package resources). A local macOS pass is not proof of Windows/Linux native parity.

`pyproject.toml` provides setuptools packaging metadata for developer installation/builds; setuptools is a build dependency only. Desktop plugins bundle the `zdeck_plugin_sdk` directory, so end users do not need package installation. PyPI publishing, runtime bundling and automatic dependency installation are not included.
