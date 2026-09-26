#!/usr/bin/env python3
"""Runtime deployment CLI on owned PostgreSQL, shell services and workspace."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/verification'))
from cleanup import command, write_report
from configuration import durable_path
from runtime_deployment import safe_container

spec = importlib.util.spec_from_file_location('cleanup_docker', Path(__file__).with_name('cleanup-docker.py'))
inventory_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory_module)
ENTRY = ROOT / 'tests/e2e/development/deployment/runtime-20260921.py'
SERVICE = 'runtime-controller'
NORMAL = 'trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done'


def run(output, old_reference, postgres_reference):
    os.umask(0o077)
    old_image = command('docker','image','inspect','--format','{{.Id}}',old_reference)
    candidate = command('docker','image','inspect','--format','{{.Id}}',postgres_reference)
    assert old_image != candidate, 'fixture images must differ'
    before = inventory_module.inventory()
    write_report(output,'environment-before.json',before)
    project = 'antnest-runtime-deploy-' + uuid.uuid4().hex[:12]
    agent = 'agent_' + uuid.uuid4().hex
    pg, target = project+'-postgres-1', project+'-'+SERVICE+'-1'
    runtime, volume = 'antnest-runtime-'+agent, project+'-workspace'
    refs = dict(localTag=project+':local',candidateTag=project+':candidate',rollbackTag=project+':rollback',candidateImage=candidate)
    databases = dict(acp='fixture_acp',agentController='fixture_agent',runtimeController='fixture_runtime')
    names, tags, volumes, results = [], [], [], []
    cancelled = None
    def cancel(signum,_frame):
        nonlocal cancelled
        cancelled = signum
    handlers = {sig:signal.signal(sig,cancel) for sig in (signal.SIGINT,signal.SIGTERM)}
    def checkpoint():
        if cancelled:
            raise InterruptedError(cancelled)
    def execute(args,**kwargs):
        checkpoint()
        return subprocess.check_output(args,timeout=kwargs.pop('timeout',240),**kwargs)
    def sql(database,query):
        return execute(['docker','exec',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','fixture_admin','-d',database,'-c',query],text=True).strip()
    def entry(config,mode,folder,expected_success=True,env=None):
        checkpoint()
        # The shared runner owns the CLI process group, including Docker and
        # Compose descendants, and reaps it before fixture teardown begins.
        completed=subprocess.run(['node',str(ROOT/'tests/support/run-command.mjs'),'--output',str(folder),'--name',mode,
            '--timeout-ms','480000','--grace-ms','60000','--',sys.executable,'-B',str(ENTRY),'--config',str(config),mode],capture_output=True,text=True,env=env)
        assert (completed.returncode==0)==expected_success, str(folder)+' '+mode+' unexpected exit '+str(completed.returncode)
        return completed.returncode
    def compose_file(folder,fail_candidate=False):
        script = (('if [ ! -x /usr/local/bin/node ]; then exit 7; fi; ' if fail_candidate else '') + NORMAL).replace('$','$$')
        config = dict(name=project,services={
            SERVICE:dict(image=refs['localTag'],entrypoint=['/bin/sh','-c'],command=[script],network_mode='none',stop_signal='SIGTERM',
                environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=project),tmpfs=['/var/lib/postgresql/data'],
                healthcheck=dict(test=['CMD-SHELL','exit 0'],interval='1s',timeout='1s',retries=3)),
            'postgres':dict(image=candidate,network_mode='none',tmpfs=['/var/lib/postgresql/data'],
                environment=dict(POSTGRES_HOST_AUTH_METHOD='trust',POSTGRES_USER='fixture_admin',POSTGRES_DB=databases['acp']),
                healthcheck=dict(test=['CMD-SHELL','pg_isready -U fixture_admin -d fixture_acp'],interval='1s',timeout='1s',retries=30))
        })
        write_report(folder,'compose.json',config)
        return ['docker','compose','-p',project,'-f',str(folder/'compose.json')]
    def case(name,fail_candidate=False):
        folder=output/name; folder.mkdir()
        compose=compose_file(folder,fail_candidate)
        execute(['docker','tag',old_image,refs['localTag']])
        if execute(['docker','image','ls','-q','--filter','reference='+refs['rollbackTag']],text=True).strip():
            execute(['docker','image','rm',refs['rollbackTag']])
        execute(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','30',SERVICE],stderr=subprocess.STDOUT)
        ids=execute(['docker','ps','-aq'],text=True).split()
        rows=json.loads(execute(['docker','inspect',*ids]))
        config=dict(output=str(folder/'evidence'),project=project,database=dict(container=pg,user='fixture_admin',names=databases),
            images={SERVICE:refs},compose=compose,workspace=dict(container=runtime,path='/workspace',volume=volume),
            expected=dict(containers=len(rows),healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in rows),unaffectedProcesses=len(rows)-1))
        write_report(folder,'config.json',config)
        return folder,folder/'config.json',config
    try:
        for tag,image in [(refs['localTag'],old_image),(refs['candidateTag'],candidate)]:
            tags.append(tag); execute(['docker','tag',image,tag])
        tags.append(refs['rollbackTag'])
        setup=output/'setup'; setup.mkdir()
        compose=compose_file(setup)
        names.extend([pg,target])
        execute(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','60'],stderr=subprocess.STDOUT)
        volumes.append(volume); execute(['docker','volume','create',volume])
        names.append(runtime)
        execute(['docker','run','-d','--name',runtime,'--network','none','--entrypoint','/bin/sh',
            '--label','io.antnest.agent-id='+agent,'--label','io.antnest.managed=runtime',
            '--label','io.antnest.runtime-controller-scope='+project,'--mount','type=volume,source='+volume+',target=/workspace',
            '-e','PATH=/tmp/hash-probe:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',old_image,'-c',NORMAL])
        for database in [databases['agentController'],databases['runtimeController']]:
            sql(databases['acp'],'CREATE DATABASE '+database)
        for table in ['acp_sessions','runs','session_messages','tool_attempts']:
            sql(databases['acp'],'CREATE TABLE '+table+'(id text PRIMARY KEY,state text); INSERT INTO '+table+" VALUES ('"+table+"-row','completed');")
        sql(databases['agentController'],"CREATE SCHEMA agent_controller; CREATE TABLE agent_controller.agents(id text PRIMARY KEY,active_operation_request_id text); INSERT INTO agent_controller.agents VALUES ('agent','');")
        sql(databases['runtimeController'],"CREATE TABLE fixture(id text PRIMARY KEY); INSERT INTO fixture VALUES ('runtime');")

        folder,path,config=case('normal')
        entry(path,'before',folder)
        baseline=json.loads((folder/'evidence/before.json').read_text())
        assert baseline['workspace_sha256']==hashlib.sha256(b'').hexdigest(), 'empty manifest bytes changed'
        entry(path,'deploy',folder)
        deployed=json.loads((folder/'evidence/deployed.private.json').read_text())
        assert deployed['Image']==candidate
        backups=json.loads((folder/'evidence/backups.json').read_text())
        assert [row['database'] for row in backups]==list(databases.values())
        for row in backups:
            archive=folder/'evidence'/(row['database']+'.dump'); data=archive.read_bytes()
            assert data.startswith(b'PGDMP') and row['bytes']==len(data) and row['sha256']==hashlib.sha256(data).hexdigest()
            assert archive.stat().st_mode&0o777==0o600
        entry(path,'restart',folder)
        restarted=json.loads((folder/'evidence/restarted.private.json').read_text())
        assert restarted['Id']==deployed['Id'] and restarted['State']['StartedAt']!=deployed['State']['StartedAt']
        # The original after contract is global. Stopped retained containers
        # must remain stopped, so this shared daemon is a negative after case.
        retained_stopped=any(not row['Running'] for row in before['rows'])
        after_code=entry(path,'after',folder,expected_success=not retained_stopped)
        if retained_stopped:
            assert not (folder/'evidence/after.json').exists()
            assert 'not running and healthy' in (folder/'after.log').read_text()
        results.append(dict(case='normal',deployment=True,same_container_restart=True,backups=3,empty_manifest=True,after_exit=after_code,global_after_expected_failure=retained_stopped))

        execute(['docker','exec',runtime,'sh','-c',"printf first > /workspace/first; printf second > /workspace/second"])
        folder,path,config=case('backup-failure')
        entry(path,'before',folder)
        manifest=execute(['docker','exec',runtime,'sh','-c','cd /workspace && sha256sum first second | sed "s/  /  .\\//" | LC_ALL=C sort'])
        assert json.loads((folder/'evidence/before.json').read_text())['workspace_sha256']==hashlib.sha256(manifest).hexdigest()
        sql(databases['acp'],'DROP DATABASE '+databases['runtimeController'])
        entry(path,'deploy',folder,False)
        recovered=json.loads((folder/'evidence/rollback.private.json').read_text())
        assert recovered['container']['Image']==old_image and recovered['container']['State']['Health']['Status']=='healthy'
        assert not (folder/'evidence/deployed.private.json').exists()
        results.append(dict(case='backup-failure',old_service_recovered=True,still_failed=True,whole_workspace=True))
        sql(databases['acp'],'CREATE DATABASE '+databases['runtimeController'])

        folder,path,config=case('candidate-exit',True)
        entry(path,'before',folder); entry(path,'deploy',folder,False)
        recovered=json.loads((folder/'evidence/rollback.private.json').read_text())
        assert recovered['container']['Image']==old_image and recovered['container']['State']['Health']['Status']=='healthy'
        assert not (folder/'evidence/deployed.private.json').exists()
        results.append(dict(case='candidate-exit',old_image_recovered=True,still_failed=True))

        folder,path,config=case('missing-controller')
        entry(path,'before',folder)
        baseline=json.loads((folder/'evidence/containers.private.json').read_text())
        old_target=next(row for row in baseline if row['Name']=='/'+target)
        marker=folder/'injected.json'
        env={**os.environ,'PATH':str(ROOT/'tests/support/fixtures/controller-compose-failure')+os.pathsep+os.environ['PATH'],
            'CONTROLLER_FIXTURE_DOCKER':shutil.which('docker'),'CONTROLLER_FIXTURE_MARKER':str(marker),
            'CONTROLLER_FIXTURE_ID':old_target['Id'],'CONTROLLER_FIXTURE_NAME':target,
            'CONTROLLER_FIXTURE_PROJECT':project,'CONTROLLER_FIXTURE_SERVICE':SERVICE}
        entry(path,'deploy',folder,False,env=env)
        assert json.loads(marker.read_text())==dict(container=old_target['Id'],phase='remove-before-create')
        rollback=json.loads((folder/'evidence/rollback.private.json').read_text())
        recovered=rollback['container']
        assert recovered['Image']==old_image and recovered['Id']!=old_target['Id']
        assert recovered['State']['Running'] and recovered['State']['Health']['Status']=='healthy'
        assert '73' in rollback['original_error']
        assert not (folder/'evidence/deployed.private.json').exists()
        assert json.loads(execute(['docker','image','inspect',refs['localTag']]))[0]['Id']==old_image
        assert recovered['Mounts']==old_target['Mounts']
        assert sorted(recovered['NetworkSettings']['Networks'])==sorted(old_target['NetworkSettings']['Networks'])
        others=[row for row in baseline if row['Id']!=old_target['Id']]
        latest=json.loads(execute(['docker','inspect',*[row['Id'] for row in others]]))
        assert [safe_container(row) for row in latest]==[safe_container(row) for row in others]
        assert json.loads(execute(['docker','volume','inspect',volume]))[0]['Name']==volume
        results.append(dict(case='missing-controller',old_image_recreated=True,still_failed=True,other_containers_unchanged=True,workspace_volume_preserved=True))

        for tool in ['find','sha256sum']:
            folder,path,config=case(tool+'-failure')
            execute(['docker','exec',runtime,'sh','-c','mkdir -p /tmp/hash-probe; printf \'#!/bin/sh\\nprintf partial\\nexit 23\\n\' > /tmp/hash-probe/'+tool+'; chmod 700 /tmp/hash-probe/'+tool])
            try:
                entry(path,'before',folder,False)
                assert not (folder/'evidence/deployment-context.private.json').exists()
                results.append(dict(case=tool+'-failure',rejected=True))
            finally:
                execute(['docker','exec',runtime,'rm','-f','/tmp/hash-probe/'+tool])
    finally:
        try:
            # Cleanup is owned by this harness, even after an interrupted CLI.
            errors=[]
            def cleanup_call(*args):
                try:
                    return command(*args)
                except Exception as error:
                    errors.append(dict(command=list(args),error=str(error)))
                    return None
            for name in reversed(names):
                found=cleanup_call('docker','ps','-aq','--filter','name=^/'+name+'$')
                if found or found is None:
                    cleanup_call('docker','stop','-t','10',name)
                    cleanup_call('docker','rm','-v',name)
            for volume in reversed(volumes):
                cleanup_call('docker','volume','rm',volume)
            for tag in reversed(tags):
                found=cleanup_call('docker','image','ls','-q','--filter','reference='+tag)
                if found or found is None:
                    cleanup_call('docker','image','rm',tag)
            try:
                after=inventory_module.inventory()
                write_report(output,'environment-after.json',after)
                write_report(output,'isolation.json',dict(unchanged=before==after,resource_counts={key:len(value) for key,value in after['resources'].items()}))
                if before!=after:
                    errors.append(dict(error='retained resources or image references changed'))
            except Exception as error:
                errors.append(dict(error='final inventory: '+str(error)))
            write_report(output,'cleanup.json',dict(status='failed' if errors else 'passed',errors=errors))
            assert not errors, 'fixture cleanup failed; see cleanup.json'
        finally:
            for sig,handler in handlers.items():
                signal.signal(sig,handler)
    checkpoint()
    report=dict(status='passed',checks=results,scope='Owned shell Controller and Runtime, real PostgreSQL/archive/Compose/normal-stop checks. Full global positive after is covered by the component model; stopped retained containers are unchanged.')
    write_report(output,'result.json',report)
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--old-image',default='node:24.21.0-bookworm-slim')
    parser.add_argument('--postgres-image',default='postgres:17.11-bookworm')
    args=parser.parse_args()
    output=durable_path(args.output)
    if output.exists() or Path(args.output).is_symlink():
        raise ValueError('fixture requires a fresh durable output directory')
    output.mkdir(parents=True,mode=0o700)
    print(json.dumps(run(output,args.old_image,args.postgres_image)))
