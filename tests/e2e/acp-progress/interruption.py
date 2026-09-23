"""Interrupt an owned fixture and record its cleanup before harness fallback."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'support' / 'verification'))
from configuration import configured_arguments
from observer_configuration import evidence_file, validate_observer
from owned_process import OwnedProcess, process_table
import json
import os
import signal
import subprocess
import time

config, _ = configured_arguments(require_mode=False, validate_config=lambda value: validate_observer(value, 'interruption'))
output = Path(config['output'])
env = {**os.environ, **config['environment']}
with evidence_file(output, 'interrupted.log').open('w') as log:
    with OwnedProcess(config['command'], env=env, stdout=log, stderr=subprocess.STDOUT,
                      grace_seconds=config['cleanup_grace_seconds']) as owner:
        project = config['project_template'].format(pid=owner.child.pid)
        captured = set()
        sent = False
        code = None
        failure = None

        def docker(*args):
            return owner.call(subprocess.check_output, ['docker', *args], text=True, timeout=15, stderr=subprocess.DEVNULL).strip()

        try:
            deadline = time.monotonic() + 160
            while owner.child.poll() is None and time.monotonic() < deadline:
                if docker('ps', '-aq', '--filter', config['trigger_filter'].format(project=project)):
                    table = owner.call(process_table)
                    captured = {owner.child.pid}
                    while True:
                        expanded = captured | {pid for pid, row in table.items() if row['parent'] in captured}
                        if expanded == captured:
                            break
                        captured = expanded
                    assert owner.signal_group(signal.SIGTERM), 'fixture ended before SIGTERM was delivered'
                    sent = True
                    break
                owner.pause(.25)
            owner.check_cancel()
            assert sent, 'client creation deadline exceeded'
            code = owner.wait(150)
            assert code != 0, 'interruption was reported as success'
        except BaseException as error:
            failure = error

        # Preserve the fixture's result before __exit__ performs fallback cleanup.
        # In particular, a timeout remains exitCode=null, never a synthetic success.
        if owner.cancelled is None:
            try:
                resources = {}
                for kind, args in [('containers', ['ps', '-aq']), ('volumes', ['volume', 'ls', '-q']), ('networks', ['network', 'ls', '-q'])]:
                    resources[kind] = sorted({item for label in ['com.docker.compose.project', 'io.antnest.runtime-controller-scope']
                                              for item in docker(*args, '--filter', f'label={label}={project}').split()})
                table = owner.call(process_table)
                remaining = sorted(captured & set(table))
                group_members = sorted(pid for pid, row in table.items() if row['group'] == owner.child.pid and not row['state'].startswith('Z'))
                result = {'project': project, 'trigger': config['trigger_description'], 'signal': 'SIGTERM' if sent else None,
                          'exitCode': code, 'resources': resources, 'remainingChildPids': remaining,
                          'remainingProcessGroupMembers': group_members}
                evidence_file(output, 'interruption.json').write_text(json.dumps(result, indent=2) + '\n')
                print(json.dumps(result))
                assert not any(resources.values()), 'owned Docker resources remain'
                assert not remaining, 'verification child processes remain'
                assert not group_members, 'verification process group members remain'
            except BaseException as observation_error:
                if failure is None:
                    failure = observation_error
                else:
                    failure.add_note(f'cleanup observation also failed: {observation_error}')
        if failure is not None:
            raise failure
        owner.check_cancel()
