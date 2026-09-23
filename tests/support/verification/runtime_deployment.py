"""Bound inputs and durable evidence for the Runtime deployment acceptance entry.

This module performs no Docker, database, deployment or process operations.
The four-mode entry keeps those operations and its whole-daemon assertions.
"""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from configuration import durable_path
from development_configuration import (file_path, object_fields, read_json,
                                        require, text, workspace_mount)

SERVICE = 'runtime-controller'
TABLES = ('acp_sessions', 'runs', 'session_messages', 'tool_attempts')
BASELINE_FILES = ('before.json', 'containers.private.json', 'compose.private.json', 'rows-before.json')


def normalized_image_tag(value):
    """Docker Hub aliases and implicit latest must not hide a tag collision."""
    text(value, 'image tag')
    require('@' not in value and '://' not in value, 'expected an image tag, not a digest or URL')
    parts = value.split('/')
    final = parts[-1]
    name, separator, tag = final.partition(':')
    tag = tag if separator else 'latest'
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag), 'invalid image tag')
    parts[-1] = name
    registry = 'docker.io'
    if len(parts) > 1 and ('.' in parts[0] or ':' in parts[0] or parts[0] == 'localhost'):
        registry = parts.pop(0).lower()
        require(re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?', registry), 'invalid image registry')
        if ':' in registry:
            require(0 < int(registry.rsplit(':', 1)[1]) < 65536, 'invalid image registry port')
    if registry == 'index.docker.io':
        registry = 'docker.io'
    require(parts and all(re.fullmatch(r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*', part) for part in parts), 'invalid image repository')
    if registry == 'docker.io' and len(parts) == 1:
        parts.insert(0, 'library')
    return registry + '/' + '/'.join(parts) + ':' + tag


def runtime_output_file(config, name, *, fresh=True):
    require(Path(name).name == name and name not in ('', '.', '..'), 'invalid evidence filename')
    root = Path(config['output'])
    require(not root.is_symlink(), 'output directory must not be a symbolic link')
    raw = root / name
    path = durable_path(raw)
    try:
        info = raw.lstat()
    except FileNotFoundError:
        return path
    require(stat.S_ISREG(info.st_mode), 'output must be a regular file, not a directory or link: ' + name)
    require(info.st_nlink == 1, 'output must not be a hard link: ' + name)
    require(not fresh, 'output already exists: ' + name)
    return path


def write_runtime_report(config, name, value, *, fresh=True):
    path = runtime_output_file(config, name, fresh=fresh)
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    if fresh:
        flags |= os.O_EXCL
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'w') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'output must be a regular file with one link')
        os.fchmod(stream.fileno(), 0o600)
        if not fresh:
            stream.truncate(0)
        json.dump(value, stream, indent=2)


def _sha(path):
    return hashlib.sha256(file_path(path).read_bytes()).hexdigest()


def _compose_inputs(config):
    argv = config['compose']
    return {str(file_path(argv[index+1])): _sha(argv[index+1])
            for index in range(2, len(argv), 2) if argv[index] in ('-f', '--file', '--env-file')}


def _context(config):
    return dict(version=1, configuration=config, compose_inputs=_compose_inputs(config),
                baseline_files={name: _sha(Path(config['output']) / name) for name in BASELINE_FILES})


def safe_container(row):
    return dict(id=row['Id'], name=row['Name'], image=row['Image'], started=row['State']['StartedAt'],
                restarts=row['RestartCount'], running=row['State']['Running'],
                health=row['State'].get('Health', {}).get('Status'),
                mounts=sorted(row['Mounts'], key=lambda item: item['Destination']),
                networks=sorted(row['NetworkSettings']['Networks']))


def validate_runtime_inspection(row):
    require(isinstance(row, dict), 'container inspection must be an object')
    require(all(key in row for key in ('Id', 'Name', 'Image', 'State', 'RestartCount', 'Mounts', 'NetworkSettings', 'Config', 'HostConfig')), 'incomplete container inspection')
    text(row['Id'], 'full container ID', r'[a-f0-9]{64}')
    text(row['Name'], 'container name', r'/[A-Za-z0-9][A-Za-z0-9_.-]*')
    text(row['Image'], 'image ID', r'sha256:[a-f0-9]{64}')
    require(type(row['RestartCount']) is int and row['RestartCount'] >= 0, 'invalid restart count')
    state = row['State']
    require(isinstance(state, dict) and type(state.get('Running')) is bool, 'invalid container state')
    started = text(state.get('StartedAt'), 'container start time', r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})')
    try:
        datetime.fromisoformat(started.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('invalid container start time') from error
    if 'Health' in state:
        require(isinstance(state['Health'], dict) and state['Health'].get('Status') in ('healthy', 'starting', 'unhealthy'), 'invalid health state')
    require(isinstance(row['NetworkSettings'], dict) and isinstance(row['NetworkSettings'].get('Networks'), dict), 'container networks missing')
    require(isinstance(row['Config'], dict) and isinstance(row['Config'].get('Labels') or {}, dict), 'container labels missing')
    require(isinstance(row['HostConfig'], dict) and isinstance(row['HostConfig'].get('Tmpfs') or {}, dict), 'container host configuration missing')
    require(isinstance(row['Mounts'], list), 'container mounts missing')
    destinations = []
    for mount in row['Mounts']:
        require(isinstance(mount, dict), 'invalid mount')
        destinations.append(text(mount.get('Destination'), 'mount destination', r'/.*'))
        require(mount.get('Type') in ('bind', 'volume', 'tmpfs') and type(mount.get('RW')) is bool, 'invalid mount type or access')
        if mount['Type'] == 'volume':
            text(mount.get('Name'), 'volume name')
    require(len(set(destinations)) == len(destinations), 'duplicate mount destinations')
    return row


def _environment(row):
    values = row['Config'].get('Env')
    require(isinstance(values, list) and all(isinstance(value, str) and '=' in value for value in values), 'container environment missing')
    pairs = [value.split('=', 1) for value in values]
    require(len({key for key, _ in pairs}) == len(pairs), 'ambiguous container environment')
    return dict(pairs)


def validate_compose_identity(row, config, service, name):
    validate_runtime_inspection(row)
    require(row['Name'] == '/' + name, 'container name mismatch')
    labels = row['Config'].get('Labels') or {}
    require(labels.get('com.docker.compose.project') == config['project'], 'container Compose project mismatch')
    require(labels.get('com.docker.compose.service') == service, 'container Compose service mismatch')
    return row


def validate_workspace_identity(row, config, scope):
    validate_runtime_inspection(row)
    expected = config['workspace']
    labels = row['Config'].get('Labels') or {}
    require(labels.get('io.antnest.agent-id') == expected['container'].removeprefix('antnest-runtime-'), 'Runtime Agent mismatch')
    require(labels.get('io.antnest.managed') == 'runtime', 'unmanaged Runtime')
    require(labels.get('io.antnest.runtime-controller-scope') == scope, 'Runtime scope mismatch')
    require(not any(path == '/workspace' or path.startswith('/workspace/') for path in (row['HostConfig'].get('Tmpfs') or {})), 'tmpfs shadows workspace')
    try:
        workspace_mount(row, expected)
    except AssertionError as error:
        raise ValueError(str(error)) from error
    return row


def validate_runtime_baseline(config):
    output = Path(config['output'])
    before, inspections, compose, rows = [read_json(output/name) for name in BASELINE_FILES]
    object_fields(before, 'before snapshot', {'containers', 'workspace_sha256', 'row_counts'})
    text(before['workspace_sha256'], 'workspace SHA-256', r'[a-f0-9]{64}')
    require(isinstance(inspections, list) and len(inspections) == config['expected']['containers'], 'baseline container count mismatch')
    for row in inspections:
        validate_runtime_inspection(row)
    require(len({row['Id'] for row in inspections}) == len(inspections), 'duplicate baseline IDs')
    require(len({row['Name'] for row in inspections}) == len(inspections), 'duplicate baseline names')
    require(before['containers'] == [safe_container(row) for row in inspections], 'baseline full/safe inspections disagree')
    require(isinstance(rows, dict) and set(rows) == set(TABLES), 'expected exactly four ACP table snapshots')
    for table in TABLES:
        require(isinstance(rows[table], dict), 'table snapshot must be an object')
        for key, digest in rows[table].items():
            text(key, 'row ID')
            text(digest, 'row MD5', r'[a-f0-9]{32}')
    require(isinstance(before['row_counts'], dict) and set(before['row_counts']) == set(TABLES), 'row counts missing')
    require(all(type(value) is int for value in before['row_counts'].values()), 'row counts must be integers')
    require(before['row_counts'] == {table: len(rows[table]) for table in TABLES}, 'row counts do not match snapshots')
    require(isinstance(compose, dict) and compose.get('name') == config['project'], 'Compose snapshot project mismatch')
    require(isinstance(compose.get('services'), dict) and SERVICE in compose['services'], 'Compose service missing')
    service = compose['services'][SERVICE]
    require(isinstance(service, dict) and isinstance(service.get('environment'), dict), 'Compose environment missing')
    require(normalized_image_tag(service.get('image')) == normalized_image_tag(config['images'][SERVICE]['localTag']), 'Compose service image mismatch')
    scope = text(service['environment'].get('ANTNEST_RUNTIME_CONTROLLER_SCOPE'), 'Runtime Controller scope', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
    health = service.get('healthcheck')
    require(isinstance(health, dict) and isinstance(health.get('test'), list) and health['test'] and all(isinstance(value, str) for value in health['test']), 'Compose healthcheck missing')
    by_name = {row['Name']: row for row in inspections}
    names = [config['project']+'-'+SERVICE+'-1', config['database']['container'], config['workspace']['container']]
    require(all('/'+name in by_name for name in names), 'required baseline container missing')
    target, pg, runtime = [by_name['/'+name] for name in names]
    validate_compose_identity(target, config, SERVICE, names[0])
    validate_compose_identity(pg, config, 'postgres', names[1])
    validate_workspace_identity(runtime, config, scope)
    require(target['State']['Running'] and target['State'].get('Health', {}).get('Status') == 'healthy', 'baseline target must be running and healthy')
    require(all(_environment(target).get(key) == str(value) for key, value in service['environment'].items()), 'baseline environment differs from Compose')
    require(sum(row['State'].get('Health', {}).get('Status') == 'healthy' for row in inspections) == config['expected']['healthy'], 'baseline healthy count mismatch')
    return dict(before=before, inspections=inspections, compose=compose, rows=rows, target=target, postgres=pg, runtime=runtime, scope=scope)


def capture_runtime_context(config):
    validate_runtime_baseline(config)
    write_runtime_report(config, 'deployment-context.private.json', _context(config))


def validate_runtime_deployment(config, mode):
    tags = [normalized_image_tag(value) for key, value in config['images'][SERVICE].items() if key.endswith('Tag')]
    require(len(tags) == len(set(tags)), 'candidate/local/rollback image aliases must be distinct')
    outputs = {
        'before': [*BASELINE_FILES, 'deployment-context.private.json'],
        'deploy': ['deployment-stops.json', 'backups.json', 'deployed.private.json', 'rollback.private.json', *[value+'.dump' for value in config['database']['names'].values()]],
        'restart': ['restart-stops.json', 'restarted.private.json', 'restart-recovery.private.json'],
        'after': ['after.json'],
    }[mode]
    for name in outputs:
        runtime_output_file(config, name, fresh=mode != 'after')
    if mode == 'before':
        return
    context = read_json(Path(config['output'])/'deployment-context.private.json')
    object_fields(context, 'deployment context', {'version', 'configuration', 'compose_inputs', 'baseline_files'})
    require(type(context['version']) is int and context['version'] == 1, 'unsupported deployment context version')
    require(context == _context(config), 'deployment configuration, Compose inputs or baseline bytes changed')
    baseline = validate_runtime_baseline(config)
    if mode in ('restart', 'after'):
        deployed = read_json(Path(config['output'])/'deployed.private.json')
        validate_compose_identity(deployed, config, SERVICE, config['project']+'-'+SERVICE+'-1')
        require(deployed['Image'] == config['images'][SERVICE]['candidateImage'], 'deployment record image mismatch')
        require(deployed['State']['Running'] and deployed['State'].get('Health', {}).get('Status') == 'healthy', 'deployment record must be running and healthy')
        current, old = safe_container(deployed), safe_container(baseline['target'])
        require(current['mounts'] == old['mounts'] and current['networks'] == old['networks'], 'deployment record mounts or networks changed')
