"""Preflight must reject unsafe or incomplete deployment inputs before any command."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from development_configuration import (development_arguments, validate_development,
                                       select_final_traces, workspace_mount, development_children)

ROOT = Path(__file__).resolve().parents[3]
IMAGE = 'sha256:' + 'a' * 64


class DevelopmentFixtures:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / 'output'
        self.compose = self.root / 'compose.yaml'
        self.compose.write_text('services: {}\n')

    def deployment(self, profile='runtime-20260921'):
        services = {'runtime-20260921': ['runtime-controller'], 'temporal-20260921': ['temporal', 'agent-controller'],
                    'controller-20260917': ['agent-controller', 'runtime-controller'], 'controller-20260921': ['agent-controller']}[profile]
        return dict(output=str(self.output), project='antnest-fixture',
                    database=dict(container='antnest-fixture-postgres-1', user='fixture_admin', names={
                        'acp': 'fixture_acp', 'agentController': 'fixture_agent', 'runtimeController': 'fixture_runtime',
                        **({'temporal': 'fixture_temporal', 'temporalVisibility': 'fixture_visibility'} if profile.startswith('temporal') else {})}),
                    images={service: dict(candidateImage=IMAGE, candidateTag='antnest/' + service + ':candidate',
                                          localTag='antnest/' + service + ':local', rollbackTag='antnest/' + service + ':rollback') for service in services},
                    compose=['docker', 'compose', '-p', 'antnest-fixture', '-f', str(self.compose)],
                    workspace=dict(container='antnest-runtime-agent_' + 'a' * 32, path='/workspace', volume='fixture-workspace'),
                    expected=dict(containers=12, healthy=11, unaffectedProcesses=12-len(services),
                                  otherContainersUnchanged=12-len(services)-(profile == 'controller-20260921')))

    def put(self, name, value):
        self.output.mkdir(exist_ok=True)
        path = self.output / name
        path.write_text(json.dumps(value))
        return str(path)

    def final(self):
        agent = 'agent_' + 'a' * 32
        lifecycle = []
        for index, kind in enumerate(['create', 'disable', 'enable', 'rebuild', 'delete']):
            trace_id = format(index + 1, '032x')
            lifecycle.append(dict(kind=kind, traceID=trace_id, agentId=agent, requestId='request-' + kind,
                                  evidence=dict(trace_id=trace_id, kind=kind, agent_id=agent, request_id='request-' + kind)))
            self.put('lifecycle-' + kind + '.json', {'traceID': trace_id, 'spans': [dict(spanID='1', startTime=100)]})
        publication = []
        for index in range(3):
            trace_id = format(index + 6, '032x')
            publication.append({'trace_id': trace_id})
            self.put('publication-' + str(index) + '.json', {'traceID': trace_id, 'spans': [dict(spanID='1', startTime=100)]})
        replay_id = format(9, '032x')
        config = dict(output=str(self.output), lifecycle_trace_glob='lifecycle-*.json', publication_trace_glob='publication-*.json',
                      runtime_controller_container='antnest-fixture-runtime-controller-1')
        config['lifecycle_report_path'] = self.put('lifecycle-report.json', {'status': 'passed', 'lifecycle': lifecycle, 'publication': publication})
        config['replay_report_path'] = self.put('replay-report.json', {'trace': {'trace_id': replay_id}})
        config['replay_trace_path'] = self.put('replay-trace.json', {'traceID': replay_id, 'spans': [dict(spanID='1', startTime=100)]})
        config['temporary_agent_path'] = self.put('temporary-agent.json', {'agent_id': agent})
        for name in ['agent_before_path', 'agent_final_path', 'after_snapshot_path']:
            config[name] = self.put(name + '.json', {})
        config['summary_path'] = str(self.output / 'summary.json')
        return config


class DevelopmentConfigurationTests(DevelopmentFixtures, unittest.TestCase):
    def test_all_deployment_profiles_accept_complete_before_configuration(self):
        for name in ['controller-20260917', 'controller-20260921', 'runtime-20260921', 'temporal-20260921']:
            with self.subTest(profile=name):
                config = self.deployment(name)
                if name == 'controller-20260921':
                    config['reports'] = {'recovery': str(self.output / 'recovered-runtime.json')}
                if name == 'controller-20260917':
                    config['reports'] = {key: str(self.output / (key+'.json')) for key in ['browser','agentBefore','agentFinal','temporaryAgent','lifecycle']}
                validate_development(config, name, 'before')
        self.assertFalse(self.output.exists())

    def test_missing_late_stage_database_is_rejected_before_creating_output(self):
        config = self.deployment()
        del config['database']['names']['runtimeController']
        path = self.root / 'config.json'
        path.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'runtimeController'):
            development_arguments('runtime-20260921', ['--config', str(path), 'deploy'])
        self.assertFalse(self.output.exists())

    def test_invalid_mode_and_unknown_selector_rejected(self):
        with self.assertRaisesRegex(ValueError, 'mode'):
            validate_development(self.deployment(), 'runtime-20260921', 'typo')
        for field in ['process_scope', 'process_exclude', 'processPatterns', 'verification_commands', 'publication_trace_prefix']:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'unknown'):
                validate_development(self.final() | {field: 'bypass'}, 'runtime-final', None)

    def test_database_names_are_unique_single_sql_identifiers(self):
        for value in ['../.cache/data', 'bad/name', 'db;DROP', 'fixture_acp']:
            config = self.deployment()
            config['database']['names']['runtimeController'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_development(config, 'runtime-20260921', 'before')

    def test_candidate_digest_tags_and_statistics_are_validated(self):
        for field, value in [('candidateImage', 'latest'), ('rollbackTag', 'antnest/runtime-controller:local')]:
            config = self.deployment()
            config['images']['runtime-controller'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_development(config, 'runtime-20260921', 'before')
        for field, value in [('containers', True), ('healthy', 13), ('unaffectedProcesses', 12)]:
            config = self.deployment()
            config['expected'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_development(config, 'runtime-20260921', 'before')

    def test_compose_argv_cannot_select_other_project_or_cache_files(self):
        for argv in [['sh', '-c', 'docker compose'], ['docker', 'compose', '-p', 'other', '-f', str(self.compose)],
                     ['docker', 'compose', '-p', 'antnest-fixture', '--env-file', str(self.root / '.cache/env')],
                     ['docker', 'compose', '-p', 'antnest-fixture', 'down']]:
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                validate_development(self.deployment() | {'compose': argv}, 'runtime-20260921', 'before')

    def test_full_workspace_and_rw_volume_are_required(self):
        for value in ['/tmp', '/workspace/subdir', '/workspace/../tmp']:
            config = self.deployment(); config['workspace']['path'] = value
            with self.subTest(path=value), self.assertRaisesRegex(ValueError, 'workspace'):
                validate_development(config, 'runtime-20260921', 'before')
        expected = self.deployment()['workspace']
        mount = dict(Destination='/workspace', Type='volume', RW=True, Name=expected['volume'])
        row = dict(Name='/' + expected['container'], Mounts=[mount])
        self.assertEqual(workspace_mount(row, expected), mount)
        for change in [{'RW': False}, {'Type': 'bind'}, {'Name': 'other'}, {'Destination': '/workspace/subdir'}]:
            with self.subTest(change=change), self.assertRaises(AssertionError):
                workspace_mount(row | {'Mounts': [mount | change]}, expected)

    def test_output_leaf_alias_rejected_before_before_mode_mutation(self):
        cache = self.root / '.cache'; cache.mkdir()
        (cache / 'value').write_text('{}')
        self.output.mkdir(); (self.output / 'compose.private.json').symlink_to(cache / 'value')
        with self.assertRaisesRegex(ValueError, 'cache'):
            validate_development(self.deployment(), 'temporal-20260921', 'before')

    def test_nested_mounts_cannot_replace_part_of_the_workspace(self):
        expected = self.deployment()['workspace']
        base = dict(Destination='/workspace', Type='volume', RW=True, Name=expected['volume'])
        for destination in ['/workspace/acceptance-note.txt', '/workspace/subdir']:
            with self.subTest(destination=destination), self.assertRaisesRegex(AssertionError, 'nested'):
                workspace_mount(dict(Name='/' + expected['container'], Mounts=[base, dict(Destination=destination, Type='bind', RW=True)]), expected)

    def test_final_traces_are_exactly_five_three_one_and_correlate_to_reports(self):
        groups = select_final_traces(self.final())
        self.assertEqual([kind for kind, _, _ in groups].count('lifecycle'), 5)
        self.assertEqual([kind for kind, _, _ in groups].count('publication'), 3)
        self.assertEqual([kind for kind, _, _ in groups].count('replay'), 1)
        config = self.final(); config['publication_trace_glob'] = 'lifecycle-*.json'
        with self.assertRaisesRegex(ValueError, 'three|count|distinct'):
            select_final_traces(config)

    def test_duplicate_trace_id_wrong_report_and_wrong_agent_are_rejected(self):
        for change in ['duplicate', 'report', 'agent']:
            config = self.final()
            if change == 'duplicate':
                trace = json.loads(Path(config['replay_trace_path']).read_text()); trace['traceID'] = format(1, '032x')
                Path(config['replay_trace_path']).write_text(json.dumps(trace))
            else:
                report = json.loads(Path(config['lifecycle_report_path']).read_text())
                report['lifecycle'][0]['traceID' if change == 'report' else 'agentId'] = 'wrong'
                Path(config['lifecycle_report_path']).write_text(json.dumps(report))
            with self.subTest(change=change), self.assertRaises(ValueError):
                select_final_traces(config)

    def test_resolved_trace_file_alias_into_cache_fails(self):
        config = self.final()
        cache = self.root / '.cache'; cache.mkdir()
        target = self.output / 'publication-0.json'
        (cache / 'trace.json').write_bytes(target.read_bytes()); target.unlink(); target.symlink_to(cache / 'trace.json')
        with self.assertRaisesRegex(ValueError, 'cache'):
            select_final_traces(config)

    def test_process_contract_uses_fixed_formal_and_historical_paths(self):
        rows = '\n'.join(['800001 1 node tests/e2e/development/runtime-loss.mjs --config /tmp/run.json',
                           '800002 1 node .cache/runtime-sync-20260921/replay.mjs',
                           '800003 1 node unrelated.mjs'])
        self.assertEqual(len(development_children('runtime-final', rows)), 2)

    def test_process_contract_handles_equivalent_entry_path_spellings(self):
        rows = '\n'.join(['800010 1 node lifecycle.mjs --config /tmp/run.json',
                           '800011 1 node tests/e2e/development/./runtime-loss.mjs --config /tmp/run.json',
                           '800012 1 node ' + str(ROOT / 'tests/e2e/development/replay.mjs') + ' --config /tmp/run.json',
                           '800013 1 node unrelated.mjs'])
        self.assertEqual(len(development_children('runtime-final', rows)), 3)

    def test_all_eight_real_entries_reject_missing_config_before_external_commands(self):
        entries = ['deployment/controller-20260917.py', 'deployment/controller-20260921.py',
                   'deployment/runtime-20260921.py', 'deployment/temporal-20260921.py',
                   'controller-final-checks.py', 'runtime-final-checks.py', 'temporal-final-checks.py', 'idle-restart.py']
        config = self.root / 'bad.json'; config.write_text(json.dumps({'output': str(self.output)}))
        binary = self.root / 'bin'; binary.mkdir()
        marker = self.root / 'called'
        for tool in ['docker', 'ps', 'git']:
            script = binary / tool; script.write_text('#!/bin/sh\n/usr/bin/touch "' + str(marker) + '"\nexit 99\n'); script.chmod(0o700)
        for entry in entries:
            with self.subTest(entry=entry):
                result = subprocess.run([sys.executable, '-B', str(ROOT / 'tests/e2e/development' / entry), '--config', str(config),
                                         *(['before'] if entry.startswith('deployment/') else [])], capture_output=True, text=True,
                                        env={**os.environ, 'PATH': str(binary)}, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ValueError', result.stderr)
                self.assertFalse(self.output.exists())
                self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
