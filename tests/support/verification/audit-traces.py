import argparse, collections, json, os, pathlib, re
from configuration import durable_path

os.umask(0o077)
parser = argparse.ArgumentParser(description="Audit saved Trace diagnostics without changing acceptance results.")
parser.add_argument('--input', required=True, type=pathlib.Path, help='Directory containing logs and parsed JSON results.')
parser.add_argument('--evidence-root', required=True, type=pathlib.Path, help='Root containing evidence family/project directories.')
parser.add_argument('--output', required=True, type=pathlib.Path, help='Private diagnostic JSON output file.')
parser.add_argument('--allow-unlisted-repeat', action='append', default=[], metavar='NAME', help='Include all saved project traces for this log stem; repeat for additional names.')
args = parser.parse_args()
args.output = durable_path(args.output)
args.input = durable_path(args.input)
args.evidence_root = durable_path(args.evidence_root)
root = args.input
reports = []
for parsed in sorted(root.glob('*.parsed.json')):
    name = parsed.stem.removesuffix('.parsed')
    log = root / (name + '.log')
    content = log.read_text()
    projects = set(re.findall(r'antnest-(?:stage[123]-e2e|runtime-controller-e2e)-\d+', content))
    projects.update(re.findall(r'antnest-(?:[a-z]+-)+[a-f0-9]{8}(?![a-z0-9])', content))
    expected = set()
    def ids(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k in ('trace_id', 'traceId') and isinstance(v, str): expected.add(v)
                ids(v)
        elif isinstance(value, list):
            for v in value: ids(v)
    ids(json.loads(parsed.read_text()))
    traces = {}
    for family in args.evidence_root.iterdir():
        if not family.is_dir(): continue
        for project in projects:
            folder = family / project
            if not folder.is_dir(): continue
            for file in folder.rglob('*.json'):
                try: data = json.loads(file.read_text())
                except (ValueError, OSError): continue
                candidates = data.get('data', [data]) if isinstance(data, dict) else []
                if not isinstance(candidates, list): continue
                for trace in candidates:
                    if not isinstance(trace, dict) or not isinstance(trace.get('spans'), list): continue
                    tid = trace.get('traceID')
                    if not tid or (tid not in expected and name not in args.allow_unlisted_repeat): continue
                    if tid not in traces or len(trace['spans']) > len(traces[tid][0]['spans']): traces[tid] = (trace, str(file))
    findings = []; kinds = collections.Counter(); errors = collections.Counter()
    for tid, (trace, path) in traces.items():
        span_ids = {s['spanID'] for s in trace['spans']}
        missing = set(); warned = set(); other = set()
        for span in trace['spans']:
            for ref in span.get('references', []):
                if ref.get('refType') == 'CHILD_OF' and ref['spanID'] not in span_ids:
                    missing.add(ref['spanID'])
            for warning in span.get('warnings') or []:
                m = re.search(r'parent span ID=(\w+)', warning)
                if m: warned.add(m[1]); kinds['parent_warning'] += 1
                elif warning.startswith('clock skew adjustment disabled;'): kinds['clock_skew'] += 1
                else: other.add(warning); kinds['other'] += 1
            tags = {t['key']: t.get('value') for t in span.get('tags', [])}
            if tags.get('error') is True or tags.get('otel.status_code') == 'ERROR':
                service = trace.get('processes', {}).get(span.get('processID'), {}).get('serviceName', '?')
                errors[service + ':' + span.get('operationName', '?')] += 1
        if warned or missing or other:
            findings.append({'trace_id': tid, 'path': path, 'warned_parent_ids': sorted(warned), 'warned_parents_present': sorted(warned & span_ids), 'missing_child_of_parents': sorted(missing), 'other_warnings': sorted(other)})
    reports.append({'name': name, 'expected_trace_ids': len(expected), 'raw_traces_found': len(traces), 'warning_occurrences': dict(kinds), 'error_operations': dict(errors), 'findings': findings})
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(reports, indent=2))
for r in reports:
    if not r['expected_trace_ids']: continue
    print(json.dumps({'name':r['name'],'expected':r['expected_trace_ids'],'raw_found':r['raw_traces_found'],'warning_kinds':list(r['warning_occurrences']),'warned_parent_ids':sum(len(f['warned_parent_ids']) for f in r['findings']),'missing':sum(len(f['missing_child_of_parents']) for f in r['findings']),'other':sum(len(f['other_warnings']) for f in r['findings']),'error_operations':r['error_operations']}))
