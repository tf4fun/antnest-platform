#!/usr/bin/env python3
"""Dual-Controller deployment/final acceptance on isolated Docker resources."""
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
SERVICES=('agent-controller','runtime-controller')
ENTRY=ROOT/'tests/e2e/development/deployment/controller-20260917.py'
NORMAL='trap "exit 0" TERM; while :; do sleep 0.1 & wait "$!"; done'


def run(output,old_reference,postgres_reference):
    os.umask(0o077)
    before=inventory.inventory();write_report(output,'environment-before.json',before)
    old=command('docker','image','inspect','--format','{{.Id}}',old_reference)
    candidate=command('docker','image','inspect','--format','{{.Id}}',postgres_reference)
    assert old!=candidate
    project='antnest-dual-controller-'+uuid.uuid4().hex[:12]
    agent='agent_'+uuid.uuid4().hex
    target,pg,rtc=project+'-'+SERVICE+'-1',project+'-postgres-1',project+'-runtime-controller-1'
    runtime,foreign,volume='antnest-runtime-'+agent,project+'-foreign',project+'-workspace'
    images={service:dict(candidateImage=candidate,localTag=project+'-'+service+':local',candidateTag=project+'-'+service+':candidate',rollbackTag=project+'-'+service+':rollback') for service in SERVICES}
    session=str(uuid.uuid4());temporary='agent_'+uuid.uuid4().hex
    marker='0917 fixture marker\n'
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
    def compose_file(folder,fail_service=None):
        def service(image,script):
            return dict(image=image,entrypoint=['/bin/sh','-c'],command=[script.replace('$','$$')],network_mode='none',stop_signal='SIGTERM',
                environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=project),tmpfs=['/var/lib/postgresql/data'],
                healthcheck=dict(test=['CMD-SHELL','exit 0'],interval='1s',timeout='1s',retries=3))
        config=dict(name=project,services={
            **{owned:service(images[owned]['localTag'],('if [ ! -x /usr/local/bin/node ]; then exit 7; fi; ' if fail_service==owned else '')+NORMAL) for owned in SERVICES},
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
    def case(name,fail_service=None):
        folder=output/name;folder.mkdir();compose=compose_file(folder,fail_service)
        for refs in images.values():
            run_command(['docker','tag',old,refs['localTag']])
            if command('docker','image','ls','-q','--filter','reference='+refs['rollbackTag']):
                run_command(['docker','image','rm',refs['rollbackTag']])
        run_command(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','30',*SERVICES],stderr=subprocess.STDOUT)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if all(inspect(value)['State'].get('Health',{}).get('Status')=='healthy' for value in [target,pg,rtc,foreign]):break
            time.sleep(0.2)
        else:raise RuntimeError('fixture health deadline')
        running=run_command(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
        rows=json.loads(run_command(['docker','inspect',*running]))
        config=dict(output=str(folder/'evidence'),project=project,compose=compose,images=images,
            database=dict(container=pg,user='fixture_admin',names=databases),workspace=dict(container=runtime,path='/workspace',volume=volume),
            reports={key:str(folder/(key+'.json')) for key in ('browser','agentBefore','agentFinal','temporaryAgent','lifecycle')},
            expected=dict(containers=len(rows),healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in rows),otherContainersUnchanged=len(rows)-2))
        write_report(folder,'browser.json',dict(agent_id=agent,session_id=session,checks=['check-'+str(i) for i in range(8)],browser_errors=0,workspace_file='/workspace/acceptance-note.txt',workspace_marker=marker))
        for key in ('agentBefore','agentFinal'):write_report(folder,key+'.json',dict(checked_at=key,agent_id=agent,state='retained'))
        write_report(folder,'temporaryAgent.json',dict(agent_id=temporary))
        write_report(folder,'lifecycle.json',dict(status='passed',lifecycle=[dict(evidence=dict(warnings=['clock skew adjustment disabled fixture']))]))
        write_report(folder,'config.json',config)
        return folder,folder/'config.json',config
    try:
        for refs in images.values():
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
        schemas=dict(acp_sessions='id text PRIMARY KEY,agent_id text,cwd text',
            runs='id text PRIMARY KEY,state text,session_id text,stop_reason text,executor_state text',
            session_messages='id text PRIMARY KEY,session_id text,kind text,payload jsonb',
            tool_attempts='id text PRIMARY KEY,run_id text,tool_name text,state text,tool_effect_state text,tool_call_id text')
        for table,columns in schemas.items():
            sql(databases['acp'],'CREATE TABLE '+table+'('+columns+'); INSERT INTO '+table+"(id) VALUES ('baseline');")
        run_command(['docker','exec','-i',runtime,'sh','-c','cat > /workspace/acceptance-note.txt'],input=marker.encode())
        runtime_id=inspect(runtime)['Id'];foreign_id=inspect(foreign)['Id']
        folder,path,config=case('normal')
        entry(path,'before',folder)
        for service in SERVICES:entry(path,service,folder)
        entry(path,'after',folder)
        sql(databases['acp'],"INSERT INTO acp_sessions VALUES ('"+session+"','"+agent+"','/workspace')")
        for index in range(3):
            run_id='run-'+str(index)
            sql(databases['acp'],"INSERT INTO runs VALUES ('"+run_id+"','completed','"+session+"','end_turn','quiescent')")
            sql(databases['acp'],"INSERT INTO tool_attempts VALUES ('attempt-"+str(index)+"','"+run_id+"','shell','completed','settled','call-"+str(index)+"')")
        def rejection(index):
            payload=json.dumps(dict(status='failed',toolCallId='rejected-'+str(index),content=[dict(text='Tool arguments do not match the declared schema: invalid')]))
            sql(databases['acp'],"INSERT INTO session_messages VALUES ('rejection-"+str(index)+"','"+session+"','tool_call','"+payload+"'::jsonb)")
        rejection(0)
        entry(path,'final',folder,'one-rejection',False)
        assert not (folder/'evidence/containers-final.json').exists()
        rejection(1)
        run_command(['docker','exec','-i',runtime,'sh','-c','cat > /workspace/acceptance-note.txt'],input=marker.rstrip().encode())
        entry(path,'final',folder,'marker-whitespace',False)
        assert not (folder/'evidence/checks-final.json').exists()
        run_command(['docker','exec','-i',runtime,'sh','-c','cat > /workspace/acceptance-note.txt'],input=marker.encode())
        entry(path,'final',folder)
        final=json.loads((folder/'evidence/checks-final.json').read_text())
        assert final['preflight_rejections']==2 and final['new_completed_runs']==3 and final['completed_runtime_calls']==3
        assert final['original_rows_preserved']=={table:1 for table in schemas}
        assert inspect(runtime)['Id']==runtime_id and inspect(foreign)['Id']==foreign_id
        results.extend([dict(case='normal',all_modes=True,both_controllers_updated=True,runtime_and_foreign_ids_preserved=True,new_rows_allowed=True),
            dict(case='one-rejection',rejected=True),dict(case='marker-whitespace',rejected=True)])

        folder,path,config=case('reverse-order')
        entry(path,'before',folder)
        for service in reversed(SERVICES):entry(path,service,folder)
        entry(path,'after',folder);entry(path,'final',folder)
        results.append(dict(case='reverse-order',all_modes=True))

        folder,path,config=case('backup-failure')
        sql(databases['acp'],'DROP DATABASE '+databases['runtimeController'])
        entry(path,'before',folder,success=False)
        assert not (folder/'evidence/deployment-context.private.json').exists()
        assert all(inspect(project+'-'+s+'-1')['Image']==old for s in SERVICES)
        results.append(dict(case='backup-failure',rejected=True,both_controllers_unchanged=True))
        sql(databases['acp'],'CREATE DATABASE '+databases['runtimeController'])

        for service in SERVICES:
            sibling=next(s for s in SERVICES if s!=service)
            for kind in ('candidate-exit','missing-controller'):
                folder,path,config=case(service+'-'+kind,service if kind=='candidate-exit' else None)
                entry(path,'before',folder);entry(path,sibling,folder)
                sibling_row=inspect(project+'-'+sibling+'-1');name=project+'-'+service+'-1';old_id=inspect(name)['Id']
                env=None
                if kind=='missing-controller':
                    env={**os.environ,'PATH':str(ROOT/'tests/support/fixtures/controller-compose-failure')+os.pathsep+os.environ['PATH'],
                        'CONTROLLER_FIXTURE_DOCKER':shutil.which('docker'),'CONTROLLER_FIXTURE_MARKER':str(folder/'injected.json'),
                        'CONTROLLER_FIXTURE_ID':old_id,'CONTROLLER_FIXTURE_NAME':name,'CONTROLLER_FIXTURE_PROJECT':project,'CONTROLLER_FIXTURE_SERVICE':service}
                entry(path,service,folder,success=False,env=env)
                recovered=json.loads((folder/'evidence'/(service+'-rollback.private.json')).read_text())['container']
                assert recovered['Image']==old and recovered['State']['Health']['Status']=='healthy'
                if kind=='missing-controller':assert (folder/'injected.json').exists() and recovered['Id']!=old_id
                assert not (folder/'evidence'/(service+'-deployed.json')).exists()
                unchanged=inspect(project+'-'+sibling+'-1')
                assert (unchanged['Id'],unchanged['Image'],unchanged['State']['StartedAt'],unchanged['RestartCount'])==(sibling_row['Id'],sibling_row['Image'],sibling_row['State']['StartedAt'],sibling_row['RestartCount'])
                assert inspect(runtime)['Id']==runtime_id and inspect(foreign)['Id']==foreign_id
                results.append(dict(case=service+'-'+kind,old_image_recovered=True,sibling_candidate_unchanged=True,still_failed=True))
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
    result=dict(status='passed',checks=results,scope='Actual dual-service Compose, PostgreSQL backups/final queries and workspace marker using owned shell services, including a foreign project. Saved browser/lifecycle reports and synthetic ACP rows are fixtures; no deployed Gateway, Provider or Trace replay.')
    write_report(output,'result.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
    parser.add_argument('--old-image',default='node:24-bookworm-slim');parser.add_argument('--postgres-image',default='postgres:17-bookworm')
    args=parser.parse_args();output=durable_path(args.output)
    if output.exists() or Path(args.output).is_symlink():raise ValueError('fixture requires a fresh durable output directory')
    output.mkdir(parents=True,mode=0o700)
    print(json.dumps(run(output,args.old_image,args.postgres_image)))
