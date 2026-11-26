"""Run from a prepared plugin folder; stdout is reserved for the protocol."""
import json
from pathlib import Path
from threading import Event

from zdeck_plugin_sdk import Args, Manifest, State, serve


class Hello:
    manifest: Manifest = json.loads(Path(__file__).with_name("manifest.json").read_text(encoding="utf-8"))

    def __init__(self):
        self.level = 0
        self.enabled = False

    def state(self, signal: Event) -> State:
        return {"level": self.level, "enabled": self.enabled}

    def execute(self, action: str, args: Args, signal: Event) -> State:
        if action == "set-level":
            self.level = args["level"]
        elif action == "set-enabled":
            self.enabled = args["enabled"]
        return self.state(signal)


if __name__ == "__main__":
    serve(Hello())
