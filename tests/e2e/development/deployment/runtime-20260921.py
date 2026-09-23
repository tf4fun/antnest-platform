"""Runtime Controller deployment acceptance with durable, bound evidence."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'support' / 'verification'))
from development_configuration import development_arguments, read_json, require
from runtime_deployment import (SERVICE, TABLES, capture_runtime_context, normalized_image_tag,
    runtime_output_file, safe_container, validate_compose_identity, validate_runtime_baseline,
    validate_runtime_inspection, validate_workspace_identity, write_runtime_report)


@contextlib.contextmanager
def interruption_handlers(recovering=False):
    def interrupt(signum, _frame):
        if not recovering:
            raise InterruptedError('deployment interrupted by signal ' + str(signum))
    previous = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def execute(config, mode):
    output = Path(config['output'])
    name = config['project'] + '-' + SERVICE + '-1'
    compose = config['compose']
    refs = config['images'][SERVICE]
    candidate, local, rollback = refs['candidateImage'], refs['localTag'], refs['rollbackTag']
    databases = config['database']['names']

    def run(args, **kwargs):
        return subprocess.check_output(args, timeout=kwargs.pop('timeout', 200), **kwargs)

    def inspect(ref):
        return json.loads(run(['docker', 'inspect', ref]))[0]

    def containers():
        ids = run(['docker', 'ps', '-aq'], text=True).split()
        return json.loads(run(['docker', 'inspect', *ids])) if ids else []

    def write(filename, value):
        write_runtime_report(config, filename, value, fresh=filename != 'after.json')

    def effective_compose():
        return json.loads(run(compose + ['config', '--format', 'json']))

    def service_matches(row, image, baseline=None):
        validate_compose_identity(row, config, SERVICE, name)
        require(row['Image'] == image, 'Runtime Controller image mismatch')
        env = dict(item.split('=', 1) for item in row['Config']['Env'])
        service = cfg['services'][SERVICE]
        require(all(env.get(key) == str(value) for key, value in service['environment'].items()), 'service environment differs')
        require(row['Config']['Healthcheck']['Test'] == service['healthcheck']['test'], 'service healthcheck differs')
        if baseline:
            now, old = safe_container(row), safe_container(baseline)
            require(now['mounts'] == old['mounts'] and now['networks'] == old['networks'], 'service mounts or networks changed')
        return row

    # Re-read effective Compose: explicit hashes do not bind implicit .env or
    # process environment interpolation. Match global IDs before SQL/mutations.
    cfg = effective_compose()
    cs = containers()
    require(len(cs) == config['expected']['containers'], 'global container count changed')
    for row in cs:
        validate_runtime_inspection(row)
    require(len({row['Id'] for row in cs}) == len(cs) and len({row['Name'] for row in cs}) == len(cs), 'duplicate live container identity')
    by_name = {row['Name']: row for row in cs}
    old = by_name['/' + name]
    pg = by_name['/' + config['database']['container']]
    runtime = by_name['/' + config['workspace']['container']]
    require(cfg.get('name') == config['project'], 'effective Compose project mismatch')
    service = cfg['services'][SERVICE]
    require(normalized_image_tag(service['image']) == normalized_image_tag(local), 'effective Compose image mismatch')
    scope = service['environment']['ANTNEST_RUNTIME_CONTROLLER_SCOPE']
    validate_compose_identity(pg, config, 'postgres', config['database']['container'])
    validate_workspace_identity(runtime, config, scope)
    require(pg['State']['Running'] and runtime['State']['Running'], 'database and workspace Runtime must be running')
    baseline = None
    if mode != 'before':
        baseline = validate_runtime_baseline(config)
        require(cfg == baseline['compose'], 'effective Compose configuration changed')
        deployed = read_json(output / 'deployed.private.json') if mode in ('restart', 'after') else baseline['target']
        for saved in baseline['inspections']:
            live = by_name.get(saved['Name'])
            require(live is not None, 'baseline container missing: ' + saved['Name'])
            expected = deployed if saved['Name'] == '/' + name else saved
            require(live['Id'] == expected['Id'], 'live container ID changed: ' + saved['Name'])
        if mode == 'deploy':
            require({row['Name']:safe_container(row) for row in cs} == {row['Name']:safe_container(row) for row in baseline['inspections']}, 'live deployment baseline changed')
    expected_image = candidate if mode in ('restart', 'after') else old['Image']
    service_matches(old, expected_image, baseline['target'] if baseline else None)
    require(old['State']['Running'] and old['State'].get('Health', {}).get('Status') == 'healthy', 'Runtime Controller must be running and healthy')
    require(inspect(local)['Id'] == expected_image, 'local image tag changed')
    require(inspect(refs['candidateTag'])['Id'] == candidate, 'candidate image tag changed')
    if mode in ('before', 'deploy'):
        require(not run(['docker', 'image', 'ls', '-q', '--filter', 'reference=' + rollback], text=True).strip(), 'rollback tag already exists')
    else:
        require(inspect(rollback)['Id'] == baseline['target']['Image'], 'rollback image tag changed')

    def sql(database, query):
        return run(['docker', 'exec', pg['Id'], 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', config['database']['user'], '-d', database, '-c', query], text=True).strip()

    def rows():
        return {table:json.loads(sql(databases['acp'], f"SELECT coalesce(jsonb_object_agg(id,md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {table} t")) for table in TABLES}

    def idle():
        require(sql(databases['acp'], "SELECT count(*) FROM runs WHERE state IN ('admitting','running')") == '0', 'active ACP runs')
        require(sql(databases['agentController'], "SELECT count(*) FROM agent_controller.agents WHERE active_operation_request_id <> ''") == '0', 'active Agent operation')

    def workspace():
        # find -exec ... + propagates a failing hash command. Preserve zero
        # bytes for an empty manifest and do not hide read failures behind sort.
        script = 'cd ' + shlex.quote(config['workspace']['path']) + ' || exit $?; manifest=$(find . -type f -exec sha256sum {} +) || exit $?; if [ -n "$manifest" ]; then printf \'%s\\n\' "$manifest" | LC_ALL=C sort; fi'
        return hashlib.sha256(run(['docker', 'exec', runtime['Id'], 'sh', '-c', script])).hexdigest()

    def wait(ref, image, original):
        end = time.monotonic() + 180
        while time.monotonic() < end:
            row = service_matches(inspect(ref), image, original)
            require(row['Id'] == ref, 'container changed while waiting')
            if row['State']['Running'] and row['State'].get('Health', {}).get('Status') == 'healthy':
                return row
            time.sleep(1)
        raise RuntimeError(SERVICE + ' health deadline exceeded')

    def stop(row):
        run(['docker', 'stop', '-t', '30', row['Id']])
        stopped = inspect(row['Id'])
        validate_compose_identity(stopped, config, SERVICE, name)
        require(stopped['Id'] == row['Id'], 'container changed while stopping')
        state = stopped['State']
        require(state['Status'] == 'exited' and state['ExitCode'] == 0 and not state['OOMKilled'], 'service did not stop normally')
        return dict(service=SERVICE, exit=state['ExitCode'], finished=state['FinishedAt'])

    current_target = old

    def up(image, expected):
        nonlocal current_target
        require(effective_compose() == cfg, 'effective Compose changed before service update')
        if expected is None:
            # Recreate an absent target only after confirming the exact name is
            # still free and every other baseline container remains bound.
            require(not run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'], text=True).strip(), 'unexpected service appeared before recovery')
            for saved in baseline['inspections']:
                if saved['Id'] != old['Id']:
                    current = validate_runtime_inspection(inspect(saved['Id']))
                    require(current['Id'] == saved['Id'] and current['Name'] == saved['Name'], 'recovery daemon/container identity changed')
        else:
            current = validate_compose_identity(inspect(name), config, SERVICE, name)
            require(current['Id'] == expected['Id'], 'service replaced before Compose update')
        try:
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', SERVICE], stderr=subprocess.STDOUT)
        except BaseException as compose_error:
            # A failed Compose wait may have already created its replacement.
            # Bind that observed result once; recovery never targets a later
            # unknown replacement by name.
            try:
                observed = validate_compose_identity(inspect(name), config, SERVICE, name)
                current_target = observed
            except BaseException as observation_error:
                compose_error.add_note('Cannot bind Compose result: ' + str(observation_error))
            raise
        row = inspect(name)
        validate_compose_identity(row, config, SERVICE, name)
        current_target = row
        service_matches(row, image, old)
        return wait(row['Id'], image, old)

    def recover(original_error, filename, action):
        # Ignore repeated signals only while bounded recovery is in progress.
        with interruption_handlers(recovering=True):
            try:
                recovered = action()
                write(filename, dict(status='recovered', original_error=str(original_error), container=recovered))
            except BaseException as recovery_error:
                raise RuntimeError('deployment recovery failed: ' + str(recovery_error)) from original_error

    idle()
    if mode == 'before':
        current_rows = rows()
        write('compose.private.json', cfg)
        write('containers.private.json', cs)
        write('rows-before.json', current_rows)
        write('before.json', dict(containers=[safe_container(row) for row in cs], workspace_sha256=workspace(), row_counts={table:len(value) for table,value in current_rows.items()}))
        capture_runtime_context(config)
        return dict(status='baseline_passed', containers=len(cs), idle=True, row_counts={table:len(value) for table,value in current_rows.items()})

    if mode == 'deploy':
        stopped = promoted = False
        backups = []
        try:
            run(['docker', 'tag', old['Image'], rollback])
            for database in [databases['acp'], databases['agentController'], databases['runtimeController']]:
                if database == databases['runtimeController']:
                    stopped = True  # A failed stop may already have stopped it.
                    write('deployment-stops.json', [stop(old)])
                path = runtime_output_file(config, database + '.dump')
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w+b') as stream:
                    info = os.fstat(stream.fileno())
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'backup must be a regular file with one link')
                    subprocess.run(['docker', 'exec', pg['Id'], 'pg_dump', '-U', config['database']['user'], '-Fc', database], stdout=stream, check=True, timeout=120)
                    stream.flush(); stream.seek(0)
                    subprocess.run(['docker', 'exec', '-i', pg['Id'], 'pg_restore', '--list'], stdin=stream, stdout=subprocess.DEVNULL, check=True, timeout=60)
                    stream.seek(0); data = stream.read()
                    backups.append(dict(database=database, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data)))
            write('backups.json', backups)
            promoted = True
            run(['docker', 'tag', candidate, local])
            deployed = up(candidate, old)
            write('deployed.private.json', deployed)
        except BaseException as error:
            if stopped or promoted:
                def restore():
                    if promoted:
                        run(['docker', 'tag', old['Image'], local])
                    try:
                        current = inspect(old['Id'])
                    except subprocess.CalledProcessError:
                        if not run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'], text=True).strip():
                            return up(old['Image'], None)
                        require(current_target['Id'] != old['Id'], 'old container missing without an observed Compose replacement')
                        return up(old['Image'], current_target)
                    service_matches(current, old['Image'], old)
                    require(current['Id'] == old['Id'], 'old container replaced before recovery')
                    if not current['State']['Running']:
                        run(['docker', 'start', old['Id']])
                    return wait(old['Id'], old['Image'], old)
                recover(error, 'rollback.private.json', restore)
            raise
        return dict(status='deployed', normal_stop=True, backups=len(backups), candidate=candidate)

    if mode == 'restart':
        try:
            write('restart-stops.json', [stop(old)])
            run(['docker', 'start', old['Id']])
            current = wait(old['Id'], candidate, old)
            require(current['State']['StartedAt'] != old['State']['StartedAt'], 'restart did not change start time')
            write('restarted.private.json', current)
        except BaseException as error:
            def restore():
                current = service_matches(inspect(old['Id']), candidate, old)
                require(current['Id'] == old['Id'], 'restart recovery container changed')
                if not current['State']['Running']:
                    run(['docker', 'start', old['Id']])
                return wait(old['Id'], candidate, old)
            recover(error, 'restart-recovery.private.json', restore)
            raise
        return dict(status='restart_passed', same_container=True, exit_code=0)

    if mode == 'after':
        current = {row['Name']:safe_container(row) for row in cs}
        unaffected = 0
        for saved in baseline['before']['containers']:
            new = current[saved['name']]
            owned = saved['name'] == '/' + name
            require(new['running'] and (not saved['health'] or new['health'] == 'healthy'), saved['name'] + ' not running and healthy')
            require(new['mounts'] == saved['mounts'] and new['networks'] == saved['networks'], saved['name'] + ' mounts or networks changed')
            require(new['image'] == (candidate if owned else saved['image']), saved['name'] + ' image changed')
            if not owned:
                require(all(new[key] == saved[key] for key in ('id', 'started', 'restarts')), saved['name'] + ' process changed')
                unaffected += 1
        current_rows = rows()
        require(current_rows == baseline['rows'], 'original ACP data changed')
        require(workspace() == baseline['before']['workspace_sha256'], 'retained workspace changed')
        idle()
        latest = service_matches(inspect(name), candidate, baseline['target'])
        require(latest['Id'] == old['Id'], 'service replaced during final reads')
        require(inspect(local)['Id'] == candidate, 'local image tag changed')
        require(inspect(rollback)['Id'] == baseline['target']['Image'], 'rollback image tag changed')
        healthy = sum(row['health'] == 'healthy' for row in current.values())
        require(healthy == config['expected']['healthy'], 'healthy container count mismatch')
        require(unaffected == config['expected']['unaffectedProcesses'], 'unaffected process count mismatch')
        report = dict(status='passed', containers=len(cs), healthy=healthy, unaffected_processes=unaffected,
            original_rows={table:len(value) for table,value in current_rows.items()}, workspace_unchanged=True,
            runtime_unchanged=True, active_runs=0, runtime_controller_image=candidate)
        write('after.json', report)
        return report
    raise ValueError(mode)


if __name__ == '__main__':
    configuration, selected_mode = development_arguments('runtime-20260921')
    with interruption_handlers():
        print(json.dumps(execute(configuration, selected_mode)))
