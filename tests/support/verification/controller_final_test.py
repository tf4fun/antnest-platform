"""Controller final-check contracts with full report identities and SQL fixtures."""
import contextlib
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from development_configuration import validate_development

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/fixtures'))
from controller_final import controller_fixture


class ControllerFinalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = controller_fixture(self.root / 'evidence')
        self.browser = json.loads(Path(self.config['browser_report_path']).read_text())
        self.sql_override = {}
        self.inspection_override = None
        self.marker = self.browser['workspace_marker']
        self.calls = []

    def change(self, key, transform):
        path = Path(self.config[key]); value = json.loads(path.read_text()); transform(value); path.write_text(json.dumps(value))

    def sql(self, query):
        for substring, value in self.sql_override.items():
            if substring in query:
                return value
        if 'FROM acp_sessions' in query:
            return json.dumps({'agent_id': self.browser['agent_id'], 'cwd': '/workspace'})
        if 'count(*) FROM runs' in query:
            return '0'
        if 'FROM runs WHERE session_id' in query:
            return json.dumps([dict(state='completed', stop_reason='end_turn', executor_state='quiescent')] * 3)
        if 'FROM tool_attempts t JOIN runs' in query:
            return json.dumps([dict(tool=tool, state='completed', effect='settled') for tool in ['write', 'read', 'read']])
        if 'FROM session_messages' in query:
            return json.dumps([dict(toolCallId='rejected_' + str(i), content=[{'text': 'Tool arguments do not match the declared schema: fixture'}]) for i in range(2)])
        if 'count(*) FROM tool_attempts' in query:
            return '0'
        raise AssertionError(query)

    def external(self, argv, **kwargs):
        self.calls.append(argv)
        if argv[:2] == ['docker', 'inspect']:
            return json.dumps([self.inspection_override or dict(Name='/' + self.config['workspace']['container'],
                Config={'Labels': {'io.antnest.agent-id': self.browser['agent_id']}},
                Mounts=[dict(Destination='/workspace', Type='volume', RW=True, Name=self.config['workspace']['volume'])])])
        if argv[:2] == ['docker', 'exec']:
            if 'psql' in argv:
                return self.sql(argv[-1])
            return self.marker
        if '--filter' in argv:
            return ''
        raise AssertionError(argv)

    def execute(self):
        config = self.root / 'config.json'; config.write_text(json.dumps(self.config))
        entry = ROOT / 'tests/e2e/development/controller-final-checks.py'
        with patch.object(sys, 'argv', [str(entry), '--config', str(config)]), patch('subprocess.check_output', side_effect=self.external), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(entry), run_name='__main__')
        return json.loads(Path(self.config['final_report_path']).read_text())

    def test_full_contract_preserves_separate_revisions_and_strict_failure(self):
        result = self.execute()
        self.assertEqual(result['completed_runs'], 3)
        self.assertEqual(result['runtime_calls'], 3)
        self.assertEqual(result['preflight_schema_rejections'], 2)
        self.assertEqual(result['chat_strict_failed'], 1)
        self.assertTrue(any('FROM acp_sessions' in call[-1] for call in self.calls))
        self.assertEqual(Path(self.config['final_report_path']).stat().st_mode & 0o777, 0o600)

    def test_agent_session_workspace_and_trace_mismatch_fail_before_commands(self):
        mutations = [('browser_report_path', lambda x: x.update(agent_id='agent_'+'c'*32)),
                     ('agent_final_path', lambda x: x['execution_state'].update(agent_id='agent_'+'c'*32)),
                     ('browser_report_path', lambda x: x.update(workspace_file='/etc/passwd')),
                     ('browser_report_path', lambda x: x.update(workspace_url='http://other.invalid/workspace/?agent=x&session=y')),
                     ('browser_report_path', lambda x: x.update(workspace_url=x['workspace_url'].replace('?agent=', '?agent=&agent='))),
                     ('browser_report_path', lambda x: x.update(workspace_url=x['workspace_url'].replace('&session=', '&session=&session='))),
                     ('temporary_agent_path', lambda x: x.update(agent_id=self.browser['agent_id'])),
                     ('trace_review_path', lambda x: x[0].update(session_id='other')),
                     ('trace_review_path', lambda x: x[1].update(trace_id=x[0]['trace_id']))]
        for key, transform in mutations:
            with self.subTest(key=key):
                self.config = controller_fixture(self.root / 'evidence')
                self.change(key, transform)
                self.calls = []
                with self.assertRaises(ValueError):
                    self.execute()
                self.assertEqual(self.calls, [])

    def test_snapshot_inputs_must_be_distinct_and_complete(self):
        self.config['agent_final_path'] = self.config['agent_before_path']
        with self.assertRaises(ValueError):
            validate_development(self.config, 'controller-final', None)
        self.config = controller_fixture(self.root / 'evidence')
        self.change('agent_before_path', lambda x: x.pop('execution_revision'))
        with self.assertRaises(ValueError):
            validate_development(self.config, 'controller-final', None)

    def test_database_session_must_belong_to_the_report_agent(self):
        self.sql_override['FROM acp_sessions'] = json.dumps({'agent_id': 'agent_'+'c'*32, 'cwd': '/workspace'})
        with self.assertRaisesRegex(AssertionError, 'Session'):
            self.execute()

    def test_runtime_must_have_the_expected_agent_and_rw_volume(self):
        self.inspection_override = dict(Name='/' + self.config['workspace']['container'], Config={'Labels': {'io.antnest.agent-id': 'wrong'}},
                                       Mounts=[dict(Destination='/workspace', Type='volume', RW=True, Name=self.config['workspace']['volume'])])
        with self.assertRaisesRegex(AssertionError, 'Agent'):
            self.execute()

    def test_original_run_tool_rejection_and_global_active_run_assertions_remain(self):
        cases = {'FROM runs WHERE session_id': '[]', 'FROM tool_attempts t JOIN runs': '[]',
                 'FROM session_messages': json.dumps([{'toolCallId':'rejected','content':[{'text':'unexpected'}]}]),
                 'count(*) FROM tool_attempts': '1', 'count(*) FROM runs': '1'}
        for query, response in cases.items():
            with self.subTest(query=query):
                self.sql_override = {query: response}
                with self.assertRaises(AssertionError):
                    self.execute()
                self.assertFalse(Path(self.config['final_report_path']).exists())

    def test_rejection_count_is_not_forced_to_two(self):
        self.sql_override['FROM session_messages'] = '[]'
        self.assertEqual(self.execute()['preflight_schema_rejections'], 0)

    def test_workspace_marker_and_full_snapshot_comparison_remain(self):
        self.marker = 'changed'
        with self.assertRaises(AssertionError):
            self.execute()
        self.marker = self.browser['workspace_marker']
        self.change('agent_final_path', lambda x: x.update(runtime_revision='changed'))
        with self.assertRaises(AssertionError):
            self.execute()


if __name__ == '__main__':
    unittest.main()
