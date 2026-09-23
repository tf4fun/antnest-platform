"""The distinct, preserved contracts of historical cleanup verification."""
from copy import deepcopy
import json
import os
import re
from configuration import durable_path


def read_json(path):
    return json.loads(durable_path(path).read_text())


def retained_snapshot(rows, schema):
    values = []
    for row in rows:
        if schema.startswith('lower'):
            value = {'id': row['Id'], 'name': row['Name'] if schema.startswith('lower6') else row['Name'].lstrip('/'),
                     'image': row['Image'], 'health': row['State'].get('Health', {}).get('Status')}
            if not schema.startswith('lower4'):
                value['running'] = row['State']['Running']
            if schema.startswith('lower6'):
                value['mounts'] = deepcopy(row['Mounts'])
        else:
            value = {key: deepcopy(row[key]) for key in ['Id', 'Name', 'Image', 'RestartCount', 'Mounts']} | {
                'StartedAt': row['State']['StartedAt'], 'Running': row['State']['Running'],
                'Health': row['State'].get('Health', {}).get('Status'), 'Networks': sorted(row['NetworkSettings']['Networks'])}
        values.append(value)
    return values


def normalized_snapshot(rows, schema):
    values = deepcopy(rows)
    if schema.startswith('lower6') or schema in ['upper9-selected', 'upper9-final-normalized']:
        key = 'mounts' if schema.startswith('lower') else 'Mounts'
        for row in values:
            if key not in row:
                continue
            row[key].sort(key=(lambda mount: (mount.get('Destination', ''), mount.get('Type', ''), mount.get('Source', '')))
                          if schema == 'upper9-final-normalized' else (lambda mount: mount['Destination']))
    if schema in ['lower4-sorted', 'lower5-sorted', 'lower6-all']:
        values.sort(key=lambda row: row['id'])
    return values


def check_retained(before, rows, schema, *, check=True):
    after = retained_snapshot(rows, schema)
    old, current = normalized_snapshot(before, schema), normalized_snapshot(after, schema)
    changes = []
    if len(old) != len(current):
        changes.append({'field': 'container_count', 'before': len(old), 'after': len(current)})
    for index, (previous, present) in enumerate(zip(old, current)):
        keys = previous if schema.startswith('upper9-final') else set(previous) | set(present)
        for key in keys:
            if key not in previous or key not in present or previous[key] != present[key]:
                report_old = before[index] if schema == 'upper9-final-normalized' else previous
                report_new = after[index] if schema == 'upper9-final-normalized' else present
                changes.append({'name': previous.get('Name', previous.get('name')), 'field': key,
                                'before': report_old.get(key), 'after': report_new.get(key)})
    if check:
        assert not changes, 'retained containers changed'
        assert_retained_state(rows, schema)
    return after, changes


def assert_retained_state(rows, schema):
    if schema.startswith('lower4'):
        assert all(row['State']['Running'] for row in rows), 'retained container is not running'
    if schema == 'upper9-final-raw':
        assert all(row['State']['Running'] and row['State'].get('Health', {}).get('Status') in [None, 'healthy']
                   for row in rows), 'unhealthy retained container'


BASE_MARKERS = ['run-profile.py', 'scripts/workspace-closeout/run.mjs', 'scripts/lifecycle-closeout/run.mjs',
                'scripts/workspace-closeout/browser-run.mjs', 'scripts/workspace-closeout/c4-run.mjs',
                'playwright_chromiumdev_profile', 'node --test --test-concurrency=1']
PROCESS_MARKERS = {
    'B': BASE_MARKERS,
    'T': BASE_MARKERS + ['scripts/e2e-stage3a.sh', 'scripts/e2e-stage3-base.sh'],
    'K': BASE_MARKERS + ['scripts/lifecycle-closeout/crash-run.mjs'],
    'WBrowser': ['run-profile.py', 'scripts/workspace-closeout/browser-run.mjs', 'scripts/workspace-closeout/c4-run.mjs',
                 'playwright_chromiumdev_profile', 'node --test --test-concurrency=1'],
    'I': ['run-profile.py', 'scripts/lifecycle-closeout/interrupted-run.mjs', 'node --test --test-concurrency=1'],
    'WProtocol': ['run-profile.py', 'scripts/workspace-closeout/run.mjs', 'node --test --test-concurrency=1'],
    'R': ['run-profile.py', 'run-command.py', 'scripts/lifecycle-closeout/run.mjs', 'node --test --test-concurrency=1'],
    'RI': ['run-profile.py', 'run-command.py', 'run-service.py', 'scripts/lifecycle-closeout/run.mjs', 'node --test --test-concurrency=1'],
    'N': ['node scripts/lifecycle-closeout/run.mjs', 'node --test --test-concurrency=1',
          'node scripts/lifecycle-closeout/network-model.mjs', 'node scripts/lifecycle-closeout/network-target.mjs'],
    'H': ['node scripts/lifecycle-closeout/run.mjs', 'node --test --test-concurrency=1', 'node scripts/lifecycle-closeout/network-model.mjs'],
    'G': ['run-command.py', 'postgres-gate.py', '/control.test', 'ANTNEST_RUNTIME_CRASH_JOB='],
}
RUNNER_NAMES = {
    'run-profile.py': ['tests/support/run-command.mjs', 'tests/support/run-suite.mjs'],
    'run-command.py': ['tests/support/run-command.mjs', 'tests/support/run-suite.mjs'],
    'run-service.py': ['tests/support/dependencies.mjs', 'tests/support/verification/go-service.mjs'],
    'postgres-gate.py': ['tests/support/dependencies.mjs'],
}


def process_violations(profile, text, *, current_pid=None, legacy_mode='', legacy_prefix=''):
    if profile is None:
        return []
    current_pid = os.getpid() if current_pid is None else current_pid
    rows = []
    for line in text.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3:
            rows.append((int(fields[0]), int(fields[1]), line))
    parents = {pid: parent for pid, parent, _ in rows}
    ancestors = set()
    while current_pid not in ancestors:
        ancestors.add(current_pid)
        if current_pid not in parents:
            break
        current_pid = parents[current_pid]
    matches = []
    markers = PROCESS_MARKERS.get(profile, [])
    markers = markers + [marker.replace('scripts/', 'tests/e2e/') for marker in markers if 'scripts/' in marker]
    markers += [replacement for old in markers for replacement in RUNNER_NAMES.get(old, [])]
    for pid, _, line in rows:
        if pid in ancestors:
            continue
        if profile == 'Legacy':
            old = rf'(?:^|\s)(?:\S*/)?(?:sh|bash|zsh) (?:\S*/)?scripts/e2e-|run-profile\.py {legacy_mode} {legacy_prefix}'
            modern = old.replace('scripts/', 'tests/e2e/')
            matched = bool(re.search(old, line) or re.search(modern, line)) or (
                'tests/support/run-command.mjs' in line and re.search(legacy_mode, line) and re.search(legacy_prefix, line))
        else:
            matched = any(marker in line for marker in markers)
            if profile in ['R', 'RI']:
                matched = matched and bool(re.search(r'(?:node|python3(?:\.\d+)?|make) ', line))
            elif 'zsh -lc' in line or (profile == 'N' and 'python3 - <<' in line):
                matched = False
        if matched:
            matches.append(line)
    return matches


def trace_summary(paths, profile):
    paths = list(paths)
    if profile in ['network', 'shutdown']:
        assert len(paths) == {'network': 20, 'shutdown': 6}[profile], 'unexpected raw trace count'
    missing = errors = warning_traces = 0
    for path in paths:
        trace = read_json(path)
        ids = {span['spanID'] for span in trace['spans']}
        for span in trace['spans']:
            for reference in span.get('references') or []:
                if reference['refType'] == 'CHILD_OF':
                    missing += int(reference['traceID'] != trace['traceID'] or reference['spanID'] not in ids)
            if profile != 'temporal':
                tags = {tag['key']: tag['value'] for tag in span.get('tags') or []}
                errors += int(tags.get('error') is True or tags.get('otel.status_code') == 'ERROR')
        warnings = (trace.get('warnings') or []) + [warning for span in trace['spans'] for warning in span.get('warnings') or []]
        for warning in warnings:
            if warning.startswith('clock skew adjustment disabled'):
                continue
            match = re.fullmatch(r'parent span ID=([a-f0-9]+) is not in the trace; skipping clock skew adjustment', warning)
            assert profile != 'network' and match and match[1] in ids, 'unreviewed warning or actual missing parent'
        warning_traces += bool(warnings)
    assert missing == 0, 'missing parent edges'
    if profile == 'network':
        assert errors == 0, 'network error spans'
    return {'traces': len(paths), 'missing': missing, 'errors': errors, 'warning_traces': warning_traces}


def foundation_project(path):
    text = durable_path(path).read_text()
    return next(line.split(': ')[1] for line in text.splitlines() if line.startswith('Disposable foundation project:'))


def temporal_results(root, trace_roots):
    runs = []
    for name, kind in [('shutdown-1.log', 'shutdown'), ('shutdown-2.log', 'shutdown'), ('foundation.log', 'foundation')]:
        log = durable_path(root / name)
        project = foundation_project(log)
        result = next(json.loads(line) for line in log.read_text().splitlines() if line.startswith('{'))
        assert result['status'] == 'business_and_topology_passed'
        checks = result['traces'] + result.get('request_traces', []) + result.get('watch_traces', []) + result.get('active_run_rebuild', {}).get('run_traces', [])
        assert all(check.get('topology', 'passed') == 'passed' and check.get('trace_id') and not check.get('error') for check in checks)
        paths = list(durable_path(trace_roots[kind] / project / 'traces').glob('*.json'))
        summary = trace_summary(paths, 'temporal')
        runs.append({'project': project, 'kind': kind, 'status': result['status'], 'operations': result['operations'],
                     'topologies': len(checks), 'raw_traces': summary['traces'], 'missing_parent_edges': summary['missing'],
                     'strict_exit': result['strict_exit'], 'strict_failed': sum(check['strict_trace'] == 'failed' for check in checks),
                     'warning_traces': sum(bool(check.get('warning_count')) for check in checks),
                     'error_spans': sum(check.get('error_spans', 0) for check in checks), 'cleanup': 'verified'})
    for line in durable_path(root / 'http-errors.private.jsonl').read_text().splitlines():
        assert json.loads(line)['method'] == 'GET', 'mutation transport error'
    return runs
