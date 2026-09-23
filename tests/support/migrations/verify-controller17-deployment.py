#!/usr/bin/env python3
"""Legacy dual-Controller snapshots/reports; no reconstructed live acceptance."""
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
from controller_deployment import controller_snapshot_report
from controller17_acceptance import controller17_reports

parser=argparse.ArgumentParser();parser.add_argument('--history',required=True,type=durable_path);parser.add_argument('--output',required=True,type=durable_path)
args=parser.parse_args()
if args.output.exists():raise ValueError('compatibility output must be fresh')
reports=dict(browser='browser-acceptance/report.json',agentBefore='agent-before.json',agentFinal='agent-final.json',temporaryAgent='temporary-agent.json',lifecycle='lifecycle-report.json')
files=['baseline.json','containers-before.json','database-before.json','agent-controller-deployed.json','runtime-controller-deployed.json','containers-after.json','checks-after.json','containers-final.json','checks-final.json',*reports.values()]
values={name:read_json(args.history/name) for name in files};before=values['containers-before.json'];summary=values['baseline.json']
project=next(row['name'].removesuffix('-agent-controller-1') for row in before if row['name'].endswith('-agent-controller-1'))
browser=values[reports['browser']];runtime=next(row for row in before if row['name']=='antnest-runtime-'+browser['agent_id'])
volume=next(mount['Name'] for mount in runtime['mounts'] if mount['Destination']=='/workspace')
config=dict(project=project,images={service:dict(candidateImage=refs[1]) for service,refs in summary['candidates'].items()},
    workspace=dict(container=runtime['name'],path='/workspace',volume=volume),reports={key:str(args.history/value) for key,value in reports.items()},
    expected=dict(containers=len(before),otherContainersUnchanged=len(before)-2))
parsed=controller17_reports(config)
row_counts={table:len(rows) for table,rows in values['database-before.json'].items()}
assert row_counts==summary['data_counts']==dict(acp_sessions=19,runs=37,session_messages=449,tool_attempts=23)
assert summary['environment_match'] is True and summary['active_runs']==0
snapshots={}
for mode in ('after','final'):
    report=values['checks-'+mode+'.json']
    actual=controller_snapshot_report(config,before,values['containers-'+mode+'.json'],None)
    assert actual=={key:report[key] for key in actual}
    assert report['status']=='passed' and report['active_runs']==0 and report['original_rows_preserved']==row_counts
    for service in ('agent-controller','runtime-controller'):
        deployed=values[service+'-deployed.json'];live=next(row for row in values['containers-'+mode+'.json'] if row['name']==deployed['name'])
        assert live==deployed
    snapshots[mode]=actual
assert values['checks-after.json']['current_rows']==row_counts
assert values['checks-final.json']['current_rows']==dict(acp_sessions=20,runs=40,session_messages=509,tool_attempts=26)
expected=dict(session_id=browser['session_id'],new_completed_runs=3,completed_runtime_calls=3,preflight_rejections=2,workspace_marker_matches=True,agent_configuration_unchanged=True,temporary_resources=0,verification_children=0)
assert {key:values['checks-final.json'][key] for key in expected}==expected
assert browser['status']=='failed' and browser['failed_stage']=='chat_trace' and browser['assertion']=='Jaeger span warnings require review'
lifecycle=parsed['lifecycle'];strict=[item['evidence']['strict_trace'] for item in lifecycle['lifecycle']]
assert strict==['failed']*5 and len(lifecycle['publication'])==3
warnings=[len(item['evidence']['warnings']) for item in lifecycle['lifecycle']]
assert warnings==[1,4,2,3,3]
archives=['antnest_agent_controller-before.dump','antnest_runtime_controller-before.dump','antnest_agent_acp-before.dump']
for name in archives:assert (args.history/name).read_bytes().startswith(b'PGDMP')
result=dict(status='passed',compatible_snapshot_fields=snapshots,final_business_report_fields=expected,
    original_rows=row_counts,final_rows=values['checks-final.json']['current_rows'],browser_status=browser['status'],lifecycle_strict=strict,lifecycle_warning_counts=warnings,
    sha256={name:hashlib.sha256((args.history/name).read_bytes()).hexdigest() for name in files+archives},
    scope='Exact saved safe-snapshot, report, Agent identity and archive-byte compatibility. Browser and lifecycle strict failures remain; no recreated full inspect/Compose context or live historical SQL, workspace, resource, browser or Trace replay.')
args.output.mkdir(parents=True,mode=0o700);write_report(args.output,'comparison.json',result);print(json.dumps(result))
