"""Validate observer inputs before any child or output is created."""
import math
from pathlib import Path
import re
from string import Formatter
from configuration import durable_path


def string(value, label):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError(f'{label} must be a nonempty string without NUL')
    return value


def evidence_file(output, name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
        raise ValueError('evidence filename must be one safe name')
    path = durable_path(Path(output) / name)
    if path.exists() and not path.is_file():
        raise ValueError('evidence output must be a file')
    return path


def template(value, field):
    string(value, f'{field} template')
    fields = []
    for _, name, spec, conversion in Formatter().parse(value):
        if name is not None:
            if name != field or spec or conversion:
                raise ValueError(f'template may contain only {{{field}}}')
            fields.append(name)
    if field not in fields:
        raise ValueError(f'template requires {{{field}}}')


def validate_observer(config, profile):
    command = config.get('command')
    if not isinstance(command, list) or not command:
        raise ValueError('command must be a nonempty argument array')
    for argument in command:
        if not isinstance(argument, str) or '\0' in argument:
            raise ValueError('command arguments must be strings without NUL')
    string(command[0], 'command executable')
    environment = config.get('environment')
    if not isinstance(environment, dict):
        raise ValueError('environment must be a string object')
    for key, value in environment.items():
        string(key, 'environment name')
        if '=' in key or not isinstance(value, str) or '\0' in value:
            raise ValueError('environment entries must be valid strings')
    grace = config.get('cleanup_grace_seconds', {'commands': 180, 'sdk': 45, 'interruption': 150}[profile])
    if isinstance(grace, bool) or not isinstance(grace, (int, float)) or not math.isfinite(grace) or grace <= 0:
        raise ValueError('cleanup_grace_seconds must be positive and finite')
    config['cleanup_grace_seconds'] = grace
    output = Path(config['output'])
    if output.exists() and not output.is_dir():
        raise ValueError('output must be a directory')
    if profile == 'commands':
        pattern = re.compile(string(config.get('project_pattern'), 'project_pattern'))
        if pattern.groups > 1 or pattern.search(''):
            raise ValueError('project_pattern must yield a nonempty single project name')
        services = config.get('services')
        if not isinstance(services, list) or not services:
            raise ValueError('services must be a nonempty string array')
        for service in services:
            string(service, 'service')
        log = evidence_file(output, 'commands-diagnostic-inner.log')
        if log.exists():
            raise ValueError('commands diagnostic log already exists')
    elif profile == 'sdk':
        string(config.get('container_filter'), 'container_filter')
        re.compile(string(config.get('container_pattern'), 'container_pattern'))
    else:
        template(config.get('project_template'), 'pid')
        project = config['project_template'].format(pid=12345)
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project):
            raise ValueError('project_template must produce a Compose project name')
        template(config.get('trigger_filter'), 'project')
        string(config.get('trigger_description'), 'trigger_description')
        evidence_file(output, 'interrupted.log')
        evidence_file(output, 'interruption.json')
