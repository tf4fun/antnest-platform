"""Pure contracts for single- and dual-Controller deployment profiles."""
from datetime import datetime
import hashlib
from pathlib import Path

from configuration import durable_path
from development_configuration import file_path, object_fields, read_json, require, text, validate_workspace
from runtime_deployment import (normalized_image_tag, runtime_output_file, write_runtime_report,
    validate_runtime_inspection, validate_compose_identity, validate_workspace_identity)

SERVICE='agent-controller'
TABLES=('acp_sessions','runs','session_messages','tool_attempts')
BASELINE_FILES=('containers-before.json','database-before.json','baseline.json','compose.private.json','containers.private.json','backups.json')


def controller_safe(row):
    return dict(name=row['Name'].lstrip('/'),id=row['Id'],image=row['Image'],health=row['State'].get('Health',{}).get('Status'),
        mounts=[{key:mount.get(key) for key in ('Type','Name','Source','Destination','RW')} for mount in sorted(row['Mounts'],key=lambda item:item['Destination'])],
        networks=sorted(row['NetworkSettings']['Networks']))


def archives(config):
    return [config['database']['names'][role]+'-before.dump' for role in ('agentController','runtimeController','acp')]


def sha(path):
    return hashlib.sha256(file_path(path).read_bytes()).hexdigest()


def controller_context(config):
    argv=config['compose']
    compose_inputs={str(file_path(argv[i+1])):sha(argv[i+1]) for i in range(2,len(argv),2) if argv[i] in ('-f','--file','--env-file')}
    return dict(version=1,configuration=config,compose_inputs=compose_inputs,
        baseline_files={name:sha(Path(config['output'])/name) for name in (*BASELINE_FILES,*archives(config))})


def controller_services(config):
    return tuple(service for service in ('agent-controller','runtime-controller') if service in config['images'])


def controller_environment(row,compose,config,service=SERVICE):
    validate_compose_identity(row,config,service,config['project']+'-'+service+'-1')
    values=row['Config'].get('Env')
    require(isinstance(values,list) and all(isinstance(value,str) and '=' in value for value in values),'controller environment missing')
    pairs=[value.split('=',1) for value in values]
    require(len({key for key,_ in pairs})==len(pairs),'ambiguous controller environment')
    actual=dict(pairs);expected=compose['services'][service]
    require(all(actual.get(key)==str(value) for key,value in expected['environment'].items()),'controller environment differs')
    require(row['Config'].get('Healthcheck',{}).get('Test')==expected['healthcheck']['test'],'controller healthcheck differs')


def validate_controller_baseline(config):
    output=Path(config['output'])
    safe,rows,summary,compose,full,backups=[read_json(output/name) for name in BASELINE_FILES]
    require(isinstance(full,list) and len(full)==config['expected']['containers'],'baseline running container count mismatch')
    for row in full:
        validate_runtime_inspection(row)
        require(row['State']['Running'],'baseline includes a stopped container')
    require(len({row['Id'] for row in full})==len(full) and len({row['Name'] for row in full})==len(full),'duplicate baseline identity')
    require(safe==[controller_safe(row) for row in full],'full and safe baseline disagree')
    require(isinstance(rows,dict) and set(rows)==set(TABLES),'expected four table snapshots')
    for table in TABLES:
        require(isinstance(rows[table],dict),'invalid table snapshot')
        for key,value in rows[table].items():
            text(key,'row ID');text(value,'row MD5',r'[a-f0-9]{32}')
    object_fields(summary,'baseline summary',{'checked_at','source','candidates','environment_match','active_runs','data_counts'})
    try:datetime.fromisoformat(text(summary['checked_at'],'checked_at').replace('Z','+00:00'))
    except ValueError as error:raise ValueError('invalid baseline timestamp') from error
    text(summary['source'],'source commit',r'(?:[a-f0-9]{40}|[a-f0-9]{64})')
    services=controller_services(config)
    require(summary['candidates']=={service:[config['images'][service]['candidateTag'],config['images'][service]['candidateImage']] for service in services},'baseline candidate mismatch')
    require(summary['environment_match'] is True and type(summary['active_runs']) is int and summary['active_runs']==0,'invalid baseline acceptance flags')
    require(summary['data_counts']=={key:len(value) for key,value in rows.items()},'baseline row counts mismatch')
    require(isinstance(compose,dict) and compose.get('name')==config['project'],'baseline Compose project mismatch')
    by_name={row['Name'].lstrip('/'):row for row in full}
    names=[config['project']+'-'+SERVICE+'-1',config['database']['container'],config['workspace']['container'],config['project']+'-runtime-controller-1']
    require(all(name in by_name for name in names),'required baseline role missing')
    target,pg,runtime,rtc=[by_name[name] for name in names]
    targets={}
    for service in services:
        refs=config['images'][service];effective=compose['services'][service]
        require(normalized_image_tag(effective['image'])==normalized_image_tag(refs['localTag']),'baseline Compose image mismatch')
        require(isinstance(effective.get('environment'),dict),'baseline Compose environment missing')
        require(isinstance(effective.get('healthcheck'),dict) and isinstance(effective['healthcheck'].get('test'),list) and effective['healthcheck']['test'],'baseline Compose healthcheck missing')
        row=by_name[config['project']+'-'+service+'-1'];targets[service]=row
        controller_environment(row,compose,config,service)
        require(row['State'].get('Health',{}).get('Status')=='healthy','baseline Controller unhealthy')
    validate_compose_identity(pg,config,'postgres',names[1])
    validate_compose_identity(rtc,config,'runtime-controller',names[3])
    scope=text(compose['services']['runtime-controller']['environment'].get('ANTNEST_RUNTIME_CONTROLLER_SCOPE'),'Runtime Controller scope',r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
    require(dict(value.split('=',1) for value in rtc['Config']['Env']).get('ANTNEST_RUNTIME_CONTROLLER_SCOPE')==scope,'Runtime Controller scope differs')
    validate_workspace_identity(runtime,config,scope)
    expected_archives=archives(config)
    require(isinstance(backups,list) and len(backups)==3,'expected three archive records')
    for archive,name in zip(backups,expected_archives):
        object_fields(archive,'archive',{'database','file','sha256','bytes'})
        require(archive['file']==name and archive['database']+'-before.dump'==name,'archive database/order mismatch')
        path=file_path(output/name)
        require(type(archive['bytes']) is int and archive['bytes']>0 and archive['bytes']==path.stat().st_size,'archive byte count mismatch')
        require(archive['sha256']==sha(path),'archive digest mismatch')
    return dict(safe=safe,rows=rows,summary=summary,compose=compose,full=full,target=target,postgres=pg,runtime=runtime,runtime_controller=rtc,scope=scope,targets=targets)


def controller_recovery(config,baseline):
    recovery=read_json(config['reports']['recovery'])
    object_fields(recovery,'recovered Runtime',{'before_id','after_id','workspace','configuration_preserved','workspace_bytes_preserved'})
    for key in ('before_id','after_id'):text(recovery[key],key,r'[a-f0-9]{64}')
    require(recovery['before_id']!=recovery['after_id'],'Runtime was not rebuilt')
    require(recovery['before_id']==baseline['runtime']['Id'],'recovery does not bind the baseline Runtime')
    require(recovery['workspace']==config['workspace']['volume'],'recovery workspace differs')
    require(recovery['configuration_preserved'] is True and recovery['workspace_bytes_preserved'] is True,'recovery did not preserve configuration and workspace')
    require(recovery['after_id'] not in {row['Id'] for row in baseline['full']},'recovery reuses a baseline container ID')
    return recovery


def controller_stages(config,baseline,require_all=False):
    stages={}
    for service in controller_services(config):
        path=Path(config['output'])/(service+'-deployed.private.json')
        safe_path=path.with_name(service+'-deployed.json')
        if not path.exists() and not safe_path.exists():
            require(not require_all,'missing deployment record: '+service)
            continue
        full=read_json(path);validate_runtime_inspection(full)
        controller_environment(full,baseline['compose'],config,service)
        require(full['Image']==config['images'][service]['candidateImage'] and full['State']['Running'] and full['State'].get('Health',{}).get('Status')=='healthy','invalid candidate deployment record')
        require(read_json(safe_path)==controller_safe(full),'deployment records disagree')
        for key in ('mounts','networks'):
            require(controller_safe(full)[key]==controller_safe(baseline['targets'][service])[key],'deployed '+key+' changed')
        stages[service]=full
    return stages


def validate_controller_deployment(config,mode):
    validate_workspace(config.get('workspace'))
    services=controller_services(config);dual=len(services)==2
    reports=('browser','agentBefore','agentFinal','temporaryAgent','lifecycle') if dual else ('recovery',)
    for report in reports:
        require(report in config.get('reports',{}),'reports.'+report+' is required before baseline capture')
        durable_path(config['reports'][report])
    tags=[normalized_image_tag(config['images'][service][key]) for service in services for key in ('candidateTag','localTag','rollbackTag')]
    require(len(set(tags))==len(tags),'image tag aliases must be distinct')
    outputs=([*BASELINE_FILES,'deployment-context.private.json',*archives(config)] if mode=='before' else
        [mode+'-deployed.json',mode+'-deployed.private.json',mode+'-rollback.private.json'] if mode in services else
        ['containers-'+mode+'.json','checks-'+mode+'.json'])
    for name in outputs:runtime_output_file(config,name)
    if mode=='before':return
    context=read_json(Path(config['output'])/'deployment-context.private.json')
    require(context==controller_context(config),'Controller configuration, Compose files or baseline bytes changed')
    baseline=validate_controller_baseline(config)
    controller_stages(config,baseline,mode in ('after','final'))
    if mode in ('after','final') and not dual:controller_recovery(config,baseline)
    if mode=='final' and dual:
        from controller17_acceptance import controller17_reports
        controller17_reports(config)


def capture_controller_context(config):
    validate_controller_baseline(config)
    write_runtime_report(config,'deployment-context.private.json',controller_context(config))


def controller_snapshot_report(config,before,current,recovery):
    """Original safe-snapshot assertions, shared with legacy compatibility checks."""
    require(len(current)==len(before),'running container count changed')
    by_name={row['name']:row for row in current}
    require(len(by_name)==len(current),'duplicate current container name')
    services=controller_services(config);dual=len(services)==2
    targets={config['project']+'-'+service+'-1':service for service in services};unchanged=0;rebuilt=False
    for old in before:
        require(old['name'] in by_name,'original container name missing')
        now=by_name[old['name']];owned=targets.get(now['name'])
        require(now['mounts']==old['mounts'],old['name']+': mounts changed')
        require(now['networks']==old['networks'],old['name']+': networks changed')
        require(now['image']==(config['images'][owned]['candidateImage'] if owned else old['image']),old['name']+': image changed')
        if not owned:
            recovered=not dual and old['id']==recovery['before_id']
            require(now['id']==(recovery['after_id'] if recovered else old['id']),old['name']+': unexpectedly replaced')
            if recovered:rebuilt=True
            else:unchanged+=1
        if old['health']:require(now['health']=='healthy',old['name']+': unhealthy')
    if not dual:require(rebuilt and recovery['before_id']!=recovery['after_id'],'Runtime was not rebuilt')
    require(unchanged==config['expected']['otherContainersUnchanged'],'unchanged platform container count mismatch')
    healthy=sum(row['health']=='healthy' for row in current)
    if 'healthy' in config['expected']:require(healthy==config['expected']['healthy'],'healthy count mismatch')
    common=dict(healthy=healthy,containers=len(current),mounts_preserved=True)
    return dict(**common,other_containers_unchanged=unchanged) if dual else dict(**common,other_platform_containers_unchanged=unchanged,retained_runtime_rebuilt=rebuilt)
