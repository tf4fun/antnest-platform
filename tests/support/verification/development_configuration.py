"""Input preflight and fixed contracts for retained-development drivers."""
import json
import os
from pathlib import Path
import re
import shlex
import stat
from configuration import configured_arguments, durable_path

DEPLOYMENTS = {
    'controller-20260917': ['agent-controller', 'runtime-controller'],
    'controller-20260921': ['agent-controller'],
    'runtime-20260921': ['runtime-controller'],
    'temporal-20260921': ['temporal', 'agent-controller'],
}
LIFECYCLE_KINDS = {'create', 'disable', 'enable', 'rebuild', 'delete'}
COMMON_FINAL_PATHS = {'agent_before_path', 'agent_final_path', 'lifecycle_report_path', 'replay_report_path',
                      'temporary_agent_path', 'after_snapshot_path', 'replay_trace_path'}


def require(value, message):
    if not value:
        raise ValueError(message)


def text(value, name, pattern=None):
    require(isinstance(value, str) and value and '\x00' not in value, name + ' is required')
    if pattern:
        require(re.fullmatch(pattern, value), 'invalid ' + name)
    return value


def object_fields(value, name, required, allowed=None):
    require(isinstance(value, dict), name + ' must be an object')
    require(not (set(value) - set(allowed if allowed is not None else required)), 'unknown ' + name + ' fields')
    missing = set(required) - set(value)
    require(not missing, name + ' missing fields: ' + ', '.join(sorted(missing)))


def file_path(value):
    path = durable_path(value if isinstance(value, Path) else text(value, 'file path'))
    require(path.is_file() and stat.S_ISREG(path.stat().st_mode), 'input must be a regular file: ' + str(path))
    return path


def read_json(value):
    return json.loads(file_path(value).read_text())


def output_tree(output):
    if output.exists():
        require(output.is_dir(), 'output must be a directory')
        for root, directories, files in os.walk(output, followlinks=False):
            for name in directories + files:
                path = Path(root) / name
                durable_path(path)
                require(not path.is_symlink(), 'output entries must not be symbolic links')
                require(path.is_dir() or stat.S_ISREG(path.stat().st_mode), 'output entries must be regular files or directories')


def validate_compose(argv, project):
    require(isinstance(argv, list) and argv[:2] == ['docker', 'compose'], 'compose must start with docker compose')
    require(all(isinstance(value, str) and value for value in argv), 'compose arguments must be strings')
    index, projects, files = 2, [], []
    while index < len(argv):
        option = argv[index]
        require(option in ['-p', '--project-name', '-f', '--file', '--env-file', '--profile'], 'invalid compose option')
        require(index + 1 < len(argv), 'missing compose option value')
        value = argv[index + 1]
        if option in ['-p', '--project-name']:
            projects.append(value)
        elif option in ['-f', '--file', '--env-file']:
            file_path(value)
            if option != '--env-file':
                files.append(value)
        else:
            text(value, 'compose profile', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
        index += 2
    require(projects == [project], 'compose project must match project exactly once')
    require(files, 'compose requires explicit files')


def validate_workspace(value):
    object_fields(value, 'workspace', {'container', 'path', 'volume'})
    text(value['container'], 'workspace container', r'antnest-runtime-agent_[a-f0-9]{32}')
    text(value['volume'], 'workspace volume', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
    require(value['path'] == '/workspace', 'workspace must cover the complete /workspace')


def workspace_mount(row, expected):
    assert row['Name'] == '/' + expected['container'], 'workspace container identity mismatch'
    assert not any(mount.get('Destination', '').startswith('/workspace/') for mount in row['Mounts']), 'nested mounts must not shadow the workspace volume'
    mounts = [mount for mount in row['Mounts'] if mount.get('Destination') == '/workspace']
    assert len(mounts) == 1, 'expected one full workspace mount'
    mount = mounts[0]
    assert mount.get('Type') == 'volume' and mount.get('RW') is True and mount.get('Name') == expected['volume'], 'workspace must be the expected RW volume'
    return mount


def validate_development(config, profile, mode):
    output = durable_path(text(config.get('output'), 'output'))
    # Validate leaves before mode-specific fields or any external command.
    output_tree(output)
    if profile in DEPLOYMENTS:
        allowed = {'output', 'project', 'database', 'images', 'compose', 'expected', 'workspace', 'reports'}
        object_fields(config, 'configuration', allowed - {'workspace', 'reports'}, allowed)
        services = DEPLOYMENTS[profile]
        modes = (['before', 'after', 'final', *services] if profile.startswith('controller') else
                 ['before', 'deploy', 'restart', 'after'] + (['resume'] if profile.startswith('temporal') else []))
        require(mode in modes, 'invalid deployment mode')
        project = text(config['project'], 'project', r'[a-z0-9][a-z0-9_-]*')
        database = config['database']
        object_fields(database, 'database', {'container', 'user', 'names'})
        text(database['container'], 'database.container', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
        text(database['user'], 'database.user', r'[a-zA-Z_][a-zA-Z0-9_]*')
        roles = {'acp', 'agentController', 'runtimeController'}
        if profile.startswith('temporal'):
            roles = {'acp', 'agentController', 'temporal', 'temporalVisibility'}
        object_fields(database['names'], 'database.names', roles, roles | {'runtimeController'})
        names = [text(value, 'database name', r'[a-zA-Z_][a-zA-Z0-9_]*') for value in database['names'].values()]
        require(len(names) == len(set(names)), 'database roles require distinct databases')
        object_fields(config['images'], 'images', services)
        all_tags = []
        for service in services:
            required = {'candidateTag', 'candidateImage', 'localTag', 'rollbackTag'}
            if profile.startswith('temporal'):
                required = {'candidateImage', 'localTag', 'rollbackTag'} if service == 'temporal' else {'rollbackTag'}
            image = config['images'][service]
            object_fields(image, service + ' image', required, {'candidateTag', 'candidateImage', 'localTag', 'rollbackTag'})
            for key, value in image.items():
                text(value, service + '.' + key, r'sha256:[a-f0-9]{64}' if key == 'candidateImage' else r'[a-zA-Z0-9][a-zA-Z0-9_./:-]*')
                if key.endswith('Tag'):
                    all_tags.append(value)
        require(len(all_tags) == len(set(all_tags)), 'candidate/local/rollback tags must be distinct')
        validate_compose(config['compose'], project)
        expected = config['expected']
        required = {'containers', 'otherContainersUnchanged'} if profile.startswith('controller') else {'containers', 'healthy', 'unaffectedProcesses'}
        object_fields(expected, 'expected', required, {'containers', 'healthy', 'unaffectedProcesses', 'otherContainersUnchanged'})
        require(all(type(value) is int and value >= 0 for value in expected.values()) and expected['containers'] > len(services), 'expected counts must be nonnegative integers with retained containers')
        require(expected.get('healthy', 0) <= expected['containers'], 'healthy count exceeds containers')
        if 'unaffectedProcesses' in expected:
            require(expected['unaffectedProcesses'] == expected['containers'] - len(services), 'unaffectedProcesses count does not match target services')
        if 'otherContainersUnchanged' in expected:
            excluded = len(services) + (profile == 'controller-20260921')
            require(expected['otherContainersUnchanged'] == expected['containers'] - excluded, 'otherContainersUnchanged count does not match target/recovery scope')
        if profile.startswith(('runtime', 'temporal')) or (profile == 'controller-20260917' and mode == 'final'):
            validate_workspace(config.get('workspace'))
        elif 'workspace' in config:
            validate_workspace(config['workspace'])
        needed_reports = []
        if profile == 'controller-20260917' and mode == 'final':
            needed_reports = ['browser', 'agentBefore', 'agentFinal', 'temporaryAgent', 'lifecycle']
        if profile == 'controller-20260921' and mode in ['after', 'final']:
            needed_reports = ['recovery']
        reports = config.get('reports', {})
        object_fields(reports, 'reports', needed_reports, {'browser', 'agentBefore', 'agentFinal', 'temporaryAgent', 'lifecycle', 'recovery'})
        for name in needed_reports:
            read_json(reports[name])
        if mode != 'before':
            required_inputs = (['containers-before.json', 'database-before.json'] if profile.startswith('controller') else
                               ['before.json', 'rows-before.json', 'compose.private.json'])
            for name in required_inputs:
                read_json(output / name)
        for name in names:
            durable_path(output / (name + '.dump'))
            durable_path(output / (name + '-before.dump'))
        if profile == 'runtime-20260921':
            from runtime_deployment import validate_runtime_deployment
            validate_runtime_deployment(config, mode)
        if profile == 'temporal-20260921':
            from temporal_deployment import validate_temporal_deployment
            validate_temporal_deployment(config, mode)
        if profile in ('controller-20260917','controller-20260921'):
            from controller_deployment import validate_controller_deployment
            validate_controller_deployment(config, mode)
        return
    require(mode is None, 'this entry does not accept a mode')
    if profile == 'idle-restart':
        object_fields(config, 'configuration', {'output', 'controller_container'})
        text(config['controller_container'], 'controller_container', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*-agent-controller-1')
        require(not durable_path(output / 'idle-restart.json').exists(), 'idle-restart output already exists')
        return
    if profile == 'controller-final':
        paths = {'browser_report_path', 'agent_before_path', 'agent_final_path', 'temporary_agent_path', 'trace_review_path'}
        object_fields(config, 'configuration', {'output', 'postgres_container', 'database_user', 'database_name', 'runtime_container_prefix', 'final_report_path', 'workspace'} | paths)
        text(config['postgres_container'], 'postgres_container', r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
        text(config['database_user'], 'database_user', r'[a-zA-Z_][a-zA-Z0-9_]*')
        text(config['database_name'], 'database_name', r'[a-zA-Z_][a-zA-Z0-9_]*')
        require(config['runtime_container_prefix'] == 'antnest-runtime-', 'runtime container prefix must match the platform contract')
        report_key = 'final_report_path'
    else:
        require(profile in ['runtime-final', 'temporal-final'], 'unknown development profile')
        paths = COMMON_FINAL_PATHS | ({'compose_snapshot_path'} if profile == 'temporal-final' else set())
        controller_key = 'runtime_controller_container' if profile == 'runtime-final' else 'agent_controller_container'
        object_fields(config, 'configuration', {'output', controller_key, 'lifecycle_trace_glob', 'publication_trace_glob', 'summary_path'} | paths)
        text(config[controller_key], controller_key, r'[a-zA-Z0-9][a-zA-Z0-9_.-]*-' + ('runtime' if profile == 'runtime-final' else 'agent') + '-controller-1')
        report_key = 'summary_path'
    for name in paths:
        read_json(config[name])
    target = durable_path(config[report_key])
    require(not target.exists(), 'final report already exists')
    require(target.parent.is_dir(), 'final report parent must exist')
    require(target not in {durable_path(config[name]) for name in paths}, 'final report must not overwrite inputs')
    if profile != 'controller-final':
        config['_trace_groups'] = select_final_traces(config)
    else:
        from controller_evidence import validate_controller_reports
        validate_controller_reports(config)


def select_final_traces(config):
    output = durable_path(config['output'])
    lifecycle, replay = read_json(config['lifecycle_report_path']), read_json(config['replay_report_path'])
    agent = read_json(config['temporary_agent_path'])['agent_id']
    items = lifecycle['lifecycle']
    require(len(items) == 5 and {item['kind'] for item in items} == LIFECYCLE_KINDS, 'expected five distinct lifecycle kinds')
    for item in items:
        evidence = item['evidence']
        require(item['traceID'] == evidence['trace_id'] and item['kind'] == evidence['kind'], 'lifecycle report trace identity mismatch')
        require(item['agentId'] == evidence['agent_id'] == agent and item['requestId'] == evidence['request_id'], 'lifecycle Agent/request identity mismatch')
    require(len({item['requestId'] for item in items}) == 5, 'lifecycle requests must be distinct')
    expected = {'lifecycle': [item['traceID'] for item in items],
                'publication': [item['trace_id'] for item in lifecycle['publication']], 'replay': [replay['trace']['trace_id']]}
    require(len(expected['publication']) == 3, 'expected three publications')
    groups = []
    for kind, key in [('lifecycle', 'lifecycle_trace_glob'), ('publication', 'publication_trace_glob')]:
        pattern = text(config[key], key)
        require(not Path(pattern).is_absolute() and '..' not in Path(pattern).parts, 'trace patterns must be relative to output')
        durable_path(output / pattern)
        for candidate in sorted(output.glob(pattern)):
            path = file_path(candidate)
            trace = read_json(path)
            if isinstance(trace, dict) and 'spans' in trace:
                groups.append((kind, path, trace))
    path = file_path(config['replay_trace_path'])
    groups.append(('replay', path, read_json(path)))
    require(len({path for _, path, _ in groups}) == 9, 'expected nine distinct trace files')
    actual = [trace.get('traceID') for _, _, trace in groups]
    require(all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value) for value in actual), 'invalid trace ID')
    require(len(actual) == len(set(actual)) == 9, 'expected nine distinct trace IDs')
    for kind, ids in expected.items():
        found = [trace['traceID'] for group, _, trace in groups if group == kind]
        require(len(found) == len(ids) and len(ids) == len(set(ids)) and set(found) == set(ids), kind + ' trace count or report identity mismatch')
    for _, _, trace in groups:
        require(isinstance(trace.get('spans'), list) and trace['spans'], 'trace must contain spans')
    return groups


def development_children(profile, listing):
    markers = ['tests/e2e/development/lifecycle.mjs', 'tests/e2e/development/agent-state.mjs',
               'tests/e2e/development/replay.mjs', 'tests/support/run-command.mjs', 'tests/support/run-suite.mjs']
    if profile == 'controller-20260917':
        markers += ['scripts/workspace-closeout/development-browser.mjs', 'tests/e2e/workspace-closeout/development-browser.mjs',
                    'tests/e2e/development/metadata-browser.mjs', '.cache/controller-sync-20260917/lifecycle.mjs',
                    'playwright_chromiumdev_profile', 'chrome-headless-shell']
    else:
        batch = 'runtime' if profile == 'runtime-final' else 'temporal'
        markers += ['tests/e2e/development/runtime-loss.mjs'] if batch == 'runtime' else []
        markers += [f'.cache/{batch}-sync-20260921/{name}' for name in ['lifecycle.mjs', 'replay.mjs', 'run-command.py', 'agent-state.mjs']]
    rows = {}
    for line in listing.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3:
            rows[int(fields[0])] = (int(fields[1]), line)
    ancestors, pid = set(), os.getpid()
    while pid not in ancestors:
        ancestors.add(pid)
        if pid not in rows:
            break
        pid = rows[pid][0]
    def matches(line):
        try:
            tokens = shlex.split(line.split(None, 2)[2])
        except ValueError:
            tokens = line.split(None, 2)[2].split()
        paths = [os.path.normpath(token) for token in tokens]
        for marker in markers:
            if marker in ['playwright_chromiumdev_profile', 'chrome-headless-shell'] and marker in line:
                return True
            # Bare names are matched conservatively: serial verification must not
            # leave another invocation running from inside the script directory.
            if any(path == marker or path.endswith('/' + marker) or path == Path(marker).name for path in paths):
                return True
        return False
    return [line for pid, (_, line) in rows.items() if pid not in ancestors and matches(line)
            and (profile == 'controller-20260917' or 'zsh -lc' not in line)]


def development_arguments(profile, argv=None):
    return configured_arguments(argv, require_mode=profile in DEPLOYMENTS,
                                validate_mode=lambda config, mode: validate_development(config, profile, mode))
