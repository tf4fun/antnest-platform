"""Temporal deployment with bound evidence and dependency-ordered recovery."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'support'/'verification'))
from development_configuration import development_arguments,read_json,require
from runtime_deployment import (TABLES,normalized_image_tag,runtime_output_file,safe_container,
    validate_compose_identity,validate_runtime_inspection,validate_workspace_identity,write_runtime_report)
from temporal_deployment import (SERVICES,DATABASE_ROLES,READINESS,capture_context,environment,
    recovery_override,snapshot_report,stage_records,validate_baseline)


@contextlib.contextmanager
def signals(recovering=False):
    def interrupt(signum,_frame):
        if not recovering:raise InterruptedError('Temporal deployment interrupted by signal '+str(signum))
    previous={sig:signal.signal(sig,interrupt) for sig in (signal.SIGINT,signal.SIGTERM)}
    try:yield
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)


def execute(config,mode):
    output=Path(config['output']);project=config['project'];compose=config['compose'];refs=config['images']['temporal'];databases=config['database']['names']
    names={s:project+'-'+s+'-1' for s in SERVICES}
    def run(args,**kwargs):return subprocess.check_output(args,timeout=kwargs.pop('timeout',200),**kwargs)
    def inspect(ref):return json.loads(run(['docker','inspect',ref]))[0]
    def image_id(ref):return ref if ref.startswith('sha256:') else inspect(ref)['Id']
    def write(name,value):write_runtime_report(config,name,value,fresh=name!='after.json')
    def effective():return json.loads(run(compose+['config','--format','json']))
    def containers():
        ids=run(['docker','ps','-aq'],text=True).split()
        return json.loads(run(['docker','inspect',*ids])) if ids else []
    cfg=effective();current=containers()
    require(len(current)==config['expected']['containers'],'global container count changed')
    for row in current:validate_runtime_inspection(row)
    require(len({r['Id'] for r in current})==len(current) and len({r['Name'] for r in current})==len(current),'duplicate live identity')
    by_name={row['Name'].lstrip('/'):row for row in current};targets={s:by_name[names[s]] for s in SERVICES}
    pg=by_name[config['database']['container']];runtime=by_name[config['workspace']['container']]
    require(cfg.get('name')==project,'Compose project mismatch')
    require(normalized_image_tag(cfg['services']['temporal']['image'])==normalized_image_tag(refs['localTag']),'Temporal Compose image mismatch')
    validate_compose_identity(pg,config,'postgres',config['database']['container'])
    rtc_name=project+'-runtime-controller-1';rtc=by_name[rtc_name];validate_compose_identity(rtc,config,'runtime-controller',rtc_name)
    environment(rtc,cfg['services']['runtime-controller']);scope=cfg['services']['runtime-controller']['environment']['ANTNEST_RUNTIME_CONTROLLER_SCOPE']
    validate_workspace_identity(runtime,config,scope)
    require(pg['State']['Running'] and runtime['State']['Running'],'database/workspace not running')
    baseline=None;stages={}
    if mode!='before':
        baseline=validate_baseline(config);require(cfg==baseline['compose'],'effective Compose changed')
        stages=stage_records(config,baseline,mode)
        expected={row['Name']:row for row in baseline['full']}
        for row in stages.values():expected[row['Name']]=row
        for name,row in expected.items():require(name.lstrip('/') in by_name and by_name[name.lstrip('/')]['Id']==row['Id'],'live container ID changed: '+name)
        if mode=='deploy':require({r['Name']:safe_container(r) for r in current}=={r['Name']:safe_container(r) for r in baseline['full']},'live deployment baseline changed')
    def matches(service,row,image,original=None,probe=None):
        validate_compose_identity(row,config,service,names[service]);environment(row,cfg['services'][service])
        require(row['Image']==image,'service image mismatch: '+service)
        if original:
            require(all(safe_container(row)[key]==safe_container(original)[key] for key in ('mounts','networks')),'service mounts/networks changed')
        if probe is not None:require(row['Config'].get('Healthcheck',{}).get('Test')==probe,'service healthcheck differs')
        return row
    for service,row in targets.items():
        original=baseline['targets'][service] if baseline else row
        expected_image=stages.get(service,original)['Image']
        bound=stages.get(service,original)
        matches(service,row,expected_image,original,bound['Config'].get('Healthcheck',{}).get('Test'))
        if mode!='resume':require(row['State']['Running'] and row['State'].get('Health',{}).get('Status')=='healthy','service not healthy: '+service)
    # Candidate is already prepared on the Temporal local tag before baseline.
    local_expected=targets['temporal']['Image'] if mode=='resume' and (output/'rollback.private.json').exists() else refs['candidateImage']
    require(image_id(refs['localTag'])==local_expected,'Temporal local tag changed')
    if 'candidateTag' in refs:require(image_id(refs['candidateTag'])==refs['candidateImage'],'Temporal candidate tag changed')
    require(image_id(cfg['services']['agent-controller']['image'])==targets['agent-controller']['Image'],'Agent Controller Compose image changed')
    for service in SERVICES:
        tag=config['images'][service]['rollbackTag']
        if mode=='before':require(not run(['docker','image','ls','-q','--filter','reference='+tag],text=True).strip(),'rollback tag already exists')
        else:require(image_id(tag)==baseline['targets'][service]['Image'],'rollback tag changed')
    def sql(database,query):return run(['docker','exec',pg['Id'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',config['database']['user'],'-d',database,'-c',query],text=True).strip()
    def rows():return {t:json.loads(sql(databases['acp'],f"SELECT coalesce(jsonb_object_agg(id,md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {t} t")) for t in TABLES}
    def idle():
        require(sql(databases['acp'],"SELECT count(*) FROM runs WHERE state IN ('admitting','running')")=='0','active ACP runs')
        require(sql(databases['agentController'],"SELECT count(*) FROM agent_controller.agents WHERE active_operation_request_id <> ''")=='0','active Agent operation')
    def workspace():
        script='cd /workspace || exit $?; manifest=$(find . -type f -exec sha256sum {} +) || exit $?; if [ -n "$manifest" ]; then printf \'%s\\n\' "$manifest" | LC_ALL=C sort; fi'
        return hashlib.sha256(run(['docker','exec',runtime['Id'],'sh','-c',script])).hexdigest()
    def wait(service,row,image,probe=None):
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            live=matches(service,inspect(row['Id']),image,row,probe);require(live['Id']==row['Id'],'container changed while waiting')
            if live['State']['Running'] and live['State'].get('Health',{}).get('Status')=='healthy':return live
            time.sleep(1)
        raise RuntimeError(service+' health deadline exceeded')
    def stop(service,row):
        run(['docker','stop','-t','30',row['Id']]);live=validate_compose_identity(inspect(row['Id']),config,service,names[service])
        require(live['Id']==row['Id'],'container changed while stopping');state=live['State']
        require(state['Status']=='exited' and state['ExitCode']==0 and not state['OOMKilled'],'service did not stop normally')
        return dict(service=service,exit=state['ExitCode'],finished=state['FinishedAt'])
    observed=dict(targets)
    def up(service,image,expected,override=None):
        require(effective()==cfg,'effective Compose changed before update')
        if expected is None:
            require(not run(['docker','ps','-aq','--filter','name=^/'+names[service]+'$'],text=True).strip(),'unexpected service appeared')
            for saved in current:
                other=next((s for s in SERVICES if saved['Name']=='/'+names[s]),None)
                if other==service:continue
                bound=observed[other] if other else saved
                live=inspect(bound['Id']);require(live['Id']==bound['Id'] and live['Name']==bound['Name'],'recovery daemon identity changed')
        else:
            live=validate_compose_identity(inspect(names[service]),config,service,names[service]);require(live['Id']==expected['Id'],'service replaced before update')
        if not override:require(image_id(cfg['services'][service]['image'])==image,'Compose image changed before update')
        argv=compose+(['-f',str(override)] if override else [])
        try:run(argv+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','180',service],stderr=subprocess.STDOUT)
        except BaseException as error:
            try:observed[service]=validate_compose_identity(inspect(names[service]),config,service,names[service])
            except BaseException as observation_error:error.add_note('Cannot bind Compose result: '+str(observation_error))
            raise
        observed[service]=validate_compose_identity(inspect(names[service]),config,service,names[service])
        probe=(baseline['targets'][service]['Config']['Healthcheck']['Test'] if override else READINESS if service=='temporal' else None)
        matches(service,observed[service],image,baseline['targets'][service],probe)
        return wait(service,observed[service],image,probe)
    def recover(error,filename,action):
        with signals(recovering=True):
            try:write(filename,dict(status='recovered',original_error=str(error),containers=action()))
            except BaseException as failure:raise RuntimeError('Temporal recovery failed: '+str(failure)) from error
    def restart_known(service,row):
        live=matches(service,inspect(row['Id']),row['Image'],row,row['Config']['Healthcheck']['Test'])
        require(live['Id']==row['Id'],'recovery ID changed')
        if not live['State']['Running']:run(['docker','start',row['Id']])
        return wait(service,row,row['Image'],row['Config']['Healthcheck']['Test'])
    def restore_deployment():
        # A partially restarted consumer must stop before replacing its dependency.
        try:agent=inspect(observed['agent-controller']['Id'])
        except subprocess.CalledProcessError:
            require(not run(['docker','ps','-aq','--filter','name=^/'+names['agent-controller']+'$'],text=True).strip(),'unbound Agent replacement during recovery');agent=None
        if agent and agent['State']['Running']:stop('agent-controller',agent)
        run(['docker','tag',baseline['targets']['temporal']['Image'],refs['localTag']])
        restored={};override=None
        for service in SERVICES:
            old=baseline['targets'][service]
            try:inspect(old['Id'])
            except subprocess.CalledProcessError:
                exists=run(['docker','ps','-aq','--filter','name=^/'+names[service]+'$'],text=True).strip()
                expected=observed[service] if exists else None
                require(not exists or expected['Id']!=old['Id'],'old service missing without observed replacement')
                if override is None:
                    write('rollback-compose.private.json',recovery_override(baseline));override=output/'rollback-compose.private.json'
                restored[service]=up(service,old['Image'],expected,override)
            else:restored[service]=restart_known(service,old)
            observed[service]=restored[service]
        return restored
    if mode!='resume':idle()
    if mode=='before':
        saved=rows();manifest=workspace()
        write('compose.private.json',cfg);write('containers.private.json',current);write('rows-before.json',saved)
        write('before.json',dict(containers=[safe_container(row) for row in current],workspace_sha256=manifest,row_counts={t:len(v) for t,v in saved.items()}))
        # Structural validation precedes rollback-tag creation.
        validate_baseline(config)
        for service in SERVICES:require(not run(['docker','image','ls','-q','--filter','reference='+config['images'][service]['rollbackTag']],text=True).strip(),'rollback tag appeared during capture')
        for service in SERVICES:run(['docker','tag',targets[service]['Image'],config['images'][service]['rollbackTag']])
        capture_context(config)
        return dict(status='baseline_passed',containers=len(current),idle=True,row_counts={t:len(v) for t,v in saved.items()})
    if mode=='deploy':
        try:
            stops=[stop(service,targets[service]) for service in reversed(SERVICES)];write('deployment-stops.json',stops);backups=[]
            for role in DATABASE_ROLES:
                database=databases[role];path=runtime_output_file(config,database+'.dump')
                fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'w+b') as stream:
                    subprocess.run(['docker','exec',pg['Id'],'pg_dump','-U',config['database']['user'],'-Fc',database],stdout=stream,check=True,timeout=120)
                    stream.flush();stream.seek(0);subprocess.run(['docker','exec','-i',pg['Id'],'pg_restore','--list'],stdin=stream,stdout=subprocess.DEVNULL,check=True,timeout=60)
                    stream.seek(0);data=stream.read();backups.append(dict(database=database,sha256=hashlib.sha256(data).hexdigest(),bytes=len(data)))
            write('backups.json',backups)
            for service in SERVICES:
                row=up(service,refs['candidateImage'] if service=='temporal' else targets[service]['Image'],targets[service])
                write(service+'-deployed.private.json',row)
        except BaseException as error:recover(error,'rollback.private.json',restore_deployment);raise
        return dict(status='deployed',normal_stops=stops,backups=len(backups))
    if mode=='restart':
        try:
            stops=[stop(service,targets[service]) for service in reversed(SERVICES)];write('restart-stops.json',stops);restarted={}
            for service in SERVICES:
                run(['docker','start',targets[service]['Id']]);row=wait(service,targets[service],targets[service]['Image'],targets[service]['Config']['Healthcheck']['Test'])
                require(row['State']['StartedAt']!=targets[service]['State']['StartedAt'],'restart did not change start time');restarted[service]=row
            write('restarted.private.json',restarted)
        except BaseException as error:
            recover(error,'restart-recovery.private.json',lambda:{service:restart_known(service,targets[service]) for service in SERVICES});raise
        return dict(status='restart_passed',same_containers=True,normal_stops=stops)
    if mode=='resume':
        temporal=wait('temporal',targets['temporal'],targets['temporal']['Image'],targets['temporal']['Config']['Healthcheck']['Test'])
        try:
            run(['docker','start',targets['agent-controller']['Id']]);agent=wait('agent-controller',targets['agent-controller'],targets['agent-controller']['Image'])
            write('resumed.private.json',dict(temporal=temporal,**{'agent-controller':agent}))
        except BaseException as error:
            def resume_recovery():
                ready=wait('temporal',temporal,temporal['Image'],temporal['Config']['Healthcheck']['Test'])
                return dict(temporal=ready,**{'agent-controller':restart_known('agent-controller',targets['agent-controller'])})
            recover(error,'resume-recovery.private.json',resume_recovery);raise
        return dict(status='resumed',temporal_ready_before_controller=True)
    if mode=='after':
        counts=snapshot_report(config,baseline['before']['containers'],[safe_container(row) for row in current]);latest=rows()
        require(latest==baseline['rows'],'original ACP data changed');require(workspace()==baseline['before']['workspace_sha256'],'retained workspace changed');idle()
        for service in SERVICES:
            row=matches(service,inspect(names[service]),targets[service]['Image'],baseline['targets'][service],READINESS if service=='temporal' else None)
            require(row['Id']==targets[service]['Id'],'service changed during final reads')
        require(image_id(refs['localTag'])==refs['candidateImage'],'Temporal local tag changed')
        report=dict(status='passed',**counts,original_rows={t:len(v) for t,v in latest.items()},workspace_unchanged=True,runtime_unchanged=True,active_runs=0,temporal_image=refs['candidateImage'])
        write('after.json',report);return report
    raise ValueError(mode)


if __name__=='__main__':
    config,mode=development_arguments('temporal-20260921')
    with signals():print(json.dumps(execute(config,mode)))
