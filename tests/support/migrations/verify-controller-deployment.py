#!/usr/bin/env python3
"""Check legacy Controller safe snapshots without inventing a new live baseline."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/support/verification'))
from cleanup import write_report
from configuration import durable_path
from development_configuration import file_path,read_json
from controller_deployment import SERVICE,controller_recovery,controller_snapshot_report
from runtime_deployment import validate_compose_identity,validate_workspace_identity

parser=argparse.ArgumentParser()
parser.add_argument('--history',required=True,type=durable_path)
parser.add_argument('--output',required=True,type=durable_path)
args=parser.parse_args()
if args.output.exists():raise ValueError('compatibility output must be fresh')
files=['baseline.json','containers-before.json','database-before.json','containers-original.private.json',
    'agent-controller-deployed.json','recovered-runtime.json','recovery-report.json','recovery-trace.private.json',
    'containers-final.json','checks-final.json','containers-after.json','checks-after.json']
values={name:read_json(file_path(args.history/name)) for name in files}
full=values['containers-original.private.json'];before=values['containers-before.json'];final=values['containers-final.json']
target=next(row for row in full if (row['Config'].get('Labels') or {}).get('com.docker.compose.service')==SERVICE)
project=target['Config']['Labels']['com.docker.compose.project']
recovery=values['recovered-runtime.json']
runtime=next(row for row in full if row['Id']==recovery['before_id'])
rtc=next(row for row in full if row['Name']=='/'+project+'-runtime-controller-1')
scope=dict(item.split('=',1) for item in rtc['Config']['Env'])['ANTNEST_RUNTIME_CONTROLLER_SCOPE']
config=dict(project=project,workspace=dict(container=runtime['Name'].lstrip('/'),path='/workspace',volume=recovery['workspace']),
    reports=dict(recovery=str(args.history/'recovered-runtime.json')),
    images={SERVICE:dict(candidateImage=values['baseline.json']['candidates'][SERVICE][1])},
    expected=dict(containers=len(before),otherContainersUnchanged=len(before)-2))
validate_compose_identity(target,config,SERVICE,project+'-'+SERVICE+'-1')
validate_compose_identity(rtc,config,'runtime-controller',project+'-runtime-controller-1')
validate_workspace_identity(runtime,config,scope)
validated=controller_recovery(config,dict(runtime=runtime,full=full))
actual=controller_snapshot_report(config,before,final,validated)
expected=values['checks-final.json']
assert actual=={key:expected[key] for key in actual},'legacy final snapshot report differs'
assert values['baseline.json']['data_counts']=={table:len(rows) for table,rows in values['database-before.json'].items()}
assert expected['original_rows_preserved']==values['baseline.json']['data_counts']
try:
    controller_snapshot_report(config,before,values['containers-after.json'],validated)
except ValueError as error:
    assert 'unexpectedly replaced' in str(error)
else:raise AssertionError('pre-recovery after snapshot was incorrectly accepted')
legacy_after=next(row for row in values['containers-after.json'] if row['id']==recovery['before_id'])
legacy_final=next(row for row in final if row['id']==recovery['after_id'])
assert legacy_after['name']==legacy_final['name']==config['workspace']['container']
recovery_report=values['recovery-report.json']
strict=[item['evidence']['strict_trace'] for item in recovery_report['lifecycle']]
assert recovery_report['status']=='passed' and strict==['failed'],'historical Trace result changed'
running=sum(row['State']['Running'] for row in full)
healthy=sum(row['State'].get('Health',{}).get('Status')=='healthy' for row in full)
assert running<len(full) and healthy==0,'full inspect chronology changed'
args.output.mkdir(parents=True,mode=0o700)
result=dict(status='passed',compatible_snapshot_fields=actual,original_rows_preserved=expected['original_rows_preserved'],
    pre_recovery_after_expected_failure=True,historical_recovery_strict=strict,
    full_inspect=dict(containers=len(full),running=running,healthy=healthy,usable_as_new_baseline=False),
    sha256={name:hashlib.sha256((args.history/name).read_bytes()).hexdigest() for name in files},
    scope='Exact legacy safe-snapshot/recovery/report field compatibility and static full-inspect identity. No reconstructed healthy full baseline, Compose snapshot, live SQL/workspace or Trace replay.')
write_report(args.output,'comparison.json',result)
print(json.dumps(result))
