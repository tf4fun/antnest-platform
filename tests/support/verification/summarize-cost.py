import argparse,collections,json,pathlib
from configuration import durable_path

parser=argparse.ArgumentParser(description='Summarize saved session-cost diagnostics without changing acceptance results.')
parser.add_argument('--input',required=True,type=pathlib.Path,help='Log containing single-line JSON reports.')
parser.add_argument('--output',required=True,type=pathlib.Path,help='Existing directory for cost-result.json and cost-summary.json.')
parser.add_argument('--status',required=True,help='Select the first report with this status.')
args=parser.parse_args()
root=durable_path(args.output)
rows=[]
for line in durable_path(args.input).read_text().splitlines():
 if line.startswith('{'):
  try: rows.append(json.loads(line))
  except json.JSONDecodeError: pass
result=next(r for r in rows if r.get('status')==args.status)
durable_path(root/'cost-result.json').write_text(json.dumps(result,indent=2))
traces=result['traces'];prices=result['pricing_traces'];both=traces+prices
summary={k:v for k,v in result.items() if k not in ['traces','pricing_traces']}
summary.update(pricing_traces=len(prices),run_ids=len(set(t['run_id'] for t in traces if t.get('run_id'))),kinds=dict(collections.Counter(t['kind'] for t in traces)),strict_failed=sum(t['strict_trace']=='failed' for t in both),request_strict_failed=sum(t['strict_trace']=='failed' for t in traces),pricing_strict_failed=sum(t['strict_trace']=='failed' for t in prices),warning_traces=sum(t['warning_count']>0 for t in both),warning_entries=sum(t['warning_count'] for t in both),model_finish_failed=sum(t.get('model_finish_order')=='failed' for t in traces),warnings=sorted(set(w for t in both for w in t['warnings'])))
summary['model_finish_failures']=[{k:t.get(k) for k in ['label','transport','model_to_finish_gap_us','model_finish_timing','warning_count']} for t in traces if t.get('model_finish_order')=='failed']
durable_path(root/'cost-summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
