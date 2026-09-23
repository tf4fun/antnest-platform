"""Execute all four Runtime deployment modes against a stateful command boundary."""
from copy import deepcopy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import signal
import shlex
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/support/verification'))
from runtime_deployment_configuration_test import RuntimeConfigurationFixture, OLD, NEW, SERVICE, TABLES

ENTRY = ROOT / 'tests/e2e/development/deployment/runtime-20260921.py'


class DeploymentModel(RuntimeConfigurationFixture):
    def __init__(self, test):
        super().__init__(test, False)
        self.test = test
        refs = self.config['images'][SERVICE]
        self.tags = {refs['localTag']: OLD, refs['candidateTag']: NEW}
        self.calls, self.faults = [], []
        self.manifest = b''
        self.active_runs = self.active_operations = 0
        self.clock = 0
        self.start_number = 0
        self.stop_exit, self.stop_oom = 0, False
        self.unhealthy_candidate = False
        self.wrong_candidate = False
        self.missing_target = False

    def row(self, ref):
        row = next((row for row in self.containers if ref in (row['Id'], row['Name'].lstrip('/'))), None)
        if row is self.containers[0] and self.missing_target:
            row = None
        if row is None:
            raise subprocess.CalledProcessError(1, ['docker','inspect',ref])
        return row

    def fault(self, predicate, error=None, after=False):
        self.faults.append((predicate, error or RuntimeError('injected failure'), after))

    def tick(self):
        self.clock += 30
        return self.clock

    def start(self, row):
        self.start_number += 1
        row['State'].update(Running=True, Status='running', StartedAt=f'2026-09-22T00:00:{self.start_number:02d}Z')
        row['State']['Health'] = dict(Status='unhealthy' if self.unhealthy_candidate and row['Image'] == NEW else 'healthy')

    def command(self, args, **kwargs):
        self.calls.append(list(args))
        fault = next((item for item in self.faults if item[0](args)), None)
        if fault:
            self.faults.remove(fault)
            if not fault[2]:
                if callable(fault[1]): fault[1]()
                else: raise fault[1]
        value = ''
        refs = self.config['images'][SERVICE]
        if args == ['docker', 'ps', '-aq']:
            value = '\n'.join(row['Id'] for row in self.containers if not (row is self.containers[0] and self.missing_target))
        elif args[:4] == ['docker', 'ps', '-aq', '--filter']:
            self.test.assertEqual(args[4:], ['name=^/'+self.config['project']+'-'+SERVICE+'-1$'])
            value = '' if self.missing_target else self.containers[0]['Id']
        elif args[:2] == ['docker', 'inspect']:
            value = json.dumps([dict(Id=self.tags[name]) if name in self.tags else self.row(name) for name in args[2:]])
        elif args == self.config['compose'] + ['config', '--format', 'json']:
            value = json.dumps(self.compose)
        elif args[:4] == ['docker', 'image', 'ls', '-q']:
            value = self.tags.get(args[-1].removeprefix('reference='), '')
        elif args[:2] == ['docker', 'tag']:
            self.tags[args[3]] = self.tags.get(args[2], args[2])
        elif args[:2] == ['docker', 'stop']:
            row = self.row(args[-1]); self.test.assertEqual(row['Name'], self.containers[0]['Name'])
            row['State'].update(Running=False, Status='exited', ExitCode=self.stop_exit, OOMKilled=self.stop_oom, FinishedAt='2026-09-22T00:00:00Z')
        elif args[:2] == ['docker', 'start']:
            self.start(self.row(args[-1]))
        elif args[:len(self.config['compose'])] == self.config['compose'] and 'up' in args:
            self.test.assertEqual(args[len(self.config['compose']):], ['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','180',SERVICE])
            row = self.containers[0]; image = self.tags[refs['localTag']]
            if row['Image'] != image or self.missing_target:
                row['Id'] = ('5' if image == NEW else '6') * 64
                row['Image'] = image
            self.missing_target = False
            self.start(row)
            if image == NEW and self.wrong_candidate:
                row['Image'] = 'sha256:' + 'f' * 64
        elif args[:2] == ['docker', 'exec'] and 'psql' in args:
            self.test.assertEqual(self.row(args[2])['Id'], self.containers[1]['Id'])
            query = args[-1]
            if query == "SELECT count(*) FROM runs WHERE state IN ('admitting','running')":
                value = str(self.active_runs)
                database = self.config['database']['names']['acp']
            elif query == "SELECT count(*) FROM agent_controller.agents WHERE active_operation_request_id <> ''":
                value = str(self.active_operations)
                database = self.config['database']['names']['agentController']
            else:
                table = next(table for table in TABLES if query == f"SELECT coalesce(jsonb_object_agg(id,md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {table} t")
                value = json.dumps(self.rows[table])
                database = self.config['database']['names']['acp']
            self.test.assertEqual(args[3:], ['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',self.config['database']['user'],'-d',database,'-c',query])
        elif args[:2] == ['docker','exec'] and 'sh' in args:
            self.test.assertEqual(self.row(args[2])['Id'], self.containers[2]['Id'])
            value = self.manifest.decode()
        else:
            self.test.fail('unexpected command: ' + repr(args))
        if fault and fault[2]:
            if callable(fault[1]): fault[1]()
            else: raise fault[1]
        return value if kwargs.get('text') else value.encode()

    def process(self, args, **kwargs):
        self.calls.append(list(args))
        fault = next((item for item in self.faults if item[0](args)), None)
        if fault:
            self.faults.remove(fault)
            if callable(fault[1]): fault[1]()
            else: raise fault[1]
        self.test.assertEqual(self.row(args[3] if args[2] == '-i' else args[2])['Id'], self.containers[1]['Id'])
        if 'pg_dump' in args:
            expected = list(self.config['database']['names'].values())[len([a for a in self.calls if 'pg_dump' in a])-1]
            self.test.assertEqual(args[3:], ['pg_dump','-U',self.config['database']['user'],'-Fc',expected])
            data = b'PGDMP-fixture-' + args[-1].encode()
            self.last_dump = data
            kwargs['stdout'].write(data)
            self.test.assertEqual(os.fstat(kwargs['stdout'].fileno()).st_mode & 0o777, 0o600)
        elif 'pg_restore' in args:
            self.test.assertEqual(args[4:], ['pg_restore','--list'])
            self.test.assertEqual(kwargs['stdin'].read(),self.last_dump)
        else:
            self.test.fail('unexpected process: ' + repr(args))
        return subprocess.CompletedProcess(args, 0)

    def execute(self, mode):
        file = self.root / 'config.json'; file.write_text(json.dumps(self.config))
        output = io.StringIO()
        with patch.object(sys, 'argv', [str(ENTRY), '--config', str(file), mode]), patch('subprocess.check_output', side_effect=self.command), patch('subprocess.run', side_effect=self.process), patch('time.monotonic', side_effect=self.tick), patch('time.sleep'), contextlib.redirect_stdout(output):
            runpy.run_path(str(ENTRY), run_name='__main__')
        return json.loads(output.getvalue())

    def baseline(self):
        self.execute('before'); self.calls.clear()

    def deployed_baseline(self):
        self.baseline(); self.execute('deploy'); self.calls.clear()

    def mutations(self):
        return [args for args in self.calls if args[1] in ('stop','start','tag') or 'up' in args]


class RuntimeDeploymentFlowTests(unittest.TestCase):
    def test_four_mode_chain_preserves_global_state_rows_and_backup_bytes(self):
        f = DeploymentModel(self); f.manifest = b'a  ./first\nb  ./second\n'; f.baseline()
        snapshots = {name:path.read_bytes() for path in f.output.iterdir() for name in [path.name]}
        self.assertEqual(f.execute('deploy')['backups'], 3)
        first = f.execute('after')
        self.assertEqual(first['healthy'], 3); self.assertEqual(first['unaffected_processes'], 3)
        self.assertEqual(first['original_rows'], {table:1 for table in TABLES})
        deployed_id = f.containers[0]['Id']
        self.assertTrue(f.execute('restart')['same_container'])
        self.assertEqual(f.containers[0]['Id'], deployed_id)
        self.assertEqual(f.execute('after'), first)
        for name, data in snapshots.items():
            self.assertEqual((f.output/name).read_bytes(), data)
        for item in json.loads((f.output/'backups.json').read_text()):
            data = (f.output/(item['database']+'.dump')).read_bytes()
            self.assertEqual(item['sha256'], hashlib.sha256(data).hexdigest()); self.assertEqual(item['bytes'], len(data))

    def test_live_config_and_all_three_role_identities_reject_before_mutation(self):
        for mode in ['deploy','restart']:
            for change in ['effective-compose','target-id','pg-id','runtime-id','runtime-scope','runtime-label','runtime-tmpfs','target-project','foreign-id','local-tag','candidate-tag','rollback-tag']:
                with self.subTest(mode=mode, change=change):
                    f = DeploymentModel(self)
                    f.deployed_baseline() if mode == 'restart' else f.baseline()
                    refs = f.config['images'][SERVICE]
                    if change == 'effective-compose': f.compose['services'][SERVICE]['environment']['FROM_IMPLICIT_ENV']='changed'
                    elif change.endswith('-id'): f.containers[{'target-id':0,'pg-id':1,'runtime-id':2,'foreign-id':3}[change]]['Id']='9'*64
                    elif change == 'runtime-scope': f.containers[2]['Config']['Labels']['io.antnest.runtime-controller-scope']='other'
                    elif change == 'runtime-label': f.containers[2]['Config']['Labels']['io.antnest.managed']='other'
                    elif change == 'runtime-tmpfs': f.containers[2]['HostConfig']['Tmpfs']={'/workspace/child':'rw'}
                    elif change == 'target-project': f.containers[0]['Config']['Labels']['com.docker.compose.project']='other'
                    else: f.tags[refs[{'local-tag':'localTag','candidate-tag':'candidateTag','rollback-tag':'rollbackTag'}[change]]]='sha256:'+'e'*64
                    with self.assertRaises((AssertionError,ValueError,RuntimeError)): f.execute(mode)
                    self.assertEqual(f.mutations(), [], f.calls)

    def test_mutating_and_exec_commands_use_full_bound_ids(self):
        f = DeploymentModel(self); f.baseline(); f.execute('deploy'); f.execute('restart'); f.execute('after')
        for args in f.calls:
            if args[:2] in [['docker','stop'],['docker','start']]: self.assertRegex(args[-1], r'^[a-f0-9]{64}$')
            if args[:2] == ['docker','exec']: self.assertRegex(args[3] if args[2]=='-i' else args[2], r'^[a-f0-9]{64}$')

    def test_every_backup_failure_preserves_or_recovers_old_service_and_remains_failed(self):
        for tool in ['pg_dump','pg_restore']:
            for index in range(3):
                with self.subTest(tool=tool, index=index):
                    f=DeploymentModel(self); f.baseline(); seen=[0]
                    def predicate(args):
                        if tool not in args: return False
                        seen[0]+=1; return seen[0]==index+1
                    f.fault(predicate)
                    with self.assertRaisesRegex(RuntimeError,'injected failure'): f.execute('deploy')
                    self.assertTrue(f.containers[0]['State']['Running'])
                    self.assertEqual(f.containers[0]['Image'], OLD)
                    self.assertFalse((f.output/'deployed.private.json').exists())
                    if index<2: self.assertFalse(any(args[1] in ('stop','start') or 'up' in args for args in f.calls))
                    else: self.assertTrue((f.output/'rollback.private.json').exists())

    def test_deploy_failure_boundaries_recover_and_keep_original_failure(self):
        for case in ['stop-after','candidate-tag','compose-up','health','wrong-image','interrupt','keyboard']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.baseline()
                if case=='stop-after': f.fault(lambda a:a[1]=='stop',after=True)
                elif case=='candidate-tag': f.fault(lambda a:a[:3]==['docker','tag',NEW],after=True)
                elif case=='compose-up': f.fault(lambda a:'up' in a,after=True)
                elif case=='health': f.unhealthy_candidate=True
                elif case=='wrong-image': f.wrong_candidate=True
                else: f.fault(lambda a:'pg_dump' in a and a[-1]==f.config['database']['names']['runtimeController'],InterruptedError('injected interruption') if case=='interrupt' else KeyboardInterrupt('injected keyboard'))
                expected = KeyboardInterrupt if case=='keyboard' else InterruptedError if case=='interrupt' else ValueError if case=='wrong-image' else RuntimeError
                with self.assertRaises(expected): f.execute('deploy')
                self.assertEqual(f.faults, [])
                self.assertTrue(f.containers[0]['State']['Running'])
                self.assertEqual(f.containers[0]['State']['Health']['Status'],'healthy')
                self.assertEqual(f.containers[0]['Image'], OLD)
                self.assertEqual(f.tags[f.config['images'][SERVICE]['localTag']],OLD)
                self.assertTrue((f.output/'rollback.private.json').exists())
                self.assertFalse((f.output/'deployed.private.json').exists())

    def test_recovery_failure_does_not_hide_original_failure(self):
        f=DeploymentModel(self); f.baseline()
        f.fault(lambda a:'up' in a,RuntimeError('deployment cause'),after=True)
        f.fault(lambda a:a[:3]==['docker','tag',OLD] and a[-1]==f.config['images'][SERVICE]['localTag'],RuntimeError('recovery cause'))
        with self.assertRaisesRegex(RuntimeError,'recovery') as raised: f.execute('deploy')
        self.assertIsNotNone(raised.exception.__cause__)
        self.assertIn('deployment cause',str(raised.exception.__cause__))

    def test_missing_container_is_recreated_with_old_image_and_original_failure(self):
        f=DeploymentModel(self); f.baseline()
        original=RuntimeError('create failed after removal')
        target_id=f.containers[0]['Id']; others=deepcopy(f.containers[1:])
        baseline={p.name:p.read_bytes() for p in f.output.iterdir()}
        def missing():
            f.missing_target=True
            raise original
        f.fault(lambda a:'up' in a,missing)
        with self.assertRaises(RuntimeError) as raised: f.execute('deploy')
        self.assertIs(raised.exception,original)
        self.assertFalse(f.missing_target)
        self.assertNotEqual(f.containers[0]['Id'],target_id)
        self.assertEqual(f.containers[0]['Image'],OLD)
        self.assertTrue(f.containers[0]['State']['Running'])
        self.assertEqual(f.containers[0]['State']['Health']['Status'],'healthy')
        self.assertEqual(f.tags[f.config['images'][SERVICE]['localTag']],OLD)
        self.assertEqual(f.containers[1:],others)
        recovered=json.loads((f.output/'rollback.private.json').read_text())
        self.assertEqual(recovered['container'],f.containers[0])
        self.assertEqual(recovered['original_error'],str(original))
        self.assertFalse((f.output/'deployed.private.json').exists())
        self.assertEqual(len([a for a in f.calls if 'up' in a]),2)
        self.assertEqual(len([a for a in f.calls if a[:4]==['docker','ps','-aq','--filter']]),2)
        for name,data in baseline.items(): self.assertEqual((f.output/name).read_bytes(),data)

    def test_missing_container_recovery_rejects_changed_compose_and_other_identities(self):
        for case in ['compose','postgres-id','runtime-id','foreign-id','foreign-name']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.baseline(); original=RuntimeError('create failed after removal')
                def missing():
                    f.missing_target=True
                    if case=='compose': f.compose['services'][SERVICE]['environment']['CHANGED']='yes'
                    elif case=='foreign-name': f.containers[3]['Name']='/renamed'
                    else: f.containers[{'postgres-id':1,'runtime-id':2,'foreign-id':3}[case]]['Id']='9'*64
                    raise original
                f.fault(lambda a:'up' in a,missing)
                with self.assertRaisesRegex(RuntimeError,'recovery failed') as raised: f.execute('deploy')
                self.assertIs(raised.exception.__cause__,original)
                self.assertTrue(f.missing_target)
                self.assertEqual(len([a for a in f.calls if 'up' in a]),1)
                self.assertFalse((f.output/'rollback.private.json').exists())
                self.assertFalse((f.output/'deployed.private.json').exists())

    def test_missing_container_recovery_rejects_unknown_replacement_and_absence_query_failure(self):
        for case in ['unknown','late-unknown','query-failure']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.baseline(); original=RuntimeError('create failed after removal')
                def missing():
                    f.missing_target=True
                    raise original
                def replacement():
                    f.missing_target=False; f.containers[0]['Id']='9'*64
                f.fault(lambda a:'up' in a,missing)
                if case=='unknown':
                    f.fault(lambda a:a==['docker','inspect',f.containers[0]['Id']] and f.missing_target,replacement)
                else:
                    f.fault(lambda a:a[:4]==['docker','ps','-aq','--filter'],replacement if case=='late-unknown' else RuntimeError('daemon unavailable'),after=case=='late-unknown')
                with self.assertRaisesRegex(RuntimeError,'recovery failed') as raised: f.execute('deploy')
                self.assertIs(raised.exception.__cause__,original)
                self.assertEqual(f.faults,[])
                self.assertEqual(len([a for a in f.calls if 'up' in a]),1)
                self.assertFalse(any(a[:2]==['docker','start'] for a in f.calls))
                self.assertFalse((f.output/'rollback.private.json').exists())

    def test_missing_container_recovery_failure_chains_original_error(self):
        f=DeploymentModel(self); f.baseline(); original=RuntimeError('create failed after removal')
        def missing():
            f.missing_target=True
            raise original
        f.fault(lambda a:'up' in a,missing)
        f.fault(lambda a:'up' in a,RuntimeError('rollback create failed'))
        with self.assertRaisesRegex(RuntimeError,'rollback create failed') as raised: f.execute('deploy')
        self.assertIs(raised.exception.__cause__,original)
        self.assertEqual(f.faults,[])
        self.assertFalse((f.output/'rollback.private.json').exists())
        self.assertFalse((f.output/'deployed.private.json').exists())

    def test_normal_stop_rejects_nonzero_and_oom_and_recovers(self):
        for exit_code,oom in [(7,False),(0,True)]:
            with self.subTest(exit=exit_code,oom=oom):
                f=DeploymentModel(self); f.baseline(); f.stop_exit=exit_code; f.stop_oom=oom
                with self.assertRaises((AssertionError,ValueError)): f.execute('deploy')
                self.assertTrue(f.containers[0]['State']['Running'])

    def test_restart_failure_recovers_same_id_without_claiming_success(self):
        for case in ['stop-after','start','interrupt']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.deployed_baseline(); original=f.containers[0]['Id']
                if case=='stop-after': f.fault(lambda a:a[1]=='stop',after=True)
                else: f.fault(lambda a:a[1]=='start',InterruptedError('interrupted') if case=='interrupt' else RuntimeError('start failed'))
                with self.assertRaises((RuntimeError,InterruptedError)): f.execute('restart')
                self.assertTrue(f.containers[0]['State']['Running']); self.assertEqual(f.containers[0]['Id'],original)
                self.assertTrue((f.output/'restart-recovery.private.json').exists())
                self.assertFalse((f.output/'restarted.private.json').exists())

    def test_after_retains_global_and_full_data_assertions(self):
        for case in ['missing','extra','foreign-stopped','foreign-health','foreign-image','foreign-id','foreign-start','foreign-restart','mount-source','network','row-add','row-delete','row-change','workspace-second-file','environment','healthcheck','local-tag','rollback-tag','active-run','active-operation','healthy-count']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.deployed_baseline(); foreign=f.containers[3]; refs=f.config['images'][SERVICE]
                if case=='missing': f.containers.pop()
                elif case=='extra': row=deepcopy(foreign); row.update(Id='8'*64,Name='/other-2'); f.containers.append(row)
                elif case=='foreign-stopped': foreign['State']['Running']=False
                elif case=='foreign-health': foreign['State']['Health']['Status']='unhealthy'
                elif case=='foreign-image': foreign['Image']=NEW
                elif case=='foreign-id': foreign['Id']='8'*64
                elif case=='foreign-start': foreign['State']['StartedAt']='2026-09-22T00:00:00Z'
                elif case=='foreign-restart': foreign['RestartCount']=1
                elif case=='mount-source': f.containers[2]['Mounts'][0]['Source']='/changed'
                elif case=='network': foreign['NetworkSettings']['Networks']['other']={}
                elif case=='row-add': f.rows['runs']['extra']='e'*32
                elif case=='row-delete': f.rows['runs'].clear()
                elif case=='row-change': f.rows['runs']['runs-row']='e'*32
                elif case=='workspace-second-file': f.manifest=b'changed  ./second\n'
                elif case=='environment': f.containers[0]['Config']['Env']=[]
                elif case=='healthcheck': f.containers[0]['Config']['Healthcheck']['Test']=['CMD','false']
                elif case=='local-tag': f.tags[refs['localTag']]=OLD
                elif case=='rollback-tag': f.tags[refs['rollbackTag']]=NEW
                elif case=='active-run': f.active_runs=1
                elif case=='active-operation': f.active_operations=1
                elif case=='healthy-count': f.containers[2]['State']['Health']={'Status':'healthy'}
                with self.assertRaises((AssertionError,ValueError,RuntimeError)): f.execute('after')
                self.assertFalse((f.output/'after.json').exists())

    def test_invalid_unaffected_expectation_rejects_before_commands(self):
        f=DeploymentModel(self); f.config['expected']['unaffectedProcesses']=2
        with self.assertRaises((AssertionError,ValueError)): f.execute('before')
        self.assertEqual(f.calls, [])

    def test_changes_during_backup_do_not_target_a_replacement_or_strand_old_service(self):
        for case in ['compose','replacement']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.baseline()
                def change():
                    if case=='compose': f.compose['services'][SERVICE]['environment']['CHANGED']='yes'
                    else: f.containers[0]['Id']='9'*64
                f.fault(lambda a:'pg_dump' in a and a[-1]==f.config['database']['names']['runtimeController'], change)
                with self.assertRaises((ValueError,RuntimeError)): f.execute('deploy')
                self.assertFalse(any('up' in a for a in f.calls))
                if case=='compose': self.assertTrue(f.containers[0]['State']['Running'])
                else: self.assertFalse(any(a[1]=='start' and a[-1]=='9'*64 for a in f.calls))

    def test_report_failures_after_stop_recover_and_stay_failed(self):
        import runtime_deployment
        original=runtime_deployment.write_runtime_report
        for filename in ['deployment-stops.json','backups.json','deployed.private.json','restart-stops.json','restarted.private.json']:
            with self.subTest(filename=filename):
                f=DeploymentModel(self); restart=filename.startswith('restart')
                f.deployed_baseline() if restart else f.baseline()
                def write(config,name,value,**kwargs):
                    if name==filename: raise OSError('report write failed')
                    return original(config,name,value,**kwargs)
                with patch('runtime_deployment.write_runtime_report',side_effect=write):
                    with self.assertRaisesRegex(OSError,'report write failed'): f.execute('restart' if restart else 'deploy')
                self.assertTrue(f.containers[0]['State']['Running'])
                self.assertEqual(f.containers[0]['Image'],NEW if restart else OLD)

    def test_sigterm_recovers_and_restores_signal_handlers(self):
        for mode in ['deploy','restart']:
            with self.subTest(mode=mode):
                f=DeploymentModel(self); f.deployed_baseline() if mode=='restart' else f.baseline()
                previous=signal.getsignal(signal.SIGTERM)
                predicate=(lambda a:a[1]=='start') if mode=='restart' else (lambda a:'pg_dump' in a and a[-1]==f.config['database']['names']['runtimeController'])
                f.fault(predicate,lambda:signal.raise_signal(signal.SIGTERM))
                # A repeated signal in the recovery start is deferred.
                f.fault(lambda a:a[1]=='start',lambda:signal.raise_signal(signal.SIGTERM))
                with self.assertRaises(InterruptedError): f.execute(mode)
                self.assertTrue(f.containers[0]['State']['Running'])
                self.assertEqual(signal.getsignal(signal.SIGTERM),previous)

    def test_after_rechecks_idle_identity_environment_and_tags_after_workspace_read(self):
        for case in ['active-run','active-operation','environment','healthcheck','target-id','local-tag','rollback-tag']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.deployed_baseline()
                def change():
                    if case=='active-run': f.active_runs=1
                    elif case=='active-operation': f.active_operations=1
                    elif case=='environment': f.containers[0]['Config']['Env']=[]
                    elif case=='healthcheck': f.containers[0]['Config']['Healthcheck']['Test']=['CMD','false']
                    elif case=='target-id': f.containers[0]['Id']='9'*64
                    else: f.tags[f.config['images'][SERVICE]['localTag' if case=='local-tag' else 'rollbackTag']]='sha256:'+'e'*64
                f.fault(lambda a:a[:2]==['docker','exec'] and 'sh' in a,change)
                with self.assertRaises((ValueError,subprocess.CalledProcessError)): f.execute('after')
                self.assertFalse((f.output/'after.json').exists())

    def test_workspace_shell_hashes_all_files_empty_bytes_and_propagates_find_and_hash_errors(self):
        f=DeploymentModel(self); f.execute('before')
        script=next(args[-1] for args in f.calls if args[:2]==['docker','exec'] and 'sh' in args)
        workspace=f.root/'workspace with spaces'; workspace.mkdir()
        binary=f.root/'bin'; binary.mkdir()
        hasher=binary/'sha256sum'
        hasher.write_text('#!'+sys.executable+'\nimport hashlib,os,sys\nif os.environ.get("HASH_FAIL"): sys.exit(31)\nfor name in sys.argv[1:]:\n with open(name,"rb") as f: print(hashlib.sha256(f.read()).hexdigest()+"  "+name)\n')
        hasher.chmod(0o700)
        finder=binary/'find'; finder.write_text('#!/bin/sh\nif [ -n "$FIND_FAIL" ]; then exit 32; fi\nexec /usr/bin/find "$@"\n'); finder.chmod(0o700)
        script=script.replace('cd /workspace ', 'cd '+shlex.quote(str(workspace))+' ', 1)
        def shell(extra=None):
            return subprocess.run(['/bin/sh','-c',script],env={**os.environ,'PATH':str(binary)+':/usr/bin:/bin',**(extra or {})},capture_output=True,timeout=10)
        empty=shell(); self.assertEqual(empty.returncode,0,empty.stderr); self.assertEqual(empty.stdout,b'')
        (workspace/'first').write_bytes(b'one'); (workspace/'second').write_bytes(b'two')
        result=shell(); expected=''.join(sorted(hashlib.sha256(value).hexdigest()+'  ./'+name+'\n' for name,value in [('first',b'one'),('second',b'two')]))
        self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(result.stdout,expected.encode())
        (workspace/'second').write_bytes(b'changed'); self.assertNotEqual(shell().stdout,result.stdout)
        for variable in ['FIND_FAIL','HASH_FAIL']:
            failed=shell({variable:'1'}); self.assertNotEqual(failed.returncode,0); self.assertEqual(failed.stdout,b'')

    def test_restart_rejects_unchanged_start_time_or_replacement(self):
        for case in ['same-time','replacement','non-exited']:
            with self.subTest(case=case):
                f=DeploymentModel(self); f.deployed_baseline(); started=f.containers[0]['State']['StartedAt']
                command=f.command
                def changed(args,**kwargs):
                    result=command(args,**kwargs)
                    if args[1]=='start':
                        if case=='same-time': f.containers[0]['State']['StartedAt']=started
                        elif case=='replacement': f.containers[0]['Id']='9'*64
                    if args[1]=='stop' and case=='non-exited': f.containers[0]['State']['Status']='dead'
                    return result
                f.command=changed
                with self.assertRaises((ValueError,RuntimeError)): f.execute('restart')
                self.assertFalse((f.output/'restarted.private.json').exists())

    def test_bad_candidate_configuration_can_be_rolled_back_by_its_bound_identity(self):
        for field in ['environment','healthcheck','mounts']:
            for compose_failure in [False,True]:
                with self.subTest(field=field,compose_failure=compose_failure):
                    f=DeploymentModel(self); f.baseline()
                    def damage():
                        row=f.containers[0]
                        if field=='environment': row['Config']['Env']=[]
                        elif field=='healthcheck': row['Config']['Healthcheck']['Test']=['CMD','false']
                        else: row['Mounts']=[dict(Destination='/unexpected',Type='bind',Source='/tmp',RW=True)]
                        if compose_failure: raise RuntimeError('original compose failure')
                    f.fault(lambda a:'up' in a,damage,after=True)
                    # Compose restores configured environment/mounts on recreation.
                    command=f.command
                    def restored(args,**kwargs):
                        if 'up' in args and f.tags[f.config['images'][SERVICE]['localTag']]==OLD:
                            baseline=json.loads((f.output/'containers.private.json').read_text())[0]
                            f.containers[0]['Config']=baseline['Config']; f.containers[0]['Mounts']=baseline['Mounts']
                        return command(args,**kwargs)
                    f.command=restored
                    with self.assertRaisesRegex(RuntimeError if compose_failure else ValueError,'original compose failure' if compose_failure else 'differs|changed'): f.execute('deploy')
                    self.assertEqual(f.containers[0]['Image'],OLD)
                    self.assertTrue(f.containers[0]['State']['Running'])
                    self.assertTrue((f.output/'rollback.private.json').exists())

    def test_compose_failure_is_preserved_when_observing_its_result_also_fails(self):
        f=DeploymentModel(self); f.baseline()
        original=RuntimeError('original compose failure')
        f.fault(lambda a:'up' in a,original,after=True)
        f.fault(lambda a:a[:2]==['docker','inspect'] and a[2]==f.config['project']+'-'+SERVICE+'-1' and any('up' in call for call in f.calls),RuntimeError('inspection unavailable'))
        with self.assertRaisesRegex(RuntimeError,'recovery failed') as raised: f.execute('deploy')
        self.assertIs(raised.exception.__cause__,original)
        self.assertTrue(any('inspection unavailable' in note for note in original.__notes__))
        self.assertEqual(len([args for args in f.calls if 'up' in args]),1)


if __name__ == '__main__': unittest.main()
