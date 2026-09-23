from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'support'/'verification'))
from development_configuration import development_arguments, development_children
config,_ = development_arguments('runtime-final')
ROOT=Path(config['output'])
import json,subprocess,datetime
p=ROOT
read=lambda f:json.loads((p/f).read_text())
a=read(config['agent_before_path']);b=read(config['agent_final_path']);a.pop('checked_at');b.pop('checked_at');assert a==b,'original Agent binding changed'
l=read(config['lifecycle_report_path']);assert l['status']=='passed' and len(l['lifecycle'])==5 and len(l['publication'])==3
replay=read(config['replay_report_path']);assert replay['history_exact'] and replay['trace']['error_spans']==0 and replay['new_runs']==replay['new_tools']==0
agent=read(config['temporary_agent_path'])['agent_id']
for command in [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']]:
 for scope in ['label=io.antnest.agent-id='+agent,'name='+agent]:
  assert not subprocess.check_output(['docker',*command,'--filter',scope],text=True).strip(),'temporary resources remain'
controller=json.loads(subprocess.check_output(['docker','inspect',config['runtime_controller_container']]))[0]
assert controller['Image']==read(config['after_snapshot_path'])['runtime_controller_image']
cutoff=datetime.datetime.fromisoformat(controller['State']['StartedAt'].replace('Z','+00:00')).timestamp()*1e6
groups=config['_trace_groups']
paths=[path for _,path,_ in groups]
assert len(paths)==9
missing=errors=0
for kind,f,t in groups:
 ids={s['spanID'] for s in t['spans']}
 for s in t['spans']:
  for r in s.get('references') or []:
   if r['refType']=='CHILD_OF':missing+=int(r['traceID']!=t['traceID'] or r['spanID'] not in ids)
  tags={x['key']:x['value'] for x in s.get('tags') or []};errors+=int(tags.get('error') is True or tags.get('otel.status_code')=='ERROR')
 if kind=='publication':
  assert min(s['startTime'] for s in t['spans'])>=cutoff,'publication predates latest restart'
assert missing==errors==0
assert l['source_absence_404']==1
assert sum(x['evidence']['platform_absence_probes'] for x in l['lifecycle'])==5
processes=subprocess.check_output(['ps','-axo','pid=,ppid=,command='],text=True)
assert not development_children('runtime-final',processes),'verification children remain'
checks=[x['evidence'] for x in l['lifecycle']]+l['publication']+[replay['trace']]
summary={'status':'deployment_business_and_topology_passed','preservation':read(config['after_snapshot_path']),'lifecycle_operations':5,'post_restart_publications':3,'session_replay':{'stored_messages':replay['durable_messages'],'notifications':replay['notifications'],'new_runs':0,'new_tools':0,'strict':replay['trace']['strict_trace']},'trace_topologies':9,'missing_parent_edges':missing,'error_spans':errors,'strict_failed':sum(x['strict_trace']=='failed' for x in checks),'source_inspect_absence_404':1,'expected_absence_probes':5,'temporary_resources':0,'verification_children':0}
f=p/config['summary_path'];f.write_text(json.dumps(summary,indent=2));f.chmod(0o600);print(json.dumps(summary))
