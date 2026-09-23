"""Historical cleanup checks retain distinct baseline and Trace contracts."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from cleanup_contracts import check_retained, process_violations, trace_summary, temporal_results


def container(name='one', running=True):
    return {'Id': name, 'Name': '/' + name, 'Image': 'sha256:' + 'a' * 64,
            'RestartCount': 0, 'Mounts': [
                {'Destination': '/z', 'Type': 'volume', 'Source': '/data/z', 'Name': 'z', 'RW': True, 'Mode': 'rw'},
                {'Destination': '/a', 'Type': 'volume', 'Source': '/data/a', 'Name': 'a', 'RW': False, 'Mode': 'ro'}],
            'State': {'Running': running, 'StartedAt': 'start', 'Health': {'Status': 'healthy' if running else 'unhealthy'}},
            'NetworkSettings': {'Networks': {'second': {}, 'first': {}}}}


def baseline(row, schema):
    if schema.startswith('lower'):
        result = {'id': row['Id'], 'name': row['Name'] if 'lower6' in schema else row['Name'].lstrip('/'),
                  'image': row['Image'], 'health': row['State']['Health']['Status']}
        if not schema.startswith('lower4'):
            result['running'] = row['State']['Running']
        if schema.startswith('lower6'):
            result['mounts'] = deepcopy(row['Mounts'])
        return result
    return {key: deepcopy(row[key]) for key in ['Id', 'Name', 'Image', 'RestartCount', 'Mounts']} | {
        'StartedAt': row['State']['StartedAt'], 'Running': row['State']['Running'],
        'Health': row['State']['Health']['Status'], 'Networks': sorted(row['NetworkSettings']['Networks'])}


class RetainedContractTests(unittest.TestCase):
    def test_missing_null_field_is_not_equal_to_present_null(self):
        row = container()
        del row['State']['Health']
        old = {'id': row['Id'], 'name': row['Name'].lstrip('/'), 'image': row['Image']}
        with self.assertRaises(AssertionError):
            check_retained([old], [row], 'lower4-sorted')

    def test_final_mount_drift_preserves_raw_report_order(self):
        row = container()
        old = baseline(row, 'upper9-final-normalized')
        row['Mounts'][0]['Source'] = '/changed'
        _, changes = check_retained([old], [row], 'upper9-final-normalized', check=False)
        self.assertEqual(changes[0]['before'], old['Mounts'])
        self.assertEqual(changes[0]['after'], row['Mounts'])

    def test_identity_sorts_ids_but_legacy_retains_inspection_order(self):
        rows = [container('one'), container('two')]
        old = [baseline(row, 'lower4-sorted') for row in rows]
        self.assertEqual(check_retained(old, list(reversed(rows)), 'lower4-sorted')[1], [])
        with self.assertRaisesRegex(AssertionError, 'retained'):
            check_retained(old, list(reversed(rows)), 'lower4-ordered')

    def test_running_is_required_only_for_the_original_running_profiles(self):
        row = container(running=False)
        for schema in ['lower5-sorted', 'lower6-selected', 'lower6-all', 'upper9-selected', 'upper9-final-normalized']:
            with self.subTest(schema=schema):
                self.assertEqual(check_retained([baseline(row, schema)], [row], schema)[1], [])
        for schema in ['lower4-sorted', 'lower4-ordered', 'upper9-final-raw']:
            with self.subTest(schema=schema), self.assertRaisesRegex(AssertionError, 'running|unhealthy'):
                check_retained([baseline(row, schema)], [row], schema)

    def test_mount_order_rules_do_not_discard_mount_fields(self):
        row = container()
        changed_order = deepcopy(row)
        changed_order['Mounts'].reverse()
        for schema in ['lower6-selected', 'lower6-all', 'upper9-selected', 'upper9-final-normalized']:
            old = [baseline(row, schema)]
            self.assertEqual(check_retained(old, [changed_order], schema)[1], [])
            for field, value in [('RW', False), ('Mode', 'changed'), ('Name', 'changed'), ('Source', '/changed')]:
                changed = deepcopy(row)
                changed['Mounts'][0][field] = value
                with self.subTest(schema=schema, field=field), self.assertRaises(AssertionError):
                    check_retained(old, [changed], schema)
        with self.assertRaises(AssertionError):
            check_retained([baseline(row, 'upper9-final-raw')], [changed_order], 'upper9-final-raw')

    def test_restart_networks_image_and_health_are_not_lost_in_upper_snapshots(self):
        row = container()
        for key, value in [('RestartCount', 1), ('Image', 'other')]:
            changed = deepcopy(row)
            changed[key] = value
            with self.assertRaises(AssertionError):
                check_retained([baseline(row, 'upper9-selected')], [changed], 'upper9-selected')
        for state in [{'StartedAt': 'changed'}, {'Health': {'Status': 'unhealthy'}}, {'Running': False}]:
            changed = deepcopy(row)
            changed['State'].update(state)
            with self.assertRaises(AssertionError):
                check_retained([baseline(row, 'upper9-selected')], [changed], 'upper9-selected')
        changed = deepcopy(row)
        changed['NetworkSettings']['Networks']['extra'] = {}
        with self.assertRaises(AssertionError):
            check_retained([baseline(row, 'upper9-selected')], [changed], 'upper9-selected')

    def test_missing_or_added_containers_fail_and_global_drift_remains_reportable(self):
        row = container()
        for rows in [[], [row, container('extra')]]:
            with self.assertRaises(AssertionError):
                check_retained([baseline(row, 'lower6-all')], rows, 'lower6-all')
        changed = deepcopy(row)
        changed['RestartCount'] = 1
        after, changes = check_retained([baseline(row, 'upper9-final-raw')], [changed], 'upper9-final-raw', check=False)
        self.assertEqual(after[0]['RestartCount'], 1)
        self.assertEqual(changes[0]['field'], 'RestartCount')


class ProcessContractTests(unittest.TestCase):
    def test_current_and_legacy_entry_names_remain_visible(self):
        for marker in ['node scripts/workspace-closeout/run.mjs', 'node tests/e2e/workspace-closeout/run.mjs',
                       'node tests/support/run-command.mjs --name other -- make example', 'node --test --test-concurrency=1 probe']:
            self.assertEqual(len(process_violations('B', f'10 1 {marker}', current_pid=99)), 1)
        for marker in ['sh scripts/e2e-stage3a.sh', 'sh tests/e2e/e2e-stage3a.sh']:
            self.assertEqual(len(process_violations('Legacy', f'10 1 {marker}', current_pid=99,
                                                     legacy_mode='e2e-stage3-local', legacy_prefix='base-docker-')), 1)

    def test_checker_and_its_real_ancestors_do_not_count_as_lingering_children(self):
        text = '99 98 python3 cleanup.py\n98 1 node tests/support/run-command.mjs --name check\n100 98 node tests/support/run-command.mjs --name other'
        found = process_violations('R', text, current_pid=99)
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].startswith('100 '))

    def test_profile_specific_markers_and_original_exclusions_remain_distinct(self):
        line = '10 1 node tests/e2e/lifecycle-closeout/network-target.mjs'
        self.assertTrue(process_violations('N', line, current_pid=99))
        self.assertFalse(process_violations('H', line, current_pid=99))
        self.assertFalse(process_violations('B', '10 1 zsh -lc node --test --test-concurrency=1', current_pid=99))
        self.assertTrue(process_violations('G', '10 1 /tmp/control.test', current_pid=99))


class TraceContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='antnest-cleanup-traces-')
        self.root = Path(self.temporary.name)
        self.trace = {'traceID': 'trace', 'spans': [
            {'spanID': 'aa', 'tags': [], 'references': []},
            {'spanID': 'bb', 'tags': [], 'references': [{'refType': 'CHILD_OF', 'traceID': 'trace', 'spanID': 'aa'}]}]}

    def tearDown(self):
        self.temporary.cleanup()

    def paths(self, count):
        paths = []
        for i in range(count):
            path = self.root / f'{i}.json'
            path.write_text(json.dumps(self.trace))
            paths.append(path)
        return paths

    def test_network_requires_twenty_traces_zero_errors_and_only_clock_warnings(self):
        with self.assertRaises(AssertionError):
            trace_summary(self.paths(19), 'network')
        self.trace['warnings'] = ['clock skew adjustment disabled; retained']
        self.assertEqual(trace_summary(self.paths(20), 'network')['warning_traces'], 20)
        self.trace['spans'][0]['tags'] = [{'key': 'error', 'value': True}]
        with self.assertRaises(AssertionError):
            trace_summary(self.paths(20), 'network')
        self.trace['spans'][0]['tags'] = [{'key': 'error', 'value': 'true'}]
        self.assertEqual(trace_summary(self.paths(20), 'network')['errors'], 0)
        self.trace['warnings'] = ['parent span ID=aa is not in the trace; skipping clock skew adjustment']
        with self.assertRaises(AssertionError):
            trace_summary(self.paths(20), 'network')

    def test_shutdown_counts_errors_and_accepts_only_actually_present_parent_warning(self):
        self.trace['spans'][0]['tags'] = [{'key': 'otel.status_code', 'value': 'ERROR'}]
        self.trace['warnings'] = ['parent span ID=aa is not in the trace; skipping clock skew adjustment']
        summary = trace_summary(self.paths(6), 'shutdown')
        self.assertEqual(summary['errors'], 6)
        self.assertEqual(summary['missing'], 0)
        self.trace['warnings'] = ['parent span ID=cc is not in the trace; skipping clock skew adjustment']
        with self.assertRaises(AssertionError):
            trace_summary(self.paths(6), 'shutdown')

    def test_foreign_and_missing_parents_fail_every_trace_profile(self):
        for key, value in [('traceID', 'foreign'), ('spanID', 'missing')]:
            original = deepcopy(self.trace)
            self.trace['spans'][1]['references'][0][key] = value
            for profile, count in [('network', 20), ('shutdown', 6), ('temporal', 1)]:
                with self.subTest(profile=profile, field=key), self.assertRaises(AssertionError):
                    trace_summary(self.paths(count), profile)
            self.trace = original

    def test_temporal_preserves_its_log_groups_error_counts_strict_failures_and_get_rule(self):
        roots = {kind: self.root / kind for kind in ['shutdown', 'foundation']}
        result = {'status': 'business_and_topology_passed', 'operations': 5, 'strict_exit': 2,
                  'traces': [{'trace_id': 'one', 'strict_trace': 'failed', 'error_spans': 7, 'warning_count': 1}],
                  'active_run_rebuild': {'run_traces': [{'trace_id': 'two', 'strict_trace': 'failed', 'error_spans': 0}]}}
        for name, kind in [('shutdown-1.log', 'shutdown'), ('shutdown-2.log', 'shutdown'), ('foundation.log', 'foundation')]:
            project = name.replace('.log', '')
            (roots[kind] / project / 'traces').mkdir(parents=True)
            (self.root / name).write_text(f'Disposable foundation project: {project}\n' + json.dumps(result) + '\n')
        (self.root / 'http-errors.private.jsonl').write_text('{"method":"GET"}\n')
        rows = temporal_results(self.root, roots)
        self.assertEqual([r['raw_traces'] for r in rows], [0, 0, 0])
        self.assertEqual([r['error_spans'] for r in rows], [7, 7, 7])
        self.assertEqual([r['strict_failed'] for r in rows], [2, 2, 2])
        self.assertEqual([r['topologies'] for r in rows], [2, 2, 2])
        (self.root / 'http-errors.private.jsonl').write_text('{"method":"POST"}\n')
        with self.assertRaisesRegex(AssertionError, 'mutation'):
            temporal_results(self.root, roots)
        (self.root / 'http-errors.private.jsonl').write_text('{"method":"GET"}\n')
        result['traces'][0]['error'] = 'failure'
        (self.root / 'shutdown-1.log').write_text('Disposable foundation project: shutdown-1\n' + json.dumps(result))
        with self.assertRaises(AssertionError):
            temporal_results(self.root, roots)

    def test_resolved_trace_file_aliases_cannot_read_cache(self):
        path = self.root / 'alias.json'
        path.symlink_to(Path(__file__).resolve().parents[3] / '.cache', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'cache'):
            trace_summary([path], 'temporal')


if __name__ == '__main__':
    unittest.main()
