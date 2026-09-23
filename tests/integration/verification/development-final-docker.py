#!/usr/bin/env python3
"""Final Trace grouping and idle-restart CLI checks on disposable Docker fixtures."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/verification'))
from cleanup import command, write_report
from configuration import durable_path

spec = importlib.util.spec_from_file_location('cleanup_docker', Path(__file__).with_name('cleanup-docker.py'))
inventory_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory_module)


def final_fixture(folder, profile, controller, *, old_publication=False):
    folder.mkdir(parents=True)
    output = folder / 'evidence'
    output.mkdir()
    start = int(datetime.datetime.fromisoformat(controller['State']['StartedAt'].replace('Z', '+00:00')).timestamp() * 1e6)
    agent = 'agent_' + uuid.uuid4().hex
    config = dict(output=str(output), lifecycle_trace_glob='lifecycle-*.json', publication_trace_glob='renamed-publication-*.json',
                  summary_path=str(output / 'summary.json'))
    def saved(name, value):
        write_report(output, name, value)
        return str(output / name)
    lifecycle, publications = [], []
    for index, kind in enumerate(['create', 'disable', 'enable', 'rebuild', 'delete']):
        trace_id = uuid.uuid4().hex
        evidence = dict(kind=kind, trace_id=trace_id, agent_id=agent, request_id='request-' + kind,
                        strict_trace='failed' if index == 0 else 'passed', platform_absence_probes=[2, 1, 0, 2, 0][index])
        lifecycle.append(dict(kind=kind, traceID=trace_id, agentId=agent, requestId='request-' + kind, evidence=evidence))
        saved('lifecycle-' + kind + '.json', dict(traceID=trace_id, spans=[dict(spanID='1', startTime=start+1000)]))
    for index in range(3):
        trace_id = uuid.uuid4().hex
        publications.append(dict(trace_id=trace_id, strict_trace='passed'))
        saved('renamed-publication-' + str(index) + '.json', dict(traceID=trace_id, spans=[dict(spanID='1', startTime=start-1000 if old_publication and index == 0 else start+1000)]))
    config['lifecycle_report_path'] = saved('lifecycle-report.json', dict(status='passed', lifecycle=lifecycle, publication=publications, source_absence_404=1))
    trace_id = uuid.uuid4().hex
    config['replay_report_path'] = saved('replay-report.json', dict(history_exact=True, new_runs=0, new_tools=0, durable_messages=5, notifications=5,
                                                                trace=dict(trace_id=trace_id, strict_trace='passed', error_spans=0)))
    config['replay_trace_path'] = saved('replay-trace.json', dict(traceID=trace_id, spans=[dict(spanID='1', startTime=start+1000)]))
    config['temporary_agent_path'] = saved('temporary-agent.json', dict(agent_id=agent))
    config['agent_before_path'] = saved('agent-before.json', dict(agent_id=agent, checked_at='before'))
    config['agent_final_path'] = saved('agent-final.json', dict(agent_id=agent, checked_at='after'))
    config['after_snapshot_path'] = saved('after.json', dict(runtime_controller_image=controller['Image']))
    if profile == 'runtime':
        config['runtime_controller_container'] = controller['Name'].lstrip('/')
    else:
        config['agent_controller_container'] = controller['Name'].lstrip('/')
        config['compose_snapshot_path'] = saved('compose.json', {'services': {'agent-controller': {'depends_on': {'temporal': {'condition': 'service_healthy'}}}}})
    write_report(folder, 'config.json', config)
    return folder / 'config.json'


def run_entry(entry, config, folder):
    with (folder / 'execution.log').open('x') as log:
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'tests/e2e/development' / entry), '--config', str(config)],
                                stdout=log, stderr=subprocess.STDOUT, timeout=120)
    return result.returncode


def run(output, image_reference):
    os.umask(0o077)
    image = command('docker', 'image', 'inspect', '--format', '{{.Id}}', image_reference)
    before = inventory_module.inventory()
    write_report(output, 'environment-before.json', before)
    scope = 'antnest-development-' + uuid.uuid4().hex[:12]
    names, results, cancelled = [], [], None
    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = signum
    handlers = {sig: signal.signal(sig, cancel) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        for service in ['runtime-controller', 'agent-controller']:
            name = scope + '-' + service + '-1'
            names.append(name)
            command('docker', 'run', '-d', '--name', name, '--network', 'none', '--label', 'io.antnest.runtime-controller-scope=' + scope,
                    '--health-cmd', 'exit 0', '--health-interval', '1s', '--health-timeout', '1s', image, 'sh', '-c',
                    'trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            rows = json.loads(command('docker', 'inspect', *names))
            if all(row['State'].get('Health', {}).get('Status') == 'healthy' for row in rows):
                break
            if cancelled:
                raise InterruptedError(cancelled)
            time.sleep(0.2)
        else:
            raise AssertionError('fixture health deadline')
        folder = output / 'idle-restart'
        write_report(folder, 'config.json', dict(output=str(folder / 'result'), controller_container=names[1]))
        code = run_entry('idle-restart.py', folder / 'config.json', folder)
        assert code == 0, 'idle restart fixture failed'
        result = json.loads((folder / 'result/idle-restart.json').read_text())
        assert result['same_container'] and result['exit_code'] == 0 and result['healthy']
        results.append(dict(profile='idle-restart', exit_code=code, same_container=True, normal_exit=True))
        rows = json.loads(command('docker', 'inspect', *names))
        for profile, controller in zip(['runtime', 'temporal'], rows):
            if cancelled:
                raise InterruptedError(cancelled)
            folder = output / (profile + '-final')
            config = final_fixture(folder, profile, controller)
            code = run_entry(profile + '-final-checks.py', config, folder)
            assert code == 0, profile + ' final fixture failed'
            result = json.loads((folder / 'evidence/summary.json').read_text())
            assert result['trace_topologies'] == 9 and result['strict_failed'] == 1
            results.append(dict(profile=profile + '-final', exit_code=code, trace_topologies=9, strict_failed=1))
        folder = output / 'publication-cutoff-negative'
        config = final_fixture(folder, 'runtime', rows[0], old_publication=True)
        code = run_entry('runtime-final-checks.py', config, folder)
        assert code != 0 and 'publication predates latest restart' in (folder / 'execution.log').read_text()
        assert not (folder / 'evidence/summary.json').exists()
        results.append(dict(profile='publication-cutoff-negative', exit_code=code, expected_failure=True))
    finally:
        try:
            for name in reversed(names):
                command('docker', 'rm', '-fv', name)
            after = inventory_module.inventory()
            write_report(output, 'environment-after.json', after)
            assert before == after, 'retained environment changed'
            write_report(output, 'isolation.json', dict(unchanged=True, resource_counts={key: len(value) for key, value in after['resources'].items()}))
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    if cancelled:
        raise InterruptedError(cancelled)
    result = dict(status='passed', checks=results, scope='Actual read-only Docker/ps checks and normal idle restart of owned fixtures; synthetic business/Trace reports, no retained deployment or restart.')
    write_report(output, 'result.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=durable_path)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output, args.image)))
