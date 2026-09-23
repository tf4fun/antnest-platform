"""Identity contracts for the Controller's saved browser acceptance reports."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from development_configuration import file_path, read_json, require, text, validate_workspace

AGENT = r'agent_[a-f0-9]{32}'
SESSION = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
WORKSPACE_READ = 'resolved=$(readlink -f "$1") || exit; case "$resolved" in /workspace/*) cat -- "$resolved";; *) exit 1;; esac'


def validate_controller_reports(config):
    browser = read_json(config['browser_report_path'])
    agent = text(browser.get('agent_id'), 'browser Agent', AGENT)
    session = text(browser.get('session_id'), 'browser Session', SESSION)
    require(isinstance(browser.get('checks'), list) and len(browser['checks']) == 8
            and all(isinstance(value, str) and value for value in browser['checks'])
            and len(set(browser['checks'])) == 8 and browser.get('browser_errors') == 0, 'incomplete browser checks')
    require(browser.get('status') == 'passed' or (browser.get('failed_stage') == 'chat_trace'
            and browser.get('assertion') == 'Jaeger span warnings require review'), 'browser did not pass its business checks')
    require(browser.get('workspace_file') == '/workspace/acceptance-note.txt', 'browser workspace file differs from the producer contract')
    text(browser.get('workspace_marker'), 'workspace marker')
    gateway = urlsplit(text(browser.get('gateway'), 'gateway'))
    workspace_url = urlsplit(text(browser.get('workspace_url'), 'workspace URL'))
    require(gateway.scheme in ['http', 'https'] and gateway.hostname and not gateway.username and not gateway.password, 'invalid gateway origin')
    require((workspace_url.scheme, workspace_url.netloc) == (gateway.scheme, gateway.netloc), 'workspace origin differs from gateway')
    query = parse_qs(workspace_url.query, keep_blank_values=True)
    require(workspace_url.path.rstrip('/') == '/workspace' and query.get('agent') == [agent]
            and query.get('session') == [session], 'workspace URL Agent/Session mismatch')
    paths = [file_path(config[key]) for key in ['agent_before_path', 'agent_final_path']]
    require(paths[0] != paths[1] and (paths[0].stat().st_dev, paths[0].stat().st_ino) != (paths[1].stat().st_dev, paths[1].stat().st_ino), 'Agent snapshots must be distinct files')
    for path in paths:
        state = read_json(path)
        require(state.get('agent_id') == agent, 'Agent snapshot identity differs from browser')
        for field in ['checked_at', 'lifecycle_state', 'activation_state', 'runtime_state', 'runtime_revision', 'execution_revision']:
            text(state.get(field), 'Agent snapshot ' + field)
        execution = state.get('execution_state')
        require(isinstance(execution, dict) and execution.get('agent_id') == agent, 'execution state Agent differs from browser')
        require({'availability', 'access_allowed', 'configuration_revision', 'unavailable_reason', 'active_session_id'} <= set(execution), 'incomplete execution state')
        text(execution['configuration_revision'], 'execution configuration revision')
        require(execution['availability'] == 'ready' and execution['access_allowed'] is True
                and execution['active_session_id'] is None, 'Agent execution state is not ready and idle')
    temporary = text(read_json(config['temporary_agent_path']).get('agent_id'), 'temporary Agent', AGENT)
    require(temporary != agent, 'temporary Agent must differ from the retained Agent')
    reviews = read_json(config['trace_review_path'])
    require(isinstance(reviews, list) and len(reviews) == 3, 'expected three chat Trace reviews')
    ids = []
    for review in reviews:
        ids.append(text(review.get('trace_id'), 'review Trace ID', r'[a-f0-9]{32}'))
        require(review.get('session_id') == session, 'Trace review Session differs from browser')
        require(review.get('errors') == 0 and review.get('strict') in ['passed', 'failed: Jaeger span warnings require review'], 'unreviewed Trace result')
    require(len(set(ids)) == 3, 'Trace review identities must be distinct')
    validate_workspace(config.get('workspace'))
    require(config['workspace']['container'] == 'antnest-runtime-' + agent, 'workspace container differs from browser Agent')
    return browser
