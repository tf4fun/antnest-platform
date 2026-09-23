"""Shared bounded Controller deployment driver; profiles retain their own acceptance."""
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from development_configuration import development_arguments, read_json, require
from controller_deployment import (SERVICE,TABLES,capture_controller_context,controller_environment,
    controller_recovery,controller_safe,controller_snapshot_report,validate_controller_baseline,controller_services,controller_stages)
from runtime_deployment import (normalized_image_tag,runtime_output_file,write_runtime_report,
    validate_runtime_inspection,validate_compose_identity,validate_workspace_identity)


@contextlib.contextmanager
def signals(recovering=False):
    def interrupt(signum,_frame):
        if not recovering:raise InterruptedError('Controller deployment interrupted by signal '+str(signum))
    previous={sig:signal.signal(sig,interrupt) for sig in (signal.SIGINT,signal.SIGTERM)}
    try:yield
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)


def execute(config,mode):
    services=controller_services(config);dual=len(services)==2
    service=mode if mode in services else SERVICE
    output=Path(config['output']);project=config['project'];compose=config['compose']
    refs=config['images'][service];name=project+'-'+service+'-1'
    def run(args,**kwargs):return subprocess.check_output(args,timeout=kwargs.pop('timeout',180),**kwargs)
    def inspect(ref):return json.loads(run(['docker','inspect',ref]))[0]
    def write(filename,value):write_runtime_report(config,filename,value)
    def effective_compose():return json.loads(run(compose+['config','--format','json']))
    def containers():
        names=run(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
        return json.loads(run(['docker','inspect',*names])) if names else []
    cfg=effective_compose();current=containers()
    require(len(current)==config['expected']['containers'],'running container count changed')
    for row in current:
        validate_runtime_inspection(row);require(row['State']['Running'],'running snapshot includes stopped container')
    require(len({row['Id'] for row in current})==len(current) and len({row['Name'] for row in current})==len(current),'duplicate live container identity')
    by_name={row['Name'].lstrip('/'):row for row in current}
    required=[project+'-agent-controller-1',config['database']['container'],config['workspace']['container'],project+'-runtime-controller-1']
    require(all(item in by_name for item in required),'required live role missing')
    _,pg,runtime,rtc=[by_name[item] for item in required]
    target=by_name[name]
    require(cfg.get('name')==project,'effective Compose project mismatch')
    for owned in services:
        row=by_name[project+'-'+owned+'-1']
        require(normalized_image_tag(cfg['services'][owned]['image'])==normalized_image_tag(config['images'][owned]['localTag']),'Compose image mismatch')
        controller_environment(row,cfg,config,owned)
        require(row['State'].get('Health',{}).get('Status')=='healthy','Controller unhealthy')
    validate_compose_identity(pg,config,'postgres',required[1])
    validate_compose_identity(rtc,config,'runtime-controller',required[3])
    scope=cfg['services']['runtime-controller']['environment']['ANTNEST_RUNTIME_CONTROLLER_SCOPE']
    require(dict(value.split('=',1) for value in rtc['Config']['Env']).get('ANTNEST_RUNTIME_CONTROLLER_SCOPE')==scope,'Runtime Controller scope changed')
    validate_workspace_identity(runtime,config,scope)
    baseline=recovery=None;stages={};expected_rows={row['Name']:row for row in current}
    if mode!='before':
        baseline=validate_controller_baseline(config)
        require(cfg==baseline['compose'],'effective Compose configuration changed')
        stages=controller_stages(config,baseline,mode in ('after','final'))
        if mode in ('after','final') and not dual:recovery=controller_recovery(config,baseline)
        expected_rows={row['Name']:row for row in baseline['full']}
        for row in stages.values():expected_rows[row['Name']]=row
        for saved in baseline['full']:
            live=by_name.get(saved['Name'].lstrip('/'))
            require(live is not None,'baseline running container missing')
            expected_id=(recovery['after_id'] if recovery and saved['Id']==baseline['runtime']['Id'] else expected_rows[saved['Name']]['Id'])
            require(live['Id']==expected_id,'container identity changed: '+saved['Name'])
        if mode in services:
            require({row['Name']:controller_safe(row) for row in current}=={name:controller_safe(row) for name,row in expected_rows.items()},'live baseline changed')
    for owned in services:
        owned_refs=config['images'][owned];row=by_name[project+'-'+owned+'-1']
        expected_image=owned_refs['candidateImage'] if owned in stages else (baseline['targets'][owned]['Image'] if baseline else row['Image'])
        require(row['Image']==expected_image,'Controller image mismatch')
        require(inspect(owned_refs['candidateTag'])['Id']==owned_refs['candidateImage'],'candidate tag changed')
        require(inspect(owned_refs['localTag'])['Id']==expected_image,'local tag changed')
        if mode=='before':
            require(not run(['docker','image','ls','-q','--filter','reference='+owned_refs['rollbackTag']],text=True).strip(),'rollback tag already exists')
        else:require(inspect(owned_refs['rollbackTag'])['Id']==baseline['targets'][owned]['Image'],'rollback tag changed')

    def sql(query):
        return run(['docker','exec','-i',pg['Id'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',config['database']['user'],'-d',config['database']['names']['acp']],input=query.encode()).decode().strip()
    def idle():require(sql("SELECT count(*) FROM runs WHERE state IN ('admitting','running');")=='0','active ACP runs')
    def rows():return {table:json.loads(sql(f"SELECT coalesce(jsonb_object_agg(id, md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {table} t;")) for table in TABLES}
    idle()

    if mode=='before':
        original=rows();backups=[]
        write('database-before.json',original)
        for role in ('agentController','runtimeController','acp'):
            database=config['database']['names'][role];filename=database+'-before.dump'
            path=runtime_output_file(config,filename)
            fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w+b') as archive:
                subprocess.run(['docker','exec',pg['Id'],'pg_dump','-U',config['database']['user'],'-Fc',database],stdout=archive,check=True,timeout=120)
                archive.flush();archive.seek(0)
                subprocess.run(['docker','exec','-i',pg['Id'],'pg_restore','--list'],stdin=archive,stdout=subprocess.DEVNULL,check=True,timeout=60)
                archive.seek(0);data=archive.read()
                backups.append(dict(database=database,file=filename,sha256=hashlib.sha256(data).hexdigest(),bytes=len(data)))
        source=run(['git','rev-parse','HEAD'],text=True).strip()
        write('backups.json',backups);write('compose.private.json',cfg);write('containers.private.json',current)
        write('containers-before.json',[controller_safe(row) for row in current])
        write('baseline.json',dict(checked_at=datetime.now(timezone.utc).isoformat(),source=source,
            candidates={owned:[config['images'][owned]['candidateTag'],config['images'][owned]['candidateImage']] for owned in services},environment_match=True,active_runs=0,data_counts={key:len(value) for key,value in original.items()}))
        # Preserve the baseline's rollback reference without replacing a tag
        # created by another operation during the database backups.
        for owned in services:
            require(not run(['docker','image','ls','-q','--filter','reference='+config['images'][owned]['rollbackTag']],text=True).strip(),'rollback tag appeared during backups')
        for owned in services:
            run(['docker','tag',by_name[project+'-'+owned+'-1']['Image'],config['images'][owned]['rollbackTag']])
        capture_controller_context(config)
        return dict(status='passed',containers=len(current),environment_match=True,backups=len(backups),data_counts={key:len(value) for key,value in original.items()})

    if mode in services:
        observed=target
        def candidate_matches(row,image):
            controller_environment(row,cfg,config,service)
            require(row['Image']==image,'Controller image mismatch')
            require(row['State']['Running'] and row['State'].get('Health',{}).get('Status')=='healthy','Controller unhealthy')
            for key in ('mounts','networks'):
                require(controller_safe(row)[key]==controller_safe(target)[key],'Controller '+key+' changed')
            return row
        def up(image,expected):
            nonlocal observed
            require(effective_compose()==cfg,'effective Compose changed before update')
            if expected is None:
                require(not run(['docker','ps','-aq','--filter','name=^/'+name+'$'],text=True).strip(),'unexpected Controller appeared before recovery')
                for saved in expected_rows.values():
                    if saved['Id']!=target['Id']:
                        live=inspect(saved['Id'])
                        require(live['Id']==saved['Id'] and live['Name']==saved['Name'],'recovery daemon/container identity changed')
            else:
                live=validate_compose_identity(inspect(name),config,service,name)
                require(live['Id']==expected['Id'],'Controller replaced before update')
            try:
                run(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120',service],stderr=subprocess.STDOUT,timeout=150)
            except BaseException as error:
                try:observed=validate_compose_identity(inspect(name),config,service,name)
                except BaseException as inspection_error:error.add_note('Cannot bind Compose result: '+str(inspection_error))
                raise
            observed=validate_compose_identity(inspect(name),config,service,name)
            return candidate_matches(observed,image)
        def restore():
            run(['docker','tag',baseline['targets'][service]['Image'],refs['localTag']])
            try:old=inspect(target['Id'])
            except subprocess.CalledProcessError:
                if not run(['docker','ps','-aq','--filter','name=^/'+name+'$'],text=True).strip():
                    return up(baseline['targets'][service]['Image'],None)
                require(observed['Id']!=target['Id'],'old Controller missing without an observed Compose replacement')
                return up(baseline['targets'][service]['Image'],observed)
            validate_compose_identity(old,config,service,name)
            if not old['State']['Running']:run(['docker','start',old['Id']])
            deadline=time.monotonic()+120
            while time.monotonic()<deadline:
                old=inspect(target['Id'])
                if old['State']['Running'] and old['State'].get('Health',{}).get('Status')=='healthy':
                    return candidate_matches(old,baseline['targets'][service]['Image'])
                time.sleep(1)
            raise RuntimeError('Controller recovery health deadline exceeded')
        try:
            run(['docker','tag',refs['candidateImage'],refs['localTag']])
            deployed=up(refs['candidateImage'],target)
            write(service+'-deployed.private.json',deployed)
            write(service+'-deployed.json',controller_safe(deployed))
        except BaseException as error:
            with signals(recovering=True):
                try:write(service+'-rollback.private.json',dict(status='recovered',original_error=str(error),container=restore()))
                except BaseException as recovery_error:raise RuntimeError('Controller recovery failed: '+str(recovery_error)) from error
            raise
        return dict(service=service,healthy=True,image=deployed['Image'])

    if mode in ('after','final'):
        live=[controller_safe(row) for row in current]
        snapshot=controller_snapshot_report(config,baseline['safe'],live,recovery)
        latest=rows()
        for table,saved in baseline['rows'].items():
            require(all(latest[table].get(key)==digest for key,digest in saved.items()),table+': original rows changed')
        idle()
        report=dict(status='passed',**snapshot,original_rows_preserved={key:len(value) for key,value in baseline['rows'].items()},
            current_rows={key:len(value) for key,value in latest.items()},active_runs=0)
        if dual and mode=='final':
            from controller17_acceptance import controller17_acceptance
            report.update(controller17_acceptance(config,sql,run,runtime))
            idle()
        write('containers-'+mode+'.json',live);write('checks-'+mode+'.json',report)
        return report
    raise ValueError(mode)
