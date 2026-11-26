import copy
import json
import unittest
from pathlib import Path
from zdeck_plugin_sdk import validate_manifest


class ValueContractTest(unittest.TestCase):
    def test_actual_home_assistant_manifest_and_rejected_bindings(self):
        path = Path(__file__).resolve().parents[3] / 'plugins/home-assistant/manifest.json'
        manifest = json.loads(path.read_text())
        self.assertIs(validate_manifest(manifest), manifest)
        variants = []
        for field in ('entityKey', 'stateKey', 'id'):
            bad = copy.deepcopy(manifest)
            bad['values'][0][field] = 'power' if field == 'id' else 'missing'
            variants.append(bad)
        bad = copy.deepcopy(manifest)
        bad['actions'][0]['config']['enabled']['control']['entityKey'] = None
        variants.append(bad)
        bad = copy.deepcopy(manifest)
        bad['values'] = None
        variants.append(bad)
        for bad in variants:
            with self.assertRaises(TypeError):
                validate_manifest(bad)
