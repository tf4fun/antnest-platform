"""Preflight and cancellation edge cases for diagnostic process ownership."""
import json
from pathlib import Path
import signal
import subprocess
import re
import tempfile
import unittest
from unittest.mock import Mock, patch
from configuration import configured_arguments
from observer_configuration import evidence_file, validate_observer
from owned_process import OwnedProcess


class ObserverConfigurationTests(unittest.TestCase):
    def test_invalid_configuration_never_creates_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {'output': str(root / 'output'), 'command': ['true'], 'environment': {},
                      'project_pattern': r'antnest-\d+', 'services': ['agent-controller']}
            for change in [{'output': ''}, {'command': []}, {'command': ['']}, {'command': ['true', '\0']},
                           {'environment': {'A=B': 'bad'}}, {'environment': {'A': 1}},
                           {'services': []}, {'services': ['']}, {'project_pattern': '('},
                           {'project_pattern': '(a)(b)'}, {'project_pattern': '.*'},
                           {'cleanup_grace_seconds': 0}, {'cleanup_grace_seconds': True}]:
                with self.subTest(change=change):
                    file = root / 'config.json'
                    file.write_text(json.dumps({**config, **change}))
                    with self.assertRaises((ValueError, re.error)):
                        configured_arguments(['--config', str(file)], require_mode=False,
                                             validate_config=lambda value: validate_observer(value, 'commands'))
                    self.assertFalse((root / 'output').exists())

    def test_original_cleanup_defaults_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            shared = {'output': temporary, 'command': ['true'], 'environment': {}}
            for profile, grace, settings in [
                ('commands', 180, {'project_pattern': 'project', 'services': ['service']}),
                ('sdk', 45, {'container_filter': 'name=fixture', 'container_pattern': 'fixture'}),
                ('interruption', 150, {'project_template': 'fixture-{pid}', 'trigger_filter': 'name={project}', 'trigger_description': 'created'}),
            ]:
                config = {**shared, **settings}
                validate_observer(config, profile)
                self.assertEqual(config['cleanup_grace_seconds'], grace)

    def test_evidence_names_and_cache_aliases_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'alias.json').symlink_to(Path(__file__).resolve().parents[3] / '.cache', target_is_directory=True)
            for name in ['../escape', '/absolute', '', 'alias.json']:
                with self.assertRaises(ValueError):
                    evidence_file(root, name)

    def test_spawn_cancellation_window_still_cleans_assigned_child(self):
        owner = OwnedProcess(['unused'], grace_seconds=1)
        child = Mock(pid=12345)
        def spawn(*args, **kwargs):
            owner._cancel(signal.SIGTERM, None)
            return child
        with patch('owned_process.subprocess.Popen', side_effect=spawn), patch.object(owner, 'cleanup') as cleanup:
            with self.assertRaises(SystemExit) as outcome:
                owner.__enter__()
            self.assertEqual(outcome.exception.code, 143)
            self.assertIs(owner.child, child)
            cleanup.assert_called_once()

    def test_cleanup_failure_does_not_replace_primary_failure(self):
        owner = OwnedProcess(['unused'], grace_seconds=1)
        primary = RuntimeError('primary failure')
        with patch.object(owner, 'cleanup', side_effect=RuntimeError('cleanup failure')):
            self.assertFalse(owner.__exit__(type(primary), primary, None))
        self.assertIn('cleanup failure', primary.__notes__[0])

    def test_vanished_group_and_repeated_cancel_are_idempotent(self):
        owner = OwnedProcess(['unused'], grace_seconds=1)
        owner.child = Mock(pid=12345)
        with patch('owned_process.os.killpg', side_effect=ProcessLookupError):
            self.assertFalse(owner.signal_group(signal.SIGTERM))
        with patch('owned_process.os.killpg'):
            self.assertTrue(owner.signal_group(signal.SIGTERM))
        owner._cancel(signal.SIGINT, None)
        owner._cancel(signal.SIGTERM, None)
        with self.assertRaises(SystemExit) as outcome:
            owner.check_cancel()
        self.assertEqual(outcome.exception.code, 130)

    def test_cancelled_process_probe_cannot_skip_group_escalation(self):
        owner = OwnedProcess(['unused'], grace_seconds=1)
        owner.child = Mock(pid=12345)
        with patch('owned_process.os.killpg'), patch.object(owner, 'group_members', side_effect=subprocess.CalledProcessError(143, 'ps')):
            self.assertTrue(owner._group_alive())


if __name__ == '__main__':
    unittest.main()
