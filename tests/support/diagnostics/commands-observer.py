"""Observe Commands fixtures while retaining ownership of their process group."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'verification'))
from configuration import configured_arguments, durable_path
from observer_configuration import evidence_file, validate_observer
from owned_process import OwnedProcess
import json
import os
import re
import subprocess

config, _ = configured_arguments(require_mode=False, validate_config=lambda value: validate_observer(value, 'commands'))
output = Path(config['output'])
env = {**os.environ, **config['environment']}
log_path = evidence_file(output, 'commands-diagnostic-inner.log')
with log_path.open('x') as log:
    with OwnedProcess(config['command'], env=env, stdout=log, stderr=subprocess.STDOUT,
                      grace_seconds=config['cleanup_grace_seconds']) as owner:
        while owner.child.poll() is None:
            owner.check_cancel()
            projects = set(re.findall(config['project_pattern'], log_path.read_text()))
            for project in projects:
                states_path = evidence_file(output, project + '.diagnostic-states.json')
                ids = owner.call(subprocess.check_output, ['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}'], text=True, timeout=15).split()
                if not ids:
                    continue
                inspection = owner.call(subprocess.run, ['docker', 'inspect', *ids], capture_output=True, text=True, timeout=15)
                # Teardown can remove an object after enumeration; preserve this normal race.
                if inspection.returncode != 0:
                    continue
                states = []
                for row in json.loads(inspection.stdout):
                    name = row['Name'].strip('/')
                    states.append({'name': name, 'state': row['State'], 'restarts': row['RestartCount']})
                    if any(service in name for service in config['services']):
                        path = evidence_file(output, name + '.private.log')
                        data = owner.call(subprocess.run, ['docker', 'logs', '--tail', '3000', row['Id']], capture_output=True, timeout=15)
                        if data.returncode == 0:
                            durable_path(path).write_bytes(data.stdout + data.stderr)
                durable_path(states_path).write_text(json.dumps(states, indent=2))
            owner.pause(3)
        owner.check_cancel()
        code = owner.child.returncode
print(log_path.read_text())
raise SystemExit(code)
