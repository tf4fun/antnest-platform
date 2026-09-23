"""Execute the actual final-check entries with deterministic external read fixtures."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch
from development_configuration_test import DevelopmentFixtures, ROOT, IMAGE


class FinalEntryTests(DevelopmentFixtures, unittest.TestCase):
    def evidence(self, profile):
        config = self.final()
        for key in ['agent_before_path', 'agent_final_path']:
            Path(config[key]).write_text(json.dumps({'checked_at': key, 'agent_id': 'retained'}))
        lifecycle = json.loads(Path(config['lifecycle_report_path']).read_text())
        lifecycle['source_absence_404'] = 1
        for index, row in enumerate(lifecycle['lifecycle']):
            row['evidence'].update(strict_trace='failed' if index == 0 else 'passed', platform_absence_probes=[2, 1, 0, 2, 0][index])
        for row in lifecycle['publication']:
            row['strict_trace'] = 'passed'
        Path(config['lifecycle_report_path']).write_text(json.dumps(lifecycle))
        replay = json.loads(Path(config['replay_report_path']).read_text())
        replay.update(history_exact=True, new_runs=0, new_tools=0, durable_messages=5, notifications=5)
        replay['trace'].update(error_spans=0, strict_trace='passed')
        Path(config['replay_report_path']).write_text(json.dumps(replay))
        Path(config['after_snapshot_path']).write_text(json.dumps({'runtime_controller_image': IMAGE}))
        if profile == 'temporal':
            del config['runtime_controller_container']
            config['agent_controller_container'] = 'antnest-fixture-agent-controller-1'
            config['compose_snapshot_path'] = self.put('compose.json', {'services': {'agent-controller': {'depends_on': {'temporal': {'condition': 'service_healthy'}}}}})
        return config

    def execute(self, profile, config, *, process=''):
        self.calls = []
        def external(argv, **kwargs):
            self.calls.append(argv)
            if argv[:2] == ['docker', 'inspect']:
                return json.dumps([{'Image': IMAGE, 'State': {'StartedAt': '1970-01-01T00:00:00.000050Z'}}])
            if argv[0] == 'ps':
                return process
            if argv[0] == 'docker' and '--filter' in argv:
                return ''
            raise AssertionError(argv)
        path = self.root / 'config.json'; path.write_text(json.dumps(config))
        entry = ROOT / 'tests/e2e/development' / (profile + '-final-checks.py')
        with patch.object(sys, 'argv', [str(entry), '--config', str(path)]), patch('subprocess.check_output', side_effect=external), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(entry), run_name='__main__')
        return json.loads(Path(config['summary_path']).read_text())

    def test_both_entries_preserve_business_counts_and_strict_failure(self):
        for profile in ['runtime', 'temporal']:
            with self.subTest(profile=profile):
                config = self.evidence(profile)
                result = self.execute(profile, config)
                self.assertEqual(result['trace_topologies'], 9)
                self.assertEqual(result['strict_failed'], 1)
                self.assertEqual(result['missing_parent_edges'], 0)
                Path(config['summary_path']).unlink()

    def test_publication_cutoff_cannot_be_bypassed_by_renaming_files(self):
        config = self.evidence('runtime')
        for index in range(3):
            (self.output / f'publication-{index}.json').rename(self.output / f'renamed-{index}.json')
        config['publication_trace_glob'] = 'renamed-*.json'
        path = self.output / 'renamed-0.json'; trace = json.loads(path.read_text()); trace['spans'][0]['startTime'] = 10
        path.write_text(json.dumps(trace))
        with self.assertRaisesRegex(AssertionError, 'publication predates'):
            self.execute('runtime', config)
        self.assertFalse(Path(config['summary_path']).exists())

    def test_formal_process_residue_is_rejected(self):
        config = self.evidence('temporal')
        with self.assertRaisesRegex(AssertionError, 'verification'):
            self.execute('temporal', config, process='800005 1 node tests/e2e/development/lifecycle.mjs --config /tmp/run.json')
        self.assertFalse(Path(config['summary_path']).exists())

    def test_duplicate_raw_trace_fails_before_docker(self):
        config = self.evidence('runtime')
        path = Path(config['replay_trace_path']); trace = json.loads(path.read_text()); trace['traceID'] = format(1, '032x'); path.write_text(json.dumps(trace))
        with self.assertRaises(ValueError):
            self.execute('runtime', config)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
