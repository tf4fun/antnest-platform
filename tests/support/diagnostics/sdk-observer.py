"""Observe SDK fixture containers and clean the entire owned subprocess group."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'verification'))
from configuration import configured_arguments, durable_path
from observer_configuration import evidence_file, validate_observer
from owned_process import OwnedProcess
import os
import re
import subprocess

config, _ = configured_arguments(require_mode=False, validate_config=lambda value: validate_observer(value, 'sdk'))
output = Path(config['output'])
env = {**os.environ, **config['environment']}
with OwnedProcess(config['command'], env=env, grace_seconds=config['cleanup_grace_seconds']) as owner:
    while owner.child.poll() is None:
        names = owner.call(subprocess.check_output, ['docker', 'ps', '-a', '--format', '{{.Names}}', '--filter', config['container_filter']], text=True, timeout=10).split()
        for name in names:
            if not re.fullmatch(config['container_pattern'], name):
                continue
            state_path = evidence_file(output, name + '.state.json')
            logs_path = evidence_file(output, name + '.private.log')
            state = owner.call(subprocess.run, ['docker', 'inspect', '--format', '{{json .State}}', name], capture_output=True, text=True, timeout=10)
            logs = owner.call(subprocess.run, ['docker', 'logs', name], capture_output=True, text=True, timeout=10)
            if state.returncode == 0:
                durable_path(state_path).write_text(state.stdout)
            if logs.returncode == 0:
                durable_path(logs_path).write_text(logs.stdout + logs.stderr)
        owner.pause(.3)
    owner.check_cancel()
    code = owner.child.returncode
raise SystemExit(code)
