#!/usr/bin/env python3
"""Controller deployment/recovery acceptance on isolated Docker resources."""
import argparse
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

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/support/verification'))
from cleanup import command,write_report
from configuration import durable_path
spec=importlib.util.spec_from_file_location('cleanup_docker',Path(__file__).with_name('cleanup-docker.py'))
inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)
SERVICE='agent-controller'
ENTRY=ROOT/'tests/e2e/development/deployment/controller-20260921.py'
NORMAL='trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done'


def run(output,old_reference,postgres_reference):
    os.umask(0o077)
    before=inventory.inventory();write_report(output,'environment-before.json',before)
    old=command('docker','image','inspect','--format','{{.Id}}',old_reference)
    candidate=command('docker','image','inspect','--format','{{.Id}}',postgres_reference)
    assert old!=candidate
    project='antnest-controller-deploy-'+uuid.uuid4().hex[:12]
    agent='agent_'+uuid.uuid4().hex
    target,pg,rtc=project+'-'+SERVICE+'-1',project+'-postgres-1',project+'-runtime-controller-1'
    runtime,foreign,volume='antnest-runtime-'+agent,project+'-foreign',project+'-workspace'
    refs=dict(candidateImage=candidate,localTag=project+':local',candidateTag=project+':candidate',rollbackTag=project+':rollback')
    databases=dict(acp='fixture_acp',agentController='fixture_agent',runtimeController='fixture_runtime')
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
    def compose_file(folder,fail_candidate=False):
        def service(image,script):
            return dict(image=image,entrypoint=['/bin/sh','-c'],command=[script.replace('$','$$')],network_mode='none',stop_signal='SIGTERM',
                environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=project),tmpfs=['/var/lib/postgresql/data'],
                healthcheck=dict(test=['CMD-SHELL','exit 0'],interval='1s',timeout='1s',retries=3))
        config=dict(name=project,services={
            SERVICE:service(refs['localTag'],('if [ ! -x /usr/local/bin/node ]; then exit 7; fi; ' if fail_candidate else '')+NORMAL),
            'runtime-controller':service(old,NORMAL),
            'postgres':dict(image=candidate,network_mode='none',tmpfs=['/var/lib/postgresql/data'],
                environment=dict(POSTGRES_HOST_AUTH_METHOD='trust',POSTGRES_USER='fixture_admin',POSTGRES_DB=databases['acp']),
                healthcheck=dict(test=['CMD-SHELL','pg_isready -U fixture_admin -d fixture_acp'],interval='1s',timeout='1s',retries=30))})
        write_report(folder,'compose.json',config)
        return ['docker','compose','-p',project,'-f',str(folder/'compose.json')]
    def create_runtime():
        return run_command(['docker','run','-d','--name',runtime,'--network','none','--entrypoint','/bin/sh',
            '--label','io.antnest.agent-id='+agent,'--label','io.antnest.managed=runtime',
            '--label','io.antnest.runtime-controller-scope='+project,'--mount','type=volume,source='+volume+',target=/workspace',
            old,'-c',NORMAL],text=True).strip()
    def case(name,fail_candidate=False):
        folder=output/name;folder.mkdir();compose=compose_file(folder,fail_candidate)
        run_command(['docker','tag',old,refs['localTag']])
        if command('docker','image','ls','-q','--filter','reference='+refs['rollbackTag']):
            run_command(['docker','image','rm',refs['rollbackTag']])
        run_command(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','30',SERVICE],stderr=subprocess.STDOUT)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if all(inspect(value)['State'].get('Health',{}).get('Status')=='healthy' for value in [target,pg,rtc,foreign]):break
            time.sleep(0.2)
        else:raise RuntimeError('fixture health deadline')
        running=run_command(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
        rows=json.loads(run_command(['docker','inspect',*running]))
        config=dict(output=str(folder/'evidence'),project=project,compose=compose,images={SERVICE:refs},
            database=dict(container=pg,user='fixture_admin',names=databases),workspace=dict(container=runtime,path='/workspace',volume=volume),
            reports=dict(recovery=str(folder/'recovered-runtime.json')),
            expected=dict(containers=len(rows),healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in rows),otherContainersUnchanged=len(rows)-2))
        write_report(folder,'config.json',config)
        return folder,folder/'config.json',config
    try:
        for tag,image in [(refs['localTag'],old),(refs['candidateTag'],candidate)]:
            tags.append(tag);run_command(['docker','tag',image,tag])
        tags.append(refs['rollbackTag'])
        setup=output/'setup';setup.mkdir();compose=compose_file(setup)
        names.extend([pg,rtc,target])
        run_command(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','60'],stderr=subprocess.STDOUT)
        volumes.append(volume);run_command(['docker','volume','create',volume])
        names.append(runtime);create_runtime()
        names.append(foreign)
        run_command(['docker','run','-d','--name',foreign,'--network','none','--entrypoint','/bin/sh',
            '--label','com.docker.compose.project='+project+'-other','--label','com.docker.compose.service=other',
            '--health-cmd','exit 0','--health-interval','1s','--health-timeout','1s',old,'-c',NORMAL])
        for database in [databases['agentController'],databases['runtimeController']]:sql(databases['acp'],'CREATE DATABASE '+database)
        for table in ['acp_sessions','runs','session_messages','tool_attempts']:
            sql(databases['acp'],'CREATE TABLE '+table+"(id text PRIMARY KEY,state text); INSERT INTO "+table+" VALUES ('"+table+"-row','completed');")
        run_command(['docker','exec',runtime,'sh','-c','printf controller-fixture > /workspace/marker'])
        folder,path,config=case('normal')
        entry(path,'before',folder);entry(path,SERVICE,folder)
        before_id=inspect(runtime)['Id']
        run_command(['docker','stop','-t','10',before_id])
        stopped=inspect(before_id)['State'];assert stopped['ExitCode']==0 and not stopped['OOMKilled']
        run_command(['docker','rm','-v',before_id]);after_id=create_runtime()
        assert before_id!=after_id and run_command(['docker','exec',after_id,'cat','/workspace/marker'])==b'controller-fixture'
        recovery=dict(before_id=before_id,after_id=after_id,workspace=volume,configuration_preserved=True,workspace_bytes_preserved=True)
        write_report(folder,'recovered-runtime.json',{**recovery,'configuration_preserved':False})
        entry(path,'after',folder,'invalid-recovery',False)
        assert not (folder/'evidence/checks-after.json').exists()
        (folder/'recovered-runtime.json').write_text(json.dumps(recovery))
        entry(path,'after',folder)
        after=json.loads((folder/'evidence/checks-after.json').read_text())
        assert after['retained_runtime_rebuilt'] and after['other_platform_containers_unchanged']==config['expected']['otherContainersUnchanged']
        sql(databases['acp'],"UPDATE runs SET state='changed'")
        entry(path,'final',folder,'changed-original-row',False)
        assert not (folder/'evidence/checks-final.json').exists()
        sql(databases['acp'],"UPDATE runs SET state='completed'")
        for table in ['acp_sessions','runs','session_messages','tool_attempts']:
            sql(databases['acp'],"INSERT INTO "+table+" VALUES ('new-row','completed')")
        entry(path,'final',folder)
        final=json.loads((folder/'evidence/checks-final.json').read_text())
        assert final['original_rows_preserved']=={table:1 for table in ['acp_sessions','runs','session_messages','tool_attempts']}
        assert final['current_rows']=={table:2 for table in final['original_rows_preserved']}
        results.extend([dict(case='normal',all_modes=True,actual_runtime_rebuild=True,workspace_preserved=True,new_rows_allowed=True),
            dict(case='invalid-recovery',rejected=True),dict(case='changed-original-row',rejected=True)])

        folder,path,config=case('backup-failure')
        sql(databases['acp'],'DROP DATABASE '+databases['runtimeController'])
        entry(path,'before',folder,success=False)
        assert not (folder/'evidence/deployment-context.private.json').exists()
        assert inspect(target)['Image']==old
        results.append(dict(case='backup-failure',rejected=True,old_controller_unchanged=True))
        sql(databases['acp'],'CREATE DATABASE '+databases['runtimeController'])

        folder,path,config=case('candidate-exit',True)
        entry(path,'before',folder);entry(path,SERVICE,folder,success=False)
        recovered=json.loads((folder/'evidence/agent-controller-rollback.private.json').read_text())
        assert recovered['container']['Image']==old and recovered['container']['State']['Health']['Status']=='healthy'
        assert not (folder/'evidence/agent-controller-deployed.json').exists()
        results.append(dict(case='candidate-exit',old_image_recovered=True,still_failed=True))

        folder,path,config=case('missing-controller')
        entry(path,'before',folder)
        real_docker=shutil.which('docker');old_target=inspect(target)['Id']
        env={**os.environ,'PATH':str(ROOT/'tests/support/fixtures/controller-compose-failure')+os.pathsep+os.environ['PATH'],
            'CONTROLLER_FIXTURE_DOCKER':real_docker,'CONTROLLER_FIXTURE_MARKER':str(folder/'injected.json'),
            'CONTROLLER_FIXTURE_ID':old_target,'CONTROLLER_FIXTURE_NAME':target,'CONTROLLER_FIXTURE_PROJECT':project}
        entry(path,SERVICE,folder,success=False,env=env)
        assert (folder/'injected.json').exists()
        recovered=json.loads((folder/'evidence/agent-controller-rollback.private.json').read_text())['container']
        assert recovered['Image']==old and recovered['State']['Health']['Status']=='healthy' and recovered['Id']!=old_target
        assert not (folder/'evidence/agent-controller-deployed.json').exists()
        results.append(dict(case='missing-controller',old_image_recreated=True,still_failed=True))
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
    result=dict(status='passed',checks=results,scope='Actual Compose, PostgreSQL and workspace volume with owned shell services; all running containers including a foreign project. Not deployed Controller/Gateway business or Trace acceptance.')
    write_report(output,'result.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
    parser.add_argument('--old-image',default='node:24-bookworm-slim');parser.add_argument('--postgres-image',default='postgres:17-bookworm')
    args=parser.parse_args();output=durable_path(args.output)
    if output.exists() or Path(args.output).is_symlink():raise ValueError('fixture requires a fresh durable output directory')
    output.mkdir(parents=True,mode=0o700)
    print(json.dumps(run(output,args.old_image,args.postgres_image)))
