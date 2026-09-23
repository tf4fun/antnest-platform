"""Validate saved Controller report compatibility without replaying historical SQL or Docker state."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/verification'))
from configuration import durable_path
from development_configuration import read_json, validate_development
from cleanup import write_report


def verify(evidence, output):
    output.mkdir(parents=True)
    browser = read_json(evidence / 'browser-acceptance/report.json')
    recovery = read_json(evidence / 'recovered-runtime.json')
    config = dict(output=str(output), postgres_container='historical-postgres',
                  database_user='historical_user', database_name='historical_acp',
                  runtime_container_prefix='antnest-runtime-', final_report_path=str(output / 'unused-final.json'),
                  workspace=dict(container='antnest-runtime-' + browser['agent_id'], path='/workspace', volume=recovery['workspace']))
    for key, name in [('browser_report_path', 'browser-acceptance/report.json'),
                      ('agent_before_path', 'agent-before.json'), ('agent_final_path', 'agent-final.json'),
                      ('temporary_agent_path', 'temporary-agent.json'), ('trace_review_path', 'trace-review-3.json')]:
        config[key] = str(evidence / name)
    validate_development(config, 'controller-final', None)
    before, after = read_json(config['agent_before_path']), read_json(config['agent_final_path'])
    before.pop('checked_at'); after.pop('checked_at')
    assert before == after, 'historical Agent snapshots differ'
    reviews = read_json(config['trace_review_path'])
    saved = read_json(evidence / 'final-browser-checks.json')
    derived = dict(browser_checks=len(browser['checks']), browser_errors=browser['browser_errors'],
                   recovered_agent_binding_unchanged=True, chat_topologies=len(reviews),
                   chat_strict_failed=sum(review['strict'] != 'passed' for review in reviews))
    assert saved['status'] == 'passed'
    assert all(saved[key] == value for key, value in derived.items()), 'saved report statistics differ'
    result = dict(status='passed', report_identity_contract='passed', saved_report_fields=derived,
                  scope='Saved browser, Agent, Session, workspace and Trace-review identity compatibility; '
                        'database rows, workspace bytes and resource cleanup were not re-executed. '
                        'Separate disposable Docker/PostgreSQL evidence covers the live CLI assertions.')
    write_report(output, 'comparison.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=durable_path)
    parser.add_argument('--output', required=True, type=durable_path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(verify(args.evidence, args.output)))
