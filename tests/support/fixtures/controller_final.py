"""Shared Controller final-check report fixture."""
import json
from pathlib import Path


def controller_fixture(root, *, agent='agent_' + 'a' * 32, temporary='agent_' + 'b' * 32):
    root.mkdir(parents=True, exist_ok=True)
    session = '11111111-2222-4333-8444-555555555555'
    gateway = 'http://127.0.0.1:19000'
    browser = dict(status='passed', gateway=gateway, checks=['check-' + str(i) for i in range(8)], browser_errors=0,
                   agent_id=agent, session_id=session, workspace_file='/workspace/acceptance-note.txt', workspace_marker='fixture-marker',
                   workspace_url=gateway + '/workspace/?agent=' + agent + '&session=' + session)
    state = dict(agent_id=agent, lifecycle_state='active', activation_state='enabled', runtime_state='running',
                 runtime_revision='runtime-revision', execution_revision='execution-revision',
                 execution_state=dict(agent_id=agent, availability='ready', access_allowed=True, configuration_revision='configuration-revision',
                                      unavailable_reason=None, active_session_id=None))
    reports = {'browser_report_path': browser, 'agent_before_path': state | {'checked_at': '2026-09-22T00:00:00Z'},
               'agent_final_path': state | {'checked_at': '2026-09-22T00:01:00Z'}, 'temporary_agent_path': {'agent_id': temporary},
               'trace_review_path': [dict(trace_id=format(i+1, '032x'), session_id=session, errors=0,
                                          strict='failed: Jaeger span warnings require review' if i == 0 else 'passed') for i in range(3)]}
    config = dict(output=str(root), postgres_container='antnest-fixture-postgres-1', database_user='fixture_admin', database_name='fixture_acp',
                  runtime_container_prefix='antnest-runtime-', final_report_path=str(root / 'final.json'),
                  workspace=dict(container='antnest-runtime-' + agent, path='/workspace', volume='antnest-workspace-' + agent))
    for key, value in reports.items():
        path = root / (key + '.json'); path.write_text(json.dumps(value)); config[key] = str(path)
    return config
