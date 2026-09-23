"""Opt-in replay of migrated offline summarizers against saved historical reports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SUPPORT = Path(__file__).resolve().parents[1] / 'verification'
sys.path.insert(0, str(SUPPORT))
from configuration import durable_path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-root', required=True, type=durable_path)
parser.add_argument('--output', required=True, type=durable_path)
args = parser.parse_args()
os.umask(0o077)
args.output.mkdir(parents=True, exist_ok=True)


def run(name, tool, *argv):
    folder = durable_path(args.output / name)
    folder.mkdir(mode=0o700)
    with (folder / 'execution.log').open('x') as log:
        subprocess.run([sys.executable, '-B', str(SUPPORT / tool), *map(str, argv)],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    return folder


def read(path):
    return json.loads(durable_path(path).read_text())


def normalize(value):
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if not isinstance(value, dict):
        return value
    result = {k: normalize(v) for k, v in value.items()}
    if 'errors' in result:
        result['errors'] = sorted(result['errors'], key=lambda row: json.dumps(row))
    if 'path' in result:
        path = result['path']
        if path.startswith('.cache/'):
            result['path'] = path.removeprefix('.cache/')
        elif path.startswith(str(SUPPORT.parents[2] / '.cache') + '/'):
            result['path'] = path.removeprefix(str(SUPPORT.parents[2] / '.cache') + '/')
        elif path.startswith(str(args.evidence_root) + '/'):
            result['path'] = path.removeprefix(str(args.evidence_root) + '/')
    return result


checks = []
historical_hash_differences = []
for batch in ['acceptance-retirement', 'browser-finish-retirement',
              'interruption-assets-retirement', 'recovery-support-split',
              'runtime-crash-integration', 'workspace-browser-migration',
              'workspace-protocol-migration']:
    date = '20260922' if batch == 'runtime-crash-integration' else '20260921'
    expected = read(args.evidence_root / f'{batch}-{date}' / 'summary.json')
    projects = []
    for row in expected:
        matches = list(args.evidence_root.glob('*/' + row['project']))
        assert len(matches) == 1, (batch, row['project'], 'ambiguous project evidence')
        projects.append(durable_path(matches[0]))
    folder = args.output / batch
    run(batch, 'summarize-evidence.py', '--output', folder, *projects)
    assert normalize(read(folder / 'summary.json')) == normalize(expected), batch
    checks.append({'batch': batch, 'projects': len(projects)})

cost = args.output / 'cost'
old_cost = args.evidence_root / 'legacy-acceptance-20260917'
run('cost', 'summarize-cost.py', '--input', old_cost / 'cost-docker-8.log',
    '--output', cost, '--status', 'business_passed')
for name in ['cost-result.json', 'cost-summary.json']:
    assert read(cost / name) == read(old_cost / name), name
checks.append({'batch': 'cost', 'reports': 2})

for batch in ['final-regression-20260922', 'timeout-failure-followup-20260922']:
    old = args.evidence_root / batch
    parsed = sorted(old.glob('*.parsed.json'))
    assert parsed, batch
    logs = [old / (p.name.removesuffix('.parsed.json') + '.log') for p in parsed]
    folder = args.output / batch
    run(batch, 'summarize-log.py', '--output', folder, *logs)
    for expected in parsed:
        actual, historical = read(folder / expected.name), read(expected)
        assert actual['objects'] == historical['objects'], expected.name
        log = old / (expected.name.removesuffix('.parsed.json') + '.log')
        assert actual['log_sha256'] == hashlib.sha256(log.read_bytes()).hexdigest(), expected.name
        if actual['log_sha256'] != historical['log_sha256']:
            historical_hash_differences.append({'batch': batch, 'report': expected.name,
                'recorded_sha256': historical['log_sha256'], 'current_sha256': actual['log_sha256']})
    checks.append({'batch': batch, 'parsed_reports': len(parsed)})

audit = args.output / 'trace-audit' / 'trace-diagnostic-audit.json'
run('trace-audit', 'audit-traces.py', '--input', args.evidence_root / 'final-regression-20260922',
    '--evidence-root', args.evidence_root, '--output', audit,
    '--allow-unlisted-repeat', 'stage2-final')
assert normalize(read(audit)) == normalize(read(args.evidence_root / 'final-regression-20260922/trace-diagnostic-audit.json')), 'audit findings'
checks.append({'batch': 'trace-audit', 'reports': len(read(audit))})
report = {'status': 'passed', 'checks': checks, 'historical_log_hash_differences': historical_hash_differences,
          'scope': 'saved diagnostic field equivalence and current log hashes, not fresh business acceptance or validation of stale historical hashes'}
(args.output / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
