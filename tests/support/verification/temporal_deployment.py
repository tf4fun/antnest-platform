"""Pure Temporal deployment contracts with explicitly bound dependency stages."""
import hashlib
from pathlib import Path
from development_configuration import file_path,object_fields,read_json,require,text
from runtime_deployment import (BASELINE_FILES,TABLES,normalized_image_tag,runtime_output_file,safe_container,
    validate_compose_identity,validate_runtime_inspection,validate_workspace_identity,write_runtime_report)

SERVICES=('temporal','agent-controller')
DATABASE_ROLES=('temporal','temporalVisibility','agentController','acp')
READINESS=['CMD','sh','/etc/temporal/readiness.sh']


def context(config):
    def sha(path):return hashlib.sha256(file_path(path).read_bytes()).hexdigest()
    argv=config['compose']
    return dict(version=1,configuration=config,compose_inputs={str(file_path(argv[i+1])):sha(argv[i+1]) for i in range(2,len(argv),2) if argv[i] in ('-f','--file','--env-file')},baseline_files={name:sha(Path(config['output'])/name) for name in BASELINE_FILES})


def environment(row,effective):
    values=row['Config'].get('Env')
    require(isinstance(values,list) and all(isinstance(value,str) and '=' in value for value in values),'container environment missing')
    pairs=[value.split('=',1) for value in values];actual=dict(pairs)
    require(len(actual)==len(pairs),'ambiguous container environment')
    require(isinstance(effective.get('environment'),dict),'Compose environment missing')
    require(all(actual.get(key)==str(value) for key,value in effective['environment'].items()),'service environment differs')


def validate_baseline(config):
    output=Path(config['output']);before,full,compose,rows=[read_json(output/name) for name in BASELINE_FILES]
    object_fields(before,'before snapshot',{'containers','workspace_sha256','row_counts'})
    text(before['workspace_sha256'],'workspace SHA-256',r'[a-f0-9]{64}')
    require(isinstance(full,list) and len(full)==config['expected']['containers'],'baseline container count mismatch')
    for row in full:validate_runtime_inspection(row)
    require(len({row['Id'] for row in full})==len(full) and len({row['Name'] for row in full})==len(full),'duplicate baseline identity')
    require(before['containers']==[safe_container(row) for row in full],'baseline safe/full mismatch')
    require(isinstance(rows,dict) and set(rows)==set(TABLES),'expected four table snapshots')
    for table in TABLES:
        require(isinstance(rows[table],dict),'invalid row snapshot')
        for key,digest in rows[table].items():text(key,'row ID');text(digest,'row MD5',r'[a-f0-9]{32}')
    require(before['row_counts']=={table:len(rows[table]) for table in TABLES},'baseline row counts mismatch')
    require(isinstance(compose,dict) and compose.get('name')==config['project'],'Compose project mismatch')
    require(normalized_image_tag(compose['services']['temporal']['image'])==normalized_image_tag(config['images']['temporal']['localTag']),'Compose Temporal image mismatch')
    by_name={row['Name'].lstrip('/'):row for row in full};targets={}
    for service in SERVICES:
        name=config['project']+'-'+service+'-1';row=by_name[name]
        validate_compose_identity(row,config,service,name);environment(row,compose['services'][service])
        require(row['State']['Running'] and row['State'].get('Health',{}).get('Status')=='healthy','baseline service unhealthy')
        require(isinstance(row['Config'].get('Healthcheck',{}).get('Test'),list) and row['Config']['Healthcheck']['Test'],'baseline healthcheck missing')
        targets[service]=row
    pg=by_name[config['database']['container']];validate_compose_identity(pg,config,'postgres',config['database']['container'])
    rtc_name=config['project']+'-runtime-controller-1';rtc=by_name[rtc_name];validate_compose_identity(rtc,config,'runtime-controller',rtc_name)
    scope=text(compose['services']['runtime-controller']['environment'].get('ANTNEST_RUNTIME_CONTROLLER_SCOPE'),'Runtime scope',r'[a-zA-Z0-9][a-zA-Z0-9_.-]*')
    environment(rtc,compose['services']['runtime-controller'])
    runtime=by_name[config['workspace']['container']];validate_workspace_identity(runtime,config,scope)
    require(pg['State']['Running'] and runtime['State']['Running'],'database/workspace not running')
    require(sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in full)==config['expected']['healthy'],'baseline healthy count mismatch')
    return dict(before=before,full=full,compose=compose,rows=rows,targets=targets,postgres=pg,runtime=runtime,scope=scope)


def stage_records(config,baseline,mode):
    stages={};output=Path(config['output'])
    rollback=output/'rollback.private.json'
    if mode=='resume' and rollback.exists():
        recovered=read_json(rollback);require(recovered.get('status')=='recovered','invalid recovery record');stages=recovered['containers']
        require(set(stages)==set(SERVICES),'incomplete recovery record')
    else:
        for service in SERVICES:
            path=output/(service+'-deployed.private.json')
            if path.exists():stages[service]=read_json(path)
        resumed=output/'resumed.private.json'
        if resumed.exists():
            completed=read_json(resumed);require(set(completed)==set(SERVICES),'incomplete resume record')
            for service,row in completed.items():
                if service in stages:require(row['Id']==stages[service]['Id'],'resume/deployment identity mismatch')
                stages[service]=row
        if mode in ('restart','after'):require(set(stages)==set(SERVICES),'missing deployment record')
    for service,row in stages.items():
        validate_compose_identity(row,config,service,config['project']+'-'+service+'-1');environment(row,baseline['compose']['services'][service])
        original=baseline['targets'][service]
        expected=original['Image'] if mode=='resume' and rollback.exists() or service=='agent-controller' else config['images']['temporal']['candidateImage']
        if service=='temporal':
            probe=original['Config']['Healthcheck']['Test'] if mode=='resume' and rollback.exists() else READINESS
            require(row['Config'].get('Healthcheck',{}).get('Test')==probe,'Temporal stage healthcheck differs')
        require(row['Image']==expected and row['State']['Running'] and row['State'].get('Health',{}).get('Status')=='healthy','invalid deployment image/state')
        require(all(safe_container(row)[key]==safe_container(original)[key] for key in ('mounts','networks')),'deployment mounts/networks changed')
    return stages


def validate_temporal_deployment(config,mode):
    tags=[normalized_image_tag(value) for refs in config['images'].values() for key,value in refs.items() if key.endswith('Tag')]
    require(len(tags)==len(set(tags)),'image aliases must be distinct')
    outputs={'before':[*BASELINE_FILES,'deployment-context.private.json'],
        'deploy':['deployment-stops.json','backups.json',*[s+'-deployed.private.json' for s in SERVICES],'rollback.private.json','rollback-compose.private.json',*[config['database']['names'][role]+'.dump' for role in DATABASE_ROLES]],
        'restart':['restart-stops.json','restarted.private.json','restart-recovery.private.json'],
        'resume':['resumed.private.json','resume-recovery.private.json'],'after':['after.json']}[mode]
    for name in outputs:runtime_output_file(config,name,fresh=mode!='after')
    if mode=='before':return
    require(read_json(Path(config['output'])/'deployment-context.private.json')==context(config),'Temporal configuration, Compose files or baseline bytes changed')
    baseline=validate_baseline(config);stage_records(config,baseline,mode)


def capture_context(config):
    validate_baseline(config);write_runtime_report(config,'deployment-context.private.json',context(config))


def recovery_override(baseline):
    result={}
    for service,row in baseline['targets'].items():
        health=row['Config']['Healthcheck'];translated={'test':health['Test']}
        for source,destination in [('Interval','interval'),('Timeout','timeout'),('StartPeriod','start_period'),('StartInterval','start_interval')]:
            if source in health:translated[destination]=str(health[source])+'ns'
        if 'Retries' in health:translated['retries']=health['Retries']
        result[service]=dict(image=row['Image'],healthcheck=translated)
    return dict(services=result)


def snapshot_report(config,before,current):
    require(len(current)==len(before),'global container count changed');by_name={row['name']:row for row in current}
    require(len(by_name)==len(current),'duplicate container names');unaffected=0
    for old in before:
        require(old['name'] in by_name,'baseline container missing');now=by_name[old['name']]
        service=next((s for s in SERVICES if old['name']=='/'+config['project']+'-'+s+'-1'),None)
        require(now['running'] and (not old['health'] or now['health']=='healthy'),old['name']+' not running and healthy')
        require(now['mounts']==old['mounts'] and now['networks']==old['networks'],old['name']+' mounts/networks changed')
        require(now['image']==(config['images']['temporal']['candidateImage'] if service=='temporal' else old['image']),old['name']+' image changed')
        if not service:
            require(all(now[key]==old[key] for key in ('id','started','restarts')),old['name']+' process changed');unaffected+=1
    healthy=sum(row['health']=='healthy' for row in current)
    require(healthy==config['expected']['healthy'] and unaffected==config['expected']['unaffectedProcesses'],'computed container counts differ')
    return dict(containers=len(current),healthy=healthy,unaffected_processes=unaffected)
