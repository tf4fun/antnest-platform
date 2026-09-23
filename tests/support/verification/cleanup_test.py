"""Cleanup entry contracts, including failures before external commands."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from cleanup import prepare, verify
from cleanup_profiles import PROFILES
from cleanup_contracts import retained_snapshot
from cleanup_contracts_test import container


class CleanupEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.inputs = self.root / 'input'
        self.inputs.mkdir()
        self.row = container('a' * 64)
        self.calls = []
        self.overrides = {}

    def put(self, name, value):
        (self.inputs / name).write_text(json.dumps(value))

    def config(self, profile='identity-migration', **extra):
        spec = PROFILES[profile]
        self.put(spec['baseline'], retained_snapshot([self.row], spec['schema']))
        return dict(profile=profile, input_root=str(self.inputs), output=str(self.root / 'output'), **extra)

    def call(self, *args):
        self.calls.append(args)
        if args in self.overrides:
            return self.overrides[args]
        if args[:2] == ('docker', 'inspect'):
            return json.dumps([self.row])
        if args == ('docker', 'ps', '-aq'):
            return self.row['Id']
        if args[:3] == ('docker', 'image', 'inspect'):
            if '--format' in args:
                return self.row['Image']
            return json.dumps([{'Id': self.row['Image']}])
        return ''

    def test_catalog_covers_all_29_unique_originals_and_eight_schemas(self):
        self.assertEqual(len(PROFILES), 29)
        self.assertEqual(len({p['source'] for p in PROFILES.values()}), 29)
        self.assertEqual(len({p['schema'] for p in PROFILES.values()}), 8)

    def test_identity_empty_projects_allowed_and_no_process_inspection(self):
        result = verify(prepare(self.config()), call=self.call)
        self.assertEqual(result['temporary_projects'], [])
        self.assertFalse(any(args[0] == 'ps' for args in self.calls))
        self.assertIn(('docker', 'inspect', self.row['Id']), self.calls)

    def test_legacy_checks_both_labels_and_all_three_name_filters(self):
        config = self.config('legacy-acceptance/base')
        (self.inputs / 'base-docker-1.log').write_text('antnest-stage3-e2e-123 antnest-stage3-e2e-123')
        result = verify(prepare(config), call=self.call)
        filters = [args[-1] for args in self.calls if '--filter' in args]
        self.assertEqual(len(filters), 9)
        self.assertEqual(filters.count('name=antnest-stage3-e2e-123'), 3)
        self.assertEqual(result['projects'], ['antnest-stage3-e2e-123'])

    def test_resource_residue_fails_without_passing_report(self):
        config = self.config('legacy-acceptance/base')
        (self.inputs / 'base-docker-1.log').write_text('antnest-stage3-e2e-123')
        self.overrides[('docker', 'network', 'ls', '-q', '--filter', 'name=antnest-stage3-e2e-123')] = 'leftover'
        with self.assertRaisesRegex(AssertionError, 'resources remain'):
            verify(prepare(config), call=self.call)
        self.assertFalse((self.root / 'output' / 'base-cleanup.json').exists())

    def test_retirement_requires_project_and_detects_formal_child(self):
        config = self.config('acceptance-retirement')
        with self.assertRaisesRegex(ValueError, 'project'):
            prepare(config)
        (self.inputs / 'docker.log').write_text('C4 disposable project: antnest-lifecycle-1234abcd')
        self.overrides[('ps', '-axo', 'pid=,ppid=,command=')] = '999999 1 node tests/e2e/workspace-closeout/c4-run.mjs'
        with self.assertRaisesRegex(AssertionError, 'verification children'):
            verify(prepare(config), call=self.call)

    def test_crash_scope_only_includes_report_project(self):
        config = self.config('runtime-crash-recovery')
        self.put('postgres-cleanup.json', {'project': 'antnest-rc-crash-1234567890abcdef'})
        result = verify(prepare(config), call=self.call)
        filters = [args[-1] for args in self.calls if '--filter' in args]
        self.assertEqual(len(filters), 3)
        self.assertTrue(all('io.antnest.runtime-controller-scope=' in f for f in filters))
        self.assertEqual(result['scopes'], ['antnest-rc-crash-1234567890abcdef'])

    def test_explicit_project_count_cannot_be_weakened(self):
        for projects in [[], ['antnest-lifecycle-1234abcd'], ['antnest-lifecycle-1234abcd'] * 3]:
            with self.subTest(projects=projects), self.assertRaises(ValueError):
                prepare(self.config('lifecycle-loss-migration', projects=projects))
        config = self.config('lifecycle-loss-migration', projects=['antnest-lifecycle-1234abc' + str(i) for i in range(3)])
        result = verify(prepare(config), call=self.call)
        self.assertEqual(len(result['resources']), 18)

    def test_explicit_project_family_cannot_be_replaced_with_unrelated_resources(self):
        for name, count in [('controller-workflow-span', 3), ('lifecycle-loss-migration', 3), ('lifecycle-restore-migration', 2)]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'project family'):
                prepare(self.config(name, projects=['antnest-unrelated-' + str(i) for i in range(count)]))

    def test_global_schema_inspects_actual_inventory_and_required_log_order(self):
        traces = self.root / 'antnest-lifecycle-1234abc1' / 'traces'
        config = self.config('lifecycle-network-migration', trace_directory=str(traces))
        traces.mkdir(parents=True)
        for i in range(20):
            (traces / f'{i}.json').write_text(json.dumps({'traceID': str(i), 'spans': []}))
        for index, name in enumerate(PROFILES[config['profile']]['required_logs']):
            (self.inputs / name).write_text(f'Disposable foundation project: antnest-lifecycle-1234abc{index}')
        result = verify(prepare(config), call=self.call)
        self.assertIn(('docker', 'ps', '-aq'), self.calls)
        self.assertEqual(result['network_raw_traces'], 20)
        self.assertEqual(result['projects_cleaned'], ['antnest-lifecycle-1234abc' + str(i) for i in range(3)])

    def test_trace_directory_must_match_the_original_log_selection(self):
        for name, count in [('lifecycle-network-migration', 20), ('lifecycle-shutdown-migration', 6)]:
            traces = self.root / name / 'antnest-lifecycle-ffffffff' / 'traces'
            traces.mkdir(parents=True)
            config = self.config(name, trace_directory=str(traces))
            for index, filename in enumerate(PROFILES[name]['required_logs']):
                (self.inputs / filename).write_text(f'Disposable foundation project: antnest-lifecycle-1234abc{index}')
            for index in range(count):
                (traces / f'{index}.json').write_text(json.dumps({'traceID': str(index), 'spans': []}))
            with self.subTest(profile=name), self.assertRaisesRegex(ValueError, 'trace project'):
                prepare(config)

    def test_inspect_image_identity_and_temporary_image_residue(self):
        config = self.config('runtime-inspect-absence', candidate_reference='antnest/runtime-controller:candidate', candidate_image=self.row['Image'])
        for name in ['loss.log', 'foundation.log']:
            (self.inputs / name).write_text('Disposable foundation project: antnest-lifecycle-1234abcd')
        self.put('service-cleanup.json', {'project': 'antnest-service-test'})
        self.put('local-image-before.json', {'runtime_controller': self.row['Image']})
        prepared = prepare(config)
        self.overrides[('docker', 'image', 'ls', '-q', '--filter', 'reference=antnest-image-reference-test-*')] = 'image-left'
        with self.assertRaisesRegex(AssertionError, 'temporary image'):
            verify(prepared, call=self.call)
        self.overrides.clear()
        self.overrides[('docker', 'image', 'inspect', '--format', '{{.Id}}', config['candidate_reference'])] = 'sha256:' + 'b' * 64
        with self.assertRaisesRegex(AssertionError, 'candidate image'):
            verify(prepared, call=self.call)

    def test_final_drift_report_is_written_before_failure(self):
        config = self.config('timeout-failure-followup')
        self.put('resource-baseline.json', {'containers': [], 'volumes': [], 'networks': []})
        self.put('images-candidate.json', [{'reference': 'antnest/test:candidate', 'id': self.row['Image']}])
        prepared = prepare(config)
        self.row['RestartCount'] += 1
        self.overrides[('docker', 'volume', 'ls', '-q')] = 'new-volume'
        with self.assertRaisesRegex(AssertionError, 'drift'):
            verify(prepared, call=self.call)
        result = json.loads((self.root / 'output' / 'final-environment.json').read_text())
        self.assertEqual(result['resource_delta']['volumes']['added'], ['new-volume'])
        self.assertEqual(result['retained_changes'][0]['field'], 'RestartCount')
        self.assertTrue((self.root / 'output' / 'retained-final.json').exists())

    def test_existing_report_is_not_overwritten(self):
        config = self.config()
        verify(prepare(config), call=self.call)
        with self.assertRaisesRegex(ValueError, 'exists'):
            prepare(config)

    def test_cache_alias_leaf_and_bad_baseline_rejected_before_output_creation(self):
        config = self.config()
        cache = self.root / '.cache'
        cache.mkdir()
        (cache / 'source').write_text('anything')
        (self.inputs / 'docker.log').symlink_to(cache / 'source')
        with self.assertRaisesRegex(ValueError, 'cache'):
            prepare(config)
        (self.inputs / 'docker.log').unlink()
        self.put('retained-before.json', [])
        with self.assertRaisesRegex(ValueError, 'baseline'):
            prepare(config)
        self.assertFalse((self.root / 'output').exists())

    def test_cli_rejects_unknown_profile_before_docker_or_output(self):
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.config('identity-migration') | {'profile': 'typo'}))
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('cleanup.py')), '--config', str(config)], text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unknown cleanup profile', result.stderr)
        self.assertFalse((self.root / 'output').exists())


if __name__ == '__main__':
    unittest.main()
