#!/usr/bin/env python3
"""Validate saved Temporal baseline/deployment evidence without fabricating after."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/support/verification'))
from cleanup import write_report
from configuration import durable_path
from development_configuration import read_json
from temporal_deployment import DATABASE_ROLES,READINESS,SERVICES,stage_records,validate_baseline

parser=argparse.ArgumentParser();parser.add_argument('--history',required=True,type=durable_path);parser.add_argument('--output',required=True,type=durable_path)
args=parser.parse_args()
if args.output.exists():raise ValueError('compatibility output must be fresh')
files=['before.json','rows-before.json','containers.private.json','compose.private.json',*[s+'-deployed.private.json' for s in SERVICES],'after.json','backups.json','deployment-stops.json','restart-stops.json']
values={name:read_json(args.history/name) for name in files}
compose=values['compose.private.json'];project=compose['name'];full=values['containers.private.json']
runtime=next(row for row in full if (row['Config'].get('Labels') or {}).get('io.antnest.managed')=='runtime')
volume=next(mount['Name'] for mount in runtime['Mounts'] if mount['Destination']=='/workspace')
archives=values['backups.json'];require_count=len(archives);assert require_count==4
config=dict(output=str(args.history),project=project,
    database=dict(container=project+'-postgres-1',names={role:item['database'] for role,item in zip(DATABASE_ROLES,archives)}),
    images=dict(temporal=dict(candidateImage=values['temporal-deployed.private.json']['Image'],localTag=compose['services']['temporal']['image'],rollbackTag='antnest/temporal:pre-temporal-sync-20260921'),
        **{'agent-controller':dict(rollbackTag='antnest/agent-controller:pre-temporal-sync-20260921')}),
    workspace=dict(container=runtime['Name'].lstrip('/'),path='/workspace',volume=volume),
    expected=dict(containers=len(full),healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in full),unaffectedProcesses=len(full)-2))
baseline=validate_baseline(config);stages=stage_records(config,baseline,'after')
assert baseline['before']['row_counts']==dict(acp_sessions=21,runs=43,session_messages=580,tool_attempts=29)
assert all(row['State']['Running'] for row in full) and config['expected']['healthy']==11
old_probe=baseline['targets']['temporal']['Config']['Healthcheck']['Test']
assert old_probe==['CMD','nc','-z','localhost','7233'] and stages['temporal']['Config']['Healthcheck']['Test']==READINESS
assert stages['temporal']['Id']!=baseline['targets']['temporal']['Id'] and stages['temporal']['Image']!=baseline['targets']['temporal']['Image']
assert stages['agent-controller']['Id']==baseline['targets']['agent-controller']['Id']
for item in archives:
    name=item['database']+'.dump';data=(args.history/name).read_bytes();files.append(name)
    assert data.startswith(b'PGDMP') and len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256']
for name in ['deployment-stops.json','restart-stops.json']:
    stops=values[name];assert [row['service'] for row in stops]==list(reversed(SERVICES)) and all(row['exit']==0 for row in stops)
    assert stops[0]['finished']<stops[1]['finished']
assert stages['temporal']['State']['StartedAt']<stages['agent-controller']['State']['StartedAt']
logs=['baseline.log','deploy.log','after-deploy.log','restart.log','restart-compose-failure.private.log','resume.log','restart-2.log','after-final.log']
def result(name):
    lines=(args.history/name).read_text().splitlines()
    return json.loads(next(line for line in reversed(lines) if line.startswith('{')))
assert result('baseline.log')['status']=='baseline_passed'
assert result('deploy.log')['status']=='deployed' and result('deploy.log')['backups']==4
assert result('resume.log')==dict(status='resumed',temporal_ready_before_controller=True)
restart=result('restart-2.log');assert restart['status']=='restart_passed' and restart['same_containers'] is True
assert 'non-zero exit status 1' in (args.history/'restart.log').read_text()
assert 'temporal-schema is missing dependency temporal-databases' in (args.history/'restart-compose-failure.private.log').read_text()
after=values['after.json'];assert result('after-deploy.log')==result('after-final.log')==after
assert after==dict(status='passed',containers=12,healthy=11,unaffected_processes=10,original_rows=baseline['before']['row_counts'],workspace_unchanged=True,runtime_unchanged=True,active_runs=0,temporal_image=config['images']['temporal']['candidateImage'])
result_value=dict(status='passed',baseline_containers=len(full),baseline_rows=baseline['before']['row_counts'],archives_verified=4,
    old_temporal_probe=old_probe,deployed_temporal_probe=READINESS,temporal_replaced=True,controller_deployment_id_preserved=True,
    saved_resume=result('resume.log'),saved_restart=dict(status=restart['status'],same_containers=restart['same_containers']),saved_after=after,
    older_compose_restart_failure_preserved=True,
    sha256={name:hashlib.sha256((args.history/name).read_bytes()).hexdigest() for name in files+logs},
    scope='Actual saved before/full inspect consistency, deployment records, archive bytes and saved mode results. Earlier Compose-start failure belongs to an older script revision. No latest-restart/after full inspect or raw final SQL/workspace bytes exist here; no fabricated after snapshot or fresh business/Trace acceptance.')
args.output.mkdir(parents=True,mode=0o700);write_report(args.output,'comparison.json',result_value);print(json.dumps(result_value))
