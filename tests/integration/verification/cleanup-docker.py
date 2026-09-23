#!/usr/bin/env python3
"""Exercise every cleanup CLI profile against Docker using one owned disposable container."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid

REPOSITORY = Path(__file__).resolve().parents[3]
SUPPORT = REPOSITORY / 'tests/support/verification'
sys.path.insert(0, str(SUPPORT))
from cleanup import command, RESOURCES, write_report
from cleanup_contracts import normalized_snapshot, retained_snapshot
from cleanup_profiles import PROFILES
from configuration import durable_path


def inventory():
    resources = {key: sorted(command('docker', *args, *(['--no-trunc'] if key != 'volumes' else [])).split()) for key, args in RESOURCES.items()}
    rows = json.loads(command('docker', 'inspect', *resources['containers'])) if resources['containers'] else []
    images = sorted(command('docker', 'image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}').splitlines())
    return dict(resources=resources, rows=normalized_snapshot(retained_snapshot(rows, 'upper9-final-normalized'), 'upper9-final-normalized'), images=images)


def fixtures(folder, name, profile, rows, resources, image, candidate):
    inputs = folder / 'input'
    inputs.mkdir(parents=True)
    config = dict(profile=name, input_root=str(inputs), output=str(folder / 'result'))
    write_report(inputs, profile['baseline'], retained_snapshot(rows, profile['schema']))
    projects = ['antnest-lifecycle-ff00000' + str(i) for i in range(1, 5)]
    if profile.get('project_glob'):
        filename = profile['project_glob'].replace('*', '1')
        (inputs / filename).write_text('Disposable foundation project: ' + projects[0] + '\nC4 disposable project: ' + projects[1]
                                       + '\nantnest-stage3-e2e-9999999999\nDisposable crash component scope: antnest-rc-crash-ff00112233445566\n')
    for index, filename in enumerate(profile['required_logs']):
        (inputs / filename).write_text('Disposable foundation project: ' + projects[index] + '\n')
    if profile.get('project_report'):
        write_report(inputs, profile['project_report'], {'project': 'antnest-cleanup-component-' + folder.name})
    if profile.get('required_projects'):
        config['projects'] = (['antnest-workflow-tests-9999999' + str(i) for i in range(3)] if name == 'controller-workflow-span'
                              else projects[:profile['required_projects']])
    if profile['trace'] in ['network', 'shutdown']:
        index = profile['required_logs'].index(profile['trace_project_log'])
        traces = folder / projects[index] / 'traces'
        traces.mkdir(parents=True)
        config['trace_directory'] = str(traces)
        for number in range(20 if profile['trace'] == 'network' else 6):
            write_report(traces, f'{number}.json', {'traceID': str(number), 'spans': [dict(spanID='1', references=[])]})
    if profile['trace'] == 'temporal':
        config['trace_roots'] = {kind: str(folder / kind) for kind in ['shutdown', 'foundation']}
        for index, (filename, kind) in enumerate([('shutdown-1.log', 'shutdown'), ('shutdown-2.log', 'shutdown'), ('foundation.log', 'foundation')]):
            result = dict(status='business_and_topology_passed', operations=['fixture'], strict_exit=2,
                          traces=[dict(trace_id=str(index), topology='passed', strict_trace='failed', warning_count=1, error_spans=1)])
            (inputs / filename).write_text('Disposable foundation project: ' + projects[index] + '\n' + json.dumps(result) + '\n')
            write_report(folder / kind / projects[index] / 'traces', 'one.json', {'traceID': str(index), 'spans': [dict(spanID='1', references=[])]})
        (inputs / 'http-errors.private.jsonl').write_text(json.dumps({'method': 'GET'}) + '\n')
    if name == 'runtime-inspect-absence':
        config.update(candidate_reference=candidate, candidate_image=image)
        write_report(inputs, 'local-image-before.json', {'runtime_controller': command('docker', 'image', 'inspect', '--format', '{{.Id}}', 'antnest/runtime-controller:local')})
    if profile['result'] == 'final':
        write_report(inputs, 'resource-baseline.json', resources)
        write_report(inputs, 'images-candidate.json', [{'reference': candidate, 'id': image}])
    write_report(folder, 'config.json', config)
    return folder / 'config.json'


def run(output, image_reference):
    # Resolve an installed image; this harness never pulls, retags or deploys retained services.
    image = command('docker', 'image', 'inspect', '--format', '{{.Id}}', image_reference)
    command('docker', 'image', 'inspect', '--format', '{{.Id}}', 'antnest/runtime-controller:local')
    before = inventory()
    write_report(output, 'environment-before.json', before)
    scope = 'antnest-cleanup-' + uuid.uuid4().hex[:12]
    created = False
    results = []
    cancelled = None

    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = signum

    handlers = {sig: signal.signal(sig, cancel) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        # Use the owned name for cleanup even if Docker's response is interrupted.
        created = True
        command('docker', 'run', '-d', '--name', scope, '--label', 'io.antnest.runtime-controller-scope=' + scope,
                '--network', 'none', image, 'sleep', '600')
        probe = json.loads(command('docker', 'inspect', scope))
        current = inventory()
        all_rows = json.loads(command('docker', 'inspect', *current['resources']['containers']))
        for name, profile in PROFILES.items():
            if cancelled:
                raise InterruptedError(f'cancelled by signal {cancelled}')
            rows = all_rows if profile['schema'] in ['lower6-all', 'upper9-final-normalized'] else probe
            folder = output / 'profiles' / name
            config = fixtures(folder, name, profile, rows, current['resources'], image, image_reference)
            with (folder / 'execution.log').open('x') as log:
                result = subprocess.run([sys.executable, '-B', str(SUPPORT / 'cleanup.py'), '--config', str(config)],
                                        stdout=log, stderr=subprocess.STDOUT, timeout=90)
            results.append(dict(profile=name, exit_code=result.returncode))
            assert result.returncode == 0, f'profile failed: {name}'
        # A real named/labelled leftover must fail; do not mutate the retained environment.
        folder = output / 'negative-residue'
        config = fixtures(folder, 'runtime-crash-recovery', PROFILES['runtime-crash-recovery'], probe, current['resources'], image, image_reference)
        report = folder / 'input' / 'postgres-cleanup.json'
        report.write_text(json.dumps({'project': scope}))
        with (folder / 'execution.log').open('x') as log:
            result = subprocess.run([sys.executable, '-B', str(SUPPORT / 'cleanup.py'), '--config', str(config)], stdout=log, stderr=subprocess.STDOUT, timeout=90)
        assert result.returncode != 0 and 'resources remain' in (folder / 'execution.log').read_text(), 'live leftover was not detected'
        assert not (folder / 'result' / 'cleanup.json').exists()
        results.append(dict(profile='negative-owned-container', exit_code=result.returncode, expected_failure=True))
    finally:
        try:
            if created:
                command('docker', 'rm', '-fv', scope)
            after = inventory()
            write_report(output, 'environment-after.json', after)
            assert before == after, 'environment changed after disposable cleanup'
            write_report(output, 'isolation.json', dict(unchanged=True, resource_counts={key: len(value) for key, value in after['resources'].items()}))
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    if cancelled:
        raise InterruptedError(f'cancelled by signal {cancelled}')
    report = dict(status='passed', checks=results, scope='All 29 CLI profiles with real read-only Docker inspection and ps; synthetic log/Trace fixtures. Historical real Trace equivalence is a separate replay.')
    write_report(output, 'result.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=durable_path)
    parser.add_argument('--image', required=True, help='Existing local image with sleep; no pull or tag operations')
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(run(args.output, args.image)))
