"""Replay final reports and 18 raw Traces with saved inspection and empty cleanup fixtures."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/verification'))
from configuration import durable_path
from development_configuration import file_path, read_json
from cleanup import write_report


def replay(evidence, output):
    checks = []
    for profile in ['runtime', 'temporal']:
        old = durable_path(evidence / (profile + '-sync-20260921'))
        folder = durable_path(output / profile)
        folder.mkdir(parents=True)
        for path in list(old.glob('lifecycle-*.json')) + list(old.glob('publication-*.json')) + [old / 'replay-trace.private.json']:
            value = read_json(path)
            if isinstance(value, dict) and 'spans' in value:
                shutil.copyfile(file_path(path), folder / path.name)
        config = dict(output=str(folder), lifecycle_trace_glob='lifecycle-*.json', publication_trace_glob='publication-*.json', summary_path=str(folder / 'summary.json'))
        for key, name in [('agent_before_path', 'agent-before.json'), ('agent_final_path', 'agent-final.json'),
                          ('lifecycle_report_path', 'lifecycle-report.json'), ('replay_report_path', 'replay-report.json'),
                          ('temporary_agent_path', 'temporary-agent.json'), ('after_snapshot_path', 'after.json')]:
            config[key] = str(old / name)
        config['replay_trace_path'] = str(folder / 'replay-trace.private.json')
        snapshot = 'restarted.private.json' if profile == 'runtime' else 'agent-controller-deployed.private.json'
        controller = read_json(old / snapshot)
        config['runtime_controller_container' if profile == 'runtime' else 'agent_controller_container'] = controller['Name'].lstrip('/')
        if profile == 'temporal':
            config['compose_snapshot_path'] = str(old / 'compose.private.json')
        write_report(folder, 'config.json', config)
        calls = []
        def external(argv, **kwargs):
            calls.append(argv)
            if argv[:2] == ['docker', 'inspect']:
                assert argv[2:] == [controller['Name'].lstrip('/')]
                return json.dumps([controller])
            if argv[0] == 'ps' or (argv[0] == 'docker' and '--filter' in argv):
                return ''
            raise AssertionError('unexpected external fixture call: ' + repr(argv))
        entry = ROOT / 'tests/e2e/development' / (profile + '-final-checks.py')
        with patch.object(sys, 'argv', [str(entry), '--config', str(folder / 'config.json')]), patch('subprocess.check_output', side_effect=external), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(entry), run_name='__main__')
        actual, expected = read_json(folder / 'summary.json'), read_json(old / 'summary.json')
        assert actual == expected, profile + ' historical summary differs'
        checks.append(dict(profile=profile, traces=actual['trace_topologies'], strict_failed=actual['strict_failed'],
                           report_matches=True, inspection_fixture=snapshot,
                           cutoff_scope='saved restart inspection' if profile == 'runtime' else 'saved deployment inspection; later restart inspection not saved'))
    result = dict(status='passed', checks=checks, scope='Historical report/raw Trace equivalence with reconstructed external reads; not current cleanup or proof of Temporal latest-restart cutoff. Fresh cutoff behavior has separate disposable Docker evidence.')
    write_report(output, 'comparison.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-root', required=True, type=durable_path)
    parser.add_argument('--output', required=True, type=durable_path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(replay(args.evidence_root, args.output)))
