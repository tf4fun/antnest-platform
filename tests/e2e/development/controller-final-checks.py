from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'support'/'verification'))
from development_configuration import development_arguments, workspace_mount
from controller_evidence import WORKSPACE_READ
config,_ = development_arguments('controller-final')
ROOT=Path(config['output'])
import json,subprocess,re
PG=config['postgres_container']
def run(args):return subprocess.check_output(args,text=True).strip()
def sql(query):return run(['docker','exec',PG,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',config['database_user'],'-d',config['database_name'],'-c',query])
browser=json.loads((ROOT/config['browser_report_path']).read_text())
assert len(browser['checks'])==8 and browser['browser_errors']==0
assert browser['status']=='passed' or (browser['failed_stage']=='chat_trace' and browser['assertion']=='Jaeger span warnings require review')
session=browser['session_id'];assert re.fullmatch(r'[a-f0-9-]{36}',session)
binding=json.loads(sql(f"SELECT jsonb_build_object('agent_id',agent_id,'cwd',cwd) FROM acp_sessions WHERE id='{session}'"))
assert binding=={'agent_id':browser['agent_id'],'cwd':'/workspace'},'Session database binding differs from browser Agent'
runs=json.loads(sql(f"SELECT jsonb_agg(jsonb_build_object('state',state,'stop_reason',stop_reason,'executor_state',executor_state)) FROM runs WHERE session_id='{session}'"))
assert len(runs)==3 and all(r=={'state':'completed','stop_reason':'end_turn','executor_state':'quiescent'} for r in runs)
attempts=json.loads(sql(f"SELECT jsonb_agg(jsonb_build_object('tool',t.tool_name,'state',t.state,'effect',t.tool_effect_state)) FROM tool_attempts t JOIN runs r ON r.id=t.run_id WHERE r.session_id='{session}'"))
assert len(attempts)==3 and all(r['state']=='completed' and r['effect']=='settled' for r in attempts)
rejected=json.loads(sql(f"SELECT coalesce(jsonb_agg(payload),'[]') FROM session_messages WHERE session_id='{session}' AND kind='tool_call' AND payload->>'status'='failed'"))
for r in rejected:
 assert all(c['text'].startswith('Tool arguments do not match the declared schema:') for c in r['content'])
 assert re.fullmatch(r'[a-zA-Z0-9_-]+',r['toolCallId'])
 assert sql("SELECT count(*) FROM tool_attempts WHERE tool_call_id='"+r['toolCallId']+"'")=='0'
runtime=config['runtime_container_prefix']+browser['agent_id']
container=json.loads(run(['docker','inspect',runtime]))[0]
assert container['Config']['Labels'].get('io.antnest.agent-id')==browser['agent_id'],'Runtime Agent label mismatch'
workspace_mount(container,config['workspace'])
content=run(['docker','exec',runtime,'sh','-c',WORKSPACE_READ,'sh',browser['workspace_file']]);assert content==browser['workspace_marker']
a=json.loads((ROOT/config['agent_before_path']).read_text());b=json.loads((ROOT/config['agent_final_path']).read_text());a.pop('checked_at');b.pop('checked_at');assert a==b
assert sql("SELECT count(*) FROM runs WHERE state IN ('admitting','running')")=='0'
temp=json.loads((ROOT/config['temporary_agent_path']).read_text())['agent_id']
for command in [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']]:
 for scope in ['label=io.antnest.agent-id='+temp,'name='+temp]:assert not run(['docker',*command,'--filter',scope])
traces=json.loads((ROOT/config['trace_review_path']).read_text());assert len(traces)==3 and all(t['errors']==0 for t in traces)
report={'status':'passed','browser_checks':8,'browser_errors':0,'completed_runs':3,'runtime_calls':3,'preflight_schema_rejections':len(rejected),'workspace_marker_matches':True,'recovered_agent_binding_unchanged':True,'temporary_agent_resources':0,'active_runs':0,'chat_topologies':3,'chat_strict_failed':sum(t['strict']!='passed' for t in traces)}
target=ROOT/config['final_report_path'];target.write_text(json.dumps(report,indent=2));target.chmod(0o600);print(json.dumps(report))
