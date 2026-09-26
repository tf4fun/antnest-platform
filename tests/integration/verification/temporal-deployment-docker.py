#!/usr/bin/env python3
"""Temporal dependency-order deployment acceptance on isolated Docker resources."""
import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/support/verification'))
from cleanup import command,write_report
from configuration import durable_path
spec=importlib.util.spec_from_file_location('cleanup_docker',Path(__file__).with_name('cleanup-docker.py'))
inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)
SERVICE='temporal'
SERVICES=('temporal','agent-controller')
ENTRY=ROOT/'tests/e2e/development/deployment/temporal-20260921.py'
NORMAL='touch /tmp/temporal-ready; trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done'


def run(output,old_reference,postgres_reference):
    os.umask(0o077)
    before=inventory.inventory();write_report(output,'environment-before.json',before)
    old=command('docker','image','inspect','--format','{{.Id}}',old_reference)
    postgres=command('docker','image','inspect','--format','{{.Id}}',postgres_reference)
    candidate=None
    project='antnest-temporal-deploy-'+uuid.uuid4().hex[:12]
    agent='agent_'+uuid.uuid4().hex
    target,pg,rtc=project+'-'+SERVICE+'-1',project+'-postgres-1',project+'-runtime-controller-1'
    runtime,foreign,volume='antnest-runtime-'+agent,project+'-foreign',project+'-workspace'
    candidate_tag=project+':candidate'
    images={'temporal':dict(candidateImage=None,localTag=project+':local',rollbackTag=project+':rollback'),'agent-controller':dict(rollbackTag=project+':agent-rollback')}
    agent_name=project+'-agent-controller-1'
    databases=dict(temporal='fixture_temporal',temporalVisibility='fixture_visibility',agentController='fixture_agent',acp='fixture_acp')
    names=[];volumes=[];tags=[];results=[];cancelled=None
    def cancel(signum,_frame):
        nonlocal cancelled
        cancelled=signum
    handlers={sig:signal.signal(sig,cancel) for sig in (signal.SIGINT,signal.SIGTERM)}
    def checkpoint():
        if cancelled:raise InterruptedError(cancelled)
    def run_command(args,**kwargs):
        checkpoint()
        return subprocess.check_output(args,timeout=kwargs.pop('timeout',180),**kwargs)
    def inspect(name):return json.loads(run_command(['docker','inspect',name]))[0]
    def sql(database,query):
        return run_command(['docker','exec',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','fixture_admin','-d',database,'-c',query],text=True).strip()
    def entry(path,mode,folder,label=None,success=True,env=None):
        checkpoint()
        label=label or mode
        result=subprocess.run(['node',str(ROOT/'tests/support/run-command.mjs'),'--output',str(folder),'--name',label,
            '--timeout-ms','360000','--grace-ms','60000','--',sys.executable,'-B',str(ENTRY),'--config',str(path),mode],
            capture_output=True,text=True,env=env)
        assert (result.returncode==0)==success,str(folder)+' '+label+' unexpected exit '+str(result.returncode)
        return result.returncode
    def compose_file(folder,fail_service=None):
        def service(image,script):
            return dict(image=image,entrypoint=['/bin/sh','-c'],command=[script.replace('$','$$')],network_mode='none',stop_signal='SIGTERM',
                environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=project),tmpfs=['/var/lib/postgresql/data'],
                healthcheck=dict(test=['CMD-SHELL','exit 0'],interval='1s',timeout='1s',retries=3))
        config=dict(name=project,services={
            'temporal':service(images['temporal']['localTag'],('if [ -f /etc/temporal/readiness.sh ]; then exit 7; fi; ' if fail_service=='temporal' else '')+NORMAL),
            'agent-controller':service(old,NORMAL),
            'runtime-controller':service(old,NORMAL),
            'postgres':dict(image=postgres,network_mode='none',tmpfs=['/var/lib/postgresql/data'],
                environment=dict(POSTGRES_HOST_AUTH_METHOD='trust',POSTGRES_USER='fixture_admin',POSTGRES_DB=databases['acp']),
                healthcheck=dict(test=['CMD-SHELL','pg_isready -U fixture_admin -d fixture_acp'],interval='1s',timeout='1s',retries=30))})
        config['services']['temporal']['healthcheck']['test']=['CMD','sh','/etc/temporal/readiness.sh']
        write_report(folder,'compose.json',config)
        return ['docker','compose','-p',project,'-f',str(folder/'compose.json')]
    def create_runtime():
        return run_command(['docker','run','-d','--name',runtime,'--network','none','--entrypoint','/bin/sh',
            '--label','io.antnest.agent-id='+agent,'--label','io.antnest.managed=runtime',
            '--label','io.antnest.runtime-controller-scope='+project,'--mount','type=volume,source='+volume+',target=/workspace',
            '-e','PATH=/tmp/hash-probe:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',old,'-c',NORMAL],text=True).strip()
    def case(name,fail_service=None):
        folder=output/name;folder.mkdir();compose=compose_file(folder,fail_service)
        run_command(['docker','tag',candidate,images['temporal']['localTag']])
        for refs in images.values():
            if command('docker','image','ls','-q','--filter','reference='+refs['rollbackTag']):run_command(['docker','image','rm',refs['rollbackTag']])
        old_config=json.loads((folder/'compose.json').read_text())
        old_config['services']['temporal']['image']=old
        old_config['services']['temporal']['healthcheck']['test']=['CMD-SHELL','exit 0']
        write_report(folder,'old-compose.json',old_config)
        setup_compose=['docker','compose','-p',project,'-f',str(folder/'old-compose.json')]
        run_command(setup_compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','30',*SERVICES],stderr=subprocess.STDOUT)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if all(inspect(value)['State'].get('Health',{}).get('Status')=='healthy' for value in [target,agent_name,pg,rtc,foreign]):break
            time.sleep(0.2)
        else:raise RuntimeError('fixture health deadline')
        running=run_command(['docker','ps','-aq'],text=True).splitlines()
        rows=json.loads(run_command(['docker','inspect',*running]))
        config=dict(output=str(folder/'evidence'),project=project,compose=compose,images=images,
            database=dict(container=pg,user='fixture_admin',names=databases),workspace=dict(container=runtime,path='/workspace',volume=volume),
            expected=dict(containers=len(rows),healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in rows),unaffectedProcesses=len(rows)-2))
        write_report(folder,'config.json',config)
        return folder,folder/'config.json',config
    try:
        # Build the candidate from a single owned container, without pulls or a
        # daemon build context. The old image deliberately lacks readiness.sh.
        build_name=project+'-image-fixture';names.append(build_name);tags.append(candidate_tag)
        run_command(['docker','run','-d','--name',build_name,'--network','none','--entrypoint','/bin/sh',old,'-c',NORMAL])
        run_command(['docker','exec',build_name,'mkdir','-p','/etc/temporal'])
        run_command(['docker','cp',str(ROOT/'tests/support/fixtures/temporal-deployment/readiness.sh'),build_name+':/etc/temporal/readiness.sh'])
        run_command(['docker','stop','-t','10',build_name])
        stopped=inspect(build_name)['State'];assert stopped['ExitCode']==0 and not stopped['OOMKilled']
        candidate=run_command(['docker','commit',build_name,candidate_tag],text=True).strip()
        assert candidate!=old
        run_command(['docker','rm','-v',build_name])
        images['temporal']['candidateImage']=candidate
        tags.extend([images['temporal']['localTag'],*[refs['rollbackTag'] for refs in images.values()]])
        run_command(['docker','tag',candidate,images['temporal']['localTag']])
        setup=output/'setup';setup.mkdir();compose=compose_file(setup)
        names.extend([pg,rtc,target,agent_name])
        run_command(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','60'],stderr=subprocess.STDOUT)
        volumes.append(volume);run_command(['docker','volume','create',volume])
        names.append(runtime);create_runtime()
        names.append(foreign)
        run_command(['docker','run','-d','--name',foreign,'--network','none','--entrypoint','/bin/sh',
            '--label','com.docker.compose.project='+project+'-other','--label','com.docker.compose.service=other',
            '--health-cmd','exit 0','--health-interval','1s','--health-timeout','1s',old,'-c',NORMAL])
        for role in ['temporal','temporalVisibility','agentController']:sql(databases['acp'],'CREATE DATABASE '+databases[role])
        sql(databases['agentController'],"CREATE SCHEMA agent_controller; CREATE TABLE agent_controller.agents(id text, active_operation_request_id text); INSERT INTO agent_controller.agents VALUES ('retained','');")
        for table in ['acp_sessions','runs','session_messages','tool_attempts']:sql(databases['acp'],'CREATE TABLE '+table+"(id text PRIMARY KEY,state text); INSERT INTO "+table+" VALUES ('baseline','completed');")
        run_command(['docker','exec',runtime,'sh','-c','printf temporal-fixture > /workspace/marker'])
        run_command(['docker','exec','-i',runtime,'sh','-c','mkdir -p /workspace/nested; cat > /workspace/nested/note'],input=b'\0nested\n')
        manifest=''.join(sorted(hashlib.sha256(data).hexdigest()+'  ./'+name+'\n' for name,data in [('marker',b'temporal-fixture'),('nested/note',b'\0nested\n')])).encode()
        runtime_id=inspect(runtime)['Id'];foreign_id=inspect(foreign)['Id']
        folder,path,config=case('normal')
        run_command(['docker','exec',target,'sh','-c','test ! -e /etc/temporal/readiness.sh'])
        old_probe=inspect(target)['Config']['Healthcheck']['Test'];assert old_probe!=['CMD','sh','/etc/temporal/readiness.sh']
        entry(path,'before',folder);entry(path,'deploy',folder)
        assert json.loads((folder/'evidence/before.json').read_text())['workspace_sha256']==hashlib.sha256(manifest).hexdigest()
        backups=json.loads((folder/'evidence/backups.json').read_text());assert len(backups)==4
        assert [item['database'] for item in backups]==list(databases.values())
        for item in backups:
            data=(folder/'evidence'/(item['database']+'.dump')).read_bytes()
            assert data.startswith(b'PGDMP') and len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256']
        deployed={s:inspect(project+'-'+s+'-1') for s in SERVICES}
        entry(path,'restart',folder)
        for s in SERVICES:
            row=inspect(project+'-'+s+'-1');assert row['Id']==deployed[s]['Id'] and row['State']['StartedAt']!=deployed[s]['State']['StartedAt']
        run_command(['docker','stop','-t','10',deployed['agent-controller']['Id']])
        stopped=inspect(deployed['agent-controller']['Id'])['State'];assert stopped['ExitCode']==0 and not stopped['OOMKilled']
        entry(path,'resume',folder)
        # Preserve the original all-daemon assertion: retained stopped services
        # are never started simply to make this owned fixture's after pass.
        assert any(not row['Running'] for row in before['rows'])
        entry(path,'after',folder,'global-after-stopped-retained',False)
        assert not (folder/'evidence/after.json').exists()
        assert inspect(runtime)['Id']==runtime_id and inspect(foreign)['Id']==foreign_id
        results.extend([dict(case='normal',before_deploy_restart_resume=True,four_archives=True,old_probe_to_readiness=True,same_id_restart=True),dict(case='global-after-stopped-retained',rejected=True)])

        folder,path,config=case('backup-failure')
        entry(path,'before',folder);sql(databases['acp'],'DROP DATABASE '+databases['temporalVisibility'])
        entry(path,'deploy',folder,success=False)
        restored=json.loads((folder/'evidence/rollback.private.json').read_text())['containers']
        assert all(restored[s]['Image']==old and restored[s]['State']['Health']['Status']=='healthy' for s in SERVICES)
        sql(databases['acp'],'CREATE DATABASE '+databases['temporalVisibility'])
        results.append(dict(case='backup-failure',both_old_services_recovered=True,still_failed=True))

        folder,path,config=case('candidate-exit','temporal')
        entry(path,'before',folder);entry(path,'deploy',folder,success=False)
        restored=json.loads((folder/'evidence/rollback.private.json').read_text())['containers']
        assert restored['temporal']['Image']==old and restored['temporal']['Config']['Healthcheck']['Test']==old_probe
        assert all(restored[s]['State']['Health']['Status']=='healthy' for s in SERVICES)
        results.append(dict(case='candidate-exit',old_image_and_probe_recreated=True,consumer_ready_after_dependency=True,still_failed=True))

        for service in SERVICES:
            folder,path,config=case('missing-'+service);entry(path,'before',folder)
            name=project+'-'+service+'-1';old_id=inspect(name)['Id']
            env={**os.environ,'PATH':str(ROOT/'tests/support/fixtures/controller-compose-failure')+os.pathsep+os.environ['PATH'],
                'CONTROLLER_FIXTURE_DOCKER':shutil.which('docker'),'CONTROLLER_FIXTURE_MARKER':str(folder/'injected.json'),
                'CONTROLLER_FIXTURE_ID':old_id,'CONTROLLER_FIXTURE_NAME':name,'CONTROLLER_FIXTURE_PROJECT':project,'CONTROLLER_FIXTURE_SERVICE':service}
            entry(path,'deploy',folder,success=False,env=env)
            restored=json.loads((folder/'evidence/rollback.private.json').read_text())['containers']
            assert (folder/'injected.json').exists() and restored[service]['Id']!=old_id
            assert all(restored[s]['Image']==old and restored[s]['State']['Health']['Status']=='healthy' for s in SERVICES)
            assert restored['temporal']['Config']['Healthcheck']['Test']==old_probe
            assert inspect(runtime)['Id']==runtime_id and inspect(foreign)['Id']==foreign_id
            results.append(dict(case='missing-'+service,old_image_recreated=True,old_probe_preserved=True,still_failed=True))
        for tool in ['find','sha256sum']:
            folder,path,config=case(tool+'-failure')
            run_command(['docker','exec',runtime,'mkdir','-p','/tmp/hash-probe'])
            run_command(['docker','cp',str(ROOT/'tests/support/fixtures/temporal-deployment/failing-command.sh'),runtime+':/tmp/hash-probe/'+tool])
            run_command(['docker','exec',runtime,'chmod','700','/tmp/hash-probe/'+tool])
            try:
                entry(path,'before',folder,success=False)
                assert not (folder/'evidence/deployment-context.private.json').exists()
                assert all(inspect(project+'-'+service+'-1')['Image']==old for service in SERVICES)
                results.append(dict(case=tool+'-failure',rejected=True,no_baseline_success=True))
            finally:run_command(['docker','exec',runtime,'rm','-f','/tmp/hash-probe/'+tool])
    finally:
        try:
            errors=[]
            def cleanup(*args):
                try:return command(*args)
                except Exception as error:
                    errors.append(dict(command=list(args),error=str(error)));return None
            for name in reversed(names):
                found=cleanup('docker','ps','-aq','--filter','name=^/'+name+'$')
                if found or found is None:
                    cleanup('docker','stop','-t','10',name);cleanup('docker','rm','-v',name)
            for value in reversed(volumes):cleanup('docker','volume','rm',value)
            for value in reversed(tags):
                found=cleanup('docker','image','ls','-q','--filter','reference='+value)
                if found or found is None:cleanup('docker','image','rm',value)
            try:
                after=inventory.inventory();write_report(output,'environment-after.json',after)
                write_report(output,'isolation.json',dict(unchanged=before==after,resource_counts={key:len(value) for key,value in after['resources'].items()}))
                if before!=after:errors.append(dict(error='retained environment changed'))
            except Exception as error:errors.append(dict(error='final inventory: '+str(error)))
            write_report(output,'cleanup.json',dict(status='failed' if errors else 'passed',errors=errors))
            assert not errors,'cleanup failed; see cleanup.json'
        finally:
            for sig,handler in handlers.items():signal.signal(sig,handler)
    checkpoint()
    result=dict(status='passed',checks=results,scope='Actual Compose and four PostgreSQL archives with owned shell dependency/consumer services and a complete workspace volume. All-daemon after correctly rejects retained stopped containers; its positive is covered by the complete component model. No real Temporal server or retained service deployment, Gateway, Provider or Trace replay.')
    write_report(output,'result.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
    parser.add_argument('--old-image',default='node:24.21.0-bookworm-slim');parser.add_argument('--postgres-image',default='postgres:17.11-bookworm')
    args=parser.parse_args();output=durable_path(args.output)
    if output.exists() or Path(args.output).is_symlink():raise ValueError('fixture requires a fresh durable output directory')
    output.mkdir(parents=True,mode=0o700)
    print(json.dumps(run(output,args.old_image,args.postgres_image)))
