import argparse,collections,json,pathlib
from configuration import durable_path

parser=argparse.ArgumentParser(description='Summarize saved business and raw Trace diagnostics without changing acceptance results.')
parser.add_argument('--output',required=True,type=pathlib.Path,help='Existing directory for summary.json.')
parser.add_argument('projects',nargs='+',type=pathlib.Path,help='Evidence directories containing business.json and traces/.')
args=parser.parse_args()
root=durable_path(args.output)
out=[]
for arg in args.projects:
 p=durable_path(arg);b=json.loads(durable_path(p/'business.json').read_text())
 groups={k:b.get(k,[]) for k in ['traces','request_traces','watch_traces','policy_traces']}
 if b.get('active_run_rebuild'):groups['request_traces']=b['active_run_rebuild'].get('run_traces',[])
 evidence=[t for rows in groups.values() for t in rows]; raw=[];missing=[];errors=[];warnings=[]
 for f in durable_path(p/'traces').glob('*.json'):
  t=json.loads(durable_path(f).read_text());raw.append(t);ids={s['spanID'] for s in t['spans']}
  for s in t['spans']:
   tags={x['key']:x['value'] for x in s.get('tags',[])}
   for r in s.get('references',[]):
    if r['refType']=='CHILD_OF' and r['spanID'] not in ids:missing.append({'trace':t['traceID'],'span':s['spanID']})
   if tags.get('error') is True or tags.get('otel.status_code')=='ERROR' or tags.get('antnest.outcome') in ['rejected','error'] or any(f.get('value')=='antnest.error' for e in (s.get('logs') or []) for f in (e.get('fields') or [])):errors.append((t['processes'][s['processID']]['serviceName'],s['operationName'],tags.get('error.type')))
   warnings+=s.get('warnings') or []
  warnings+=t.get('warnings') or []
 report={'project':p.name,'profile':b['profile'],'groups':{k:len(v) for k,v in groups.items()},'topologies':len(evidence),'topology_failed':sum(t.get('topology','passed')=='failed' for t in evidence),'strict_failed':sum(t.get('strict_trace')=='failed' for t in evidence),'raw_traces':len(raw),'missing_parents':len(missing),'error_spans':len(errors),'errors_by_service':dict(collections.Counter(e[0] for e in errors)),'warning_count':len(warnings),'warnings':sorted(set(warnings)),'errors':errors}
 out.append(report)
f=durable_path(root/'summary.json');f.write_text(json.dumps(out,indent=2));f.chmod(0o600)
for r in out:print(json.dumps({k:v for k,v in r.items() if k not in ['warnings','errors']},ensure_ascii=False))
