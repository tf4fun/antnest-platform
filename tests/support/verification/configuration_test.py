"""Storage validation for the parameterized deployment/verification drivers."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from configuration import configured_arguments, durable_path


class ConfigurationTests(unittest.TestCase):
    def test_paths_and_symlinks_cannot_reintroduce_cache_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.cache').mkdir()
            (root / 'alias').symlink_to(root / '.cache', target_is_directory=True)
            for path in [root / '.cache/new/report.json', root / 'alias/new/report.json']:
                with self.assertRaisesRegex(ValueError, 'durable.*cache'):
                    durable_path(path)

    def test_config_must_reject_cache_inputs_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'evidence'
            for value in [{'input_path': str(root / '.cache/baseline.json')},
                          {'reports': {'recovery': str(root / '.cache/recover.json')}}]:
                config = root / 'config.json'
                config.write_text(json.dumps({'output': str(output), **value}))
                with self.assertRaisesRegex(ValueError, 'durable.*cache'):
                    configured_arguments(['--config', str(config), 'before'])
                self.assertFalse(output.exists())

    def test_explicit_configuration_preserves_profile_fields_and_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'config.json'
            config.write_text(json.dumps({'output': str(root / 'evidence'), 'expected': {'containers': 12}}))
            result, mode = configured_arguments(['--config', str(config), 'before'])
            self.assertEqual(mode, 'before')
            self.assertEqual(result['expected']['containers'], 12)
            self.assertTrue(Path(result['output']).is_dir())
            self.assertEqual(Path(result['output']).stat().st_mode & 0o777, 0o700)

    def test_an_explicit_config_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                configured_arguments([], require_mode=False)


if __name__ == '__main__':
    unittest.main()
