#!/usr/bin/env python3
"""Controller final-check CLI against owned PostgreSQL and workspace fixtures."""
import argparse
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
sys.path.insert(0, str(ROOT / 'tests/support/fixtures'))
from cleanup import command, write_report
from configuration import durable_path
from controller_final import controller_fixture

spec = importlib.util.spec_from_file_location('cleanup_docker', Path(__file__).with_name('cleanup-docker.py'))
inventory_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory_module)


def run(output, postgres_image, runtime_image):
    os.umask(0o077)
    pg_image = command('docker', 'image', 'inspect', '--format', '{{.Id}}', postgres_image)
    rt_image = command('docker', 'image', 'inspect', '--format', '{{.Id}}', runtime_image)
    before = inventory_module.inventory()
    write_report(output, 'environment-before.json', before)
    scope = 'antnest-controller-final-' + uuid.uuid4().hex[:12]
    agent, temporary = 'agent_' + uuid.uuid4().hex, 'agent_' + uuid.uuid4().hex
    postgres, runtime, volume = scope + '-postgres', 'antnest-runtime-' + agent, 'antnest-workspace-' + agent
    user, database = 'fixture_admin', 'fixture_acp'
    containers, volumes, results, cancelled = [], [], [], None
    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = signum
    handlers = {sig: signal.signal(sig, cancel) for sig in [signal.SIGINT, signal.SIGTERM]}
    def sql(query):
        return subprocess.check_output(['docker', 'exec', '-i', postgres, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database],
                                       input=query.encode(), timeout=30).decode().strip()
    def marker(value):
        subprocess.run(['docker', 'exec', '-i', runtime, 'sh', '-c', 'cat > /workspace/acceptance-note.txt'], input=value.encode(), check=True, timeout=30)
    def seed(session):
        sql("TRUNCATE acp_sessions,runs,tool_attempts,session_messages;"
            f"INSERT INTO acp_sessions VALUES ('{session}','{agent}','/workspace');"
            + ''.join(f"INSERT INTO runs VALUES ('run-{i}','{session}','completed','end_turn','quiescent');" for i in range(3))
            + "INSERT INTO tool_attempts VALUES ('run-1','write-ok','write','completed','settled'),('run-1','read-ok','read','completed','settled'),('run-2','reload-read','read','completed','settled');"
            + ''.join(f"INSERT INTO session_messages VALUES ('{session}','tool_call','" + json.dumps(dict(status='failed', toolCallId='rejected_' + str(i), content=[{'text':'Tool arguments do not match the declared schema: fixture'}])) + "'::jsonb);" for i in range(2)))
    try:
        containers.append(postgres)
        command('docker', 'run', '-d', '--name', postgres, '--network', 'none', '--label', 'io.antnest.runtime-controller-scope=' + scope,
                '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=' + user,
                '-e', 'POSTGRES_DB=' + database, pg_image)
        volumes.append(volume)
        command('docker', 'volume', 'create', '--label', 'io.antnest.runtime-controller-scope=' + scope, '--label', 'io.antnest.agent-id=' + agent, volume)
        containers.append(runtime)
        command('docker', 'run', '-d', '--name', runtime, '--network', 'none', '--label', 'io.antnest.runtime-controller-scope=' + scope,
                '--label', 'io.antnest.agent-id=' + agent, '--mount', 'type=volume,source=' + volume + ',target=/workspace',
                rt_image, 'sh', '-c', 'trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done')
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if cancelled:
                raise InterruptedError(cancelled)
            ready = subprocess.run(['docker', 'exec', postgres, 'pg_isready', '-U', user, '-d', database], capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise AssertionError('PostgreSQL fixture startup deadline')
        sql('CREATE TABLE acp_sessions(id text PRIMARY KEY,agent_id text,cwd text);'
            'CREATE TABLE runs(id text PRIMARY KEY,session_id text,state text,stop_reason text,executor_state text);'
            'CREATE TABLE tool_attempts(run_id text,tool_call_id text,tool_name text,state text,tool_effect_state text);'
            'CREATE TABLE session_messages(session_id text,kind text,payload jsonb);')
        cases = ['passed', 'wrong-session-agent', 'missing-run', 'unsettled-tool', 'bad-rejection', 'rejection-created-attempt',
                 'other-session-active-run', 'wrong-marker', 'changed-revision', 'wrong-trace-session', 'retained-agent-used-as-temporary',
                 'workspace-symlink-escape', 'no-rejections']
        for case in cases:
            if cancelled:
                raise InterruptedError(cancelled)
            folder = output / case
            config = controller_fixture(folder / 'evidence', agent=agent, temporary=temporary)
            config.update(postgres_container=postgres, database_user=user, database_name=database)
            browser = json.loads(Path(config['browser_report_path']).read_text())
            seed(browser['session_id'])
            command('docker', 'exec', runtime, 'rm', '-f', '/workspace/acceptance-note.txt')
            marker(browser['workspace_marker'])
            if case == 'wrong-session-agent':
                sql("UPDATE acp_sessions SET agent_id='other-agent';")
            elif case == 'missing-run':
                sql("DELETE FROM runs WHERE id='run-2';")
            elif case == 'unsettled-tool':
                sql("UPDATE tool_attempts SET tool_effect_state='unsettled' WHERE tool_call_id='write-ok';")
            elif case == 'bad-rejection':
                sql("UPDATE session_messages SET payload=jsonb_set(payload,'{content}', '[{\"text\":\"unexpected error\"}]');")
            elif case == 'rejection-created-attempt':
                sql("INSERT INTO tool_attempts VALUES ('unrelated-run','rejected_0','write','completed','settled');")
            elif case == 'other-session-active-run':
                sql("INSERT INTO runs VALUES ('other-run','other-session','running',NULL,'active');")
            elif case == 'wrong-marker':
                marker('changed')
            elif case == 'changed-revision':
                path = Path(config['agent_final_path']); state = json.loads(path.read_text()); state['runtime_revision'] = 'changed'; path.write_text(json.dumps(state))
            elif case == 'wrong-trace-session':
                path = Path(config['trace_review_path']); reviews = json.loads(path.read_text()); reviews[0]['session_id'] = 'other'; path.write_text(json.dumps(reviews))
            elif case == 'retained-agent-used-as-temporary':
                Path(config['temporary_agent_path']).write_text(json.dumps({'agent_id': agent}))
            elif case == 'workspace-symlink-escape':
                command('docker', 'exec', runtime, 'sh', '-c', 'mv /workspace/acceptance-note.txt /tmp/marker; ln -s /tmp/marker /workspace/acceptance-note.txt')
            elif case == 'no-rejections':
                sql('TRUNCATE session_messages;')
            write_report(folder, 'config.json', config)
            with (folder / 'execution.log').open('x') as log:
                completed = subprocess.run([sys.executable, '-B', str(ROOT / 'tests/e2e/development/controller-final-checks.py'), '--config', str(folder / 'config.json')],
                                           stdout=log, stderr=subprocess.STDOUT, timeout=60)
            expected_success = case in ['passed', 'no-rejections']
            assert (completed.returncode == 0) == expected_success, case + ' unexpected exit'
            if expected_success:
                report = json.loads(Path(config['final_report_path']).read_text())
                assert report['completed_runs'] == 3 and report['runtime_calls'] == 3 and report['chat_strict_failed'] == 1
                assert report['preflight_schema_rejections'] == (0 if case == 'no-rejections' else 2)
            else:
                assert not Path(config['final_report_path']).exists(), case + ' wrote passing report'
            results.append(dict(case=case, exit_code=completed.returncode, expected_failure=not expected_success))
    finally:
        try:
            for name in reversed(containers):
                command('docker', 'rm', '-fv', name)
            for name in reversed(volumes):
                command('docker', 'volume', 'rm', name)
            after = inventory_module.inventory()
            write_report(output, 'environment-after.json', after)
            assert before == after, 'retained environment changed'
            write_report(output, 'isolation.json', dict(unchanged=True, resource_counts={key:len(value) for key,value in after['resources'].items()}))
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    if cancelled:
        raise InterruptedError(cancelled)
    report = dict(status='passed', checks=results, scope='Actual PostgreSQL queries, Docker Runtime/volume reads and CLI assertions using synthetic acceptance reports and database rows; not ACP service business acceptance.')
    write_report(output, 'result.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=durable_path)
    parser.add_argument('--postgres-image', required=True)
    parser.add_argument('--runtime-image', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output, args.postgres_image, args.runtime_image)))
