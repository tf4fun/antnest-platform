"""Temporal dependency order, complete-daemon checks and recovery contracts."""
from copy import deepcopy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

from runtime_deployment_test import DeploymentModel, ROOT, OLD, NEW, TABLES
ENTRY=ROOT/'tests/e2e/development/deployment/temporal-20260921.py'
SERVICES=('temporal','agent-controller')


class TemporalModel(DeploymentModel):
    def __init__(self,test):
        super().__init__(test)
        refs=self.config['images'].pop('runtime-controller');refs.pop('candidateTag')
        refs.update(localTag='fixture/temporal:local',rollbackTag='fixture/temporal:rollback')
        self.config['images']={'temporal':refs,'agent-controller':dict(rollbackTag='fixture/agent:rollback')}
        self.config['database']['names']=dict(temporal='fixture_temporal',temporalVisibility='fixture_visibility',agentController='fixture_agent',acp='fixture_acp')
        target=self.containers[0];target['Name']='/'+self.config['project']+'-temporal-1';target['Config']['Labels']['com.docker.compose.service']='temporal'
        target['Config']['Healthcheck']['Test']=['CMD','sh','/etc/temporal/readiness.sh']
        self.compose['services']['temporal']=self.compose['services'].pop('runtime-controller')
        self.compose['services']['temporal'].update(image=refs['localTag'],healthcheck=dict(test=['CMD','sh','/etc/temporal/readiness.sh']))
        for index,service in [(5,'agent-controller'),(6,'runtime-controller')]:
            row=deepcopy(target);row['Id']=str(index)*64;row['Name']='/'+self.config['project']+'-'+service+'-1';row['Config']['Labels']['com.docker.compose.service']=service
            row['Config']['Healthcheck']['Test']=['CMD','true'];self.containers.append(row)
            self.compose['services'][service]=dict(image='fixture/'+service+':local',environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=self.config['project']),healthcheck=dict(test=['CMD','true']))
        self.compose_file.write_text(json.dumps(self.compose))
        self.config['expected']=dict(containers=6,healthy=5,unaffectedProcesses=4)
        self.tags={refs['localTag']:NEW,'fixture/agent-controller:local':OLD,'fixture/runtime-controller:local':OLD}
        self.missing=set();self.calls=[];self.backups=[];self.events=[];self.bad_service=None

    def target(self,service):return next(row for row in self.containers if row['Config']['Labels'].get('com.docker.compose.service')==service)
    def row(self,ref):
        row=super().row(ref)
        if row['Config']['Labels'].get('com.docker.compose.service') in self.missing:raise subprocess.CalledProcessError(1,['docker','inspect',ref])
        return row
    def begin(self,args):
        self.calls.append(args);fault=next((item for item in self.faults if item[0](args)),None)
        if fault:
            self.faults.remove(fault)
            if not fault[2]:
                if callable(fault[1]):fault[1]()
                else:raise fault[1]
        return fault
    def command(self,args,**kwargs):
        fault=self.begin(args);value=''
        if args==['docker','ps','-aq']:value='\n'.join(row['Id'] for row in self.containers if row['Config']['Labels'].get('com.docker.compose.service') not in self.missing)
        elif args[:4]==['docker','ps','-aq','--filter']:
            name=args[-1].removeprefix('name=^/')[:-1];row=next(row for row in self.containers if row['Name']=='/'+name)
            value='' if row['Config']['Labels'].get('com.docker.compose.service') in self.missing else row['Id']
        elif args[:2]==['docker','inspect']:
            value=json.dumps([dict(Id=self.tags[ref]) if ref in self.tags else self.row(ref) for ref in args[2:]])
        elif args==self.config['compose']+['config','--format','json']:value=json.dumps(self.compose)
        elif args[:4]==['docker','image','ls','-q']:value=self.tags.get(args[-1].removeprefix('reference='),'')
        elif args[:2]==['docker','tag']:self.tags[args[-1]]=self.tags.get(args[-2],args[-2])
        elif args[:2]==['docker','stop']:
            row=self.row(args[-1]);service=row['Config']['Labels']['com.docker.compose.service'];self.test.assertIn(service,SERVICES)
            self.events.append(('stop',service));row['State'].update(Running=False,Status='exited',ExitCode=self.stop_exit,OOMKilled=self.stop_oom,FinishedAt='2026-09-23T00:00:00Z')
        elif args[:2]==['docker','start']:
            row=self.row(args[-1]);service=row['Config']['Labels']['com.docker.compose.service']
            if service=='agent-controller':self.test.assertTrue(self.target('temporal')['State']['Running']);self.test.assertEqual(self.target('temporal')['State']['Health']['Status'],'healthy')
            self.events.append(('start',service));self.start(row)
        elif args[:len(self.config['compose'])]==self.config['compose'] and 'up' in args:
            service=args[-1];prefix=args[len(self.config['compose']):args.index('up')];self.test.assertTrue(not prefix or len(prefix)==2 and prefix[0]=='-f')
            self.test.assertEqual(args[args.index('up'):-1],['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','180'])
            if service=='agent-controller':self.test.assertTrue(self.target('temporal')['State']['Running']);self.test.assertEqual(self.target('temporal')['State']['Health']['Status'],'healthy')
            row=self.target(service);effective=json.loads(Path(prefix[1]).read_text())['services'][service] if prefix else self.compose['services'][service]
            image=effective['image'] if effective['image'].startswith('sha256:') else self.tags[effective['image']]
            row['Config']['Healthcheck']['Test']=effective['healthcheck']['test']
            if service in self.missing or row['Image']!=image or service=='agent-controller':row['Id']=('7' if image==NEW else '8' if service=='temporal' else '9')*64
            self.missing.discard(service);row['Image']=image;row['Mounts']=[];row['NetworkSettings']['Networks']={self.config['project']:{}};self.start(row);self.events.append(('up',service))
            if self.bad_service==service and not prefix and (service!='temporal' or image==NEW):row['State']['Health']['Status']='unhealthy'
        elif args[:2]==['docker','exec'] and 'psql' in args:
            self.test.assertEqual(self.row(args[2])['Id'],self.containers[1]['Id']);query=args[-1]
            if query=="SELECT count(*) FROM runs WHERE state IN ('admitting','running')":value=str(self.active_runs);database=self.config['database']['names']['acp']
            elif query=="SELECT count(*) FROM agent_controller.agents WHERE active_operation_request_id <> ''":value=str(self.active_operations);database=self.config['database']['names']['agentController']
            else:
                table=next(t for t in TABLES if query==f"SELECT coalesce(jsonb_object_agg(id,md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {t} t")
                value=json.dumps(self.rows[table]);database=self.config['database']['names']['acp']
            self.test.assertEqual(args[3:],['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',self.config['database']['user'],'-d',database,'-c',query])
        elif args[:2]==['docker','exec'] and 'sh' in args:self.test.assertEqual(self.row(args[2])['Id'],self.containers[2]['Id']);value=self.manifest.decode()
        else:self.test.fail('unexpected command '+repr(args))
        if fault and fault[2]:
            if callable(fault[1]):fault[1]()
            else:raise fault[1]
        return value if kwargs.get('text') else value.encode()
    def process(self,args,**kwargs):
        self.begin(args)
        self.test.assertTrue(all(not self.target(s)['State']['Running'] for s in SERVICES),'backups require both services stopped')
        if 'pg_dump' in args:
            database=list(self.config['database']['names'].values())[len(self.backups)];self.backups.append(database)
            self.test.assertEqual(args[3:],['pg_dump','-U',self.config['database']['user'],'-Fc',database]);self.test.assertEqual(args[2],self.containers[1]['Id'])
            self.last_dump=b'PGDMP-'+database.encode();kwargs['stdout'].write(self.last_dump)
            self.test.assertEqual(os.fstat(kwargs['stdout'].fileno()).st_mode&0o777,0o600);self.events.append(('backup',database))
        elif 'pg_restore' in args:self.test.assertEqual(args[3],self.containers[1]['Id']);self.test.assertEqual(kwargs['stdin'].read(),self.last_dump)
        else:self.test.fail('unexpected process '+repr(args))
        return subprocess.CompletedProcess(args,0)
    def execute(self,mode):
        file=self.root/'config.json';file.write_text(json.dumps(self.config));stdout=io.StringIO()
        def interrupt(signum,frame):raise InterruptedError('fixture unhandled signal')
        previous=signal.signal(signal.SIGTERM,interrupt)
        try:
            with patch.object(sys,'argv',[str(ENTRY),'--config',str(file),mode]),patch('subprocess.check_output',side_effect=self.command),patch('subprocess.run',side_effect=self.process),patch('time.monotonic',side_effect=self.tick),patch('time.sleep'),contextlib.redirect_stdout(stdout):runpy.run_path(str(ENTRY),run_name='__main__')
        finally:signal.signal(signal.SIGTERM,previous)
        return json.loads(stdout.getvalue())


class TemporalDeploymentTests(unittest.TestCase):
    def test_five_modes_keep_dependency_order_backups_and_original_report(self):
        f=TemporalModel(self);f.manifest=b'hash  ./note\n';f.baseline();saved={p.name:p.read_bytes() for p in f.output.iterdir()}
        self.assertTrue((f.output/'deployment-context.private.json').exists())
        self.assertEqual(f.execute('deploy')['backups'],4)
        self.assertEqual(f.events,[('stop','agent-controller'),('stop','temporal'),*[('backup',d) for d in f.config['database']['names'].values()],('up','temporal'),('up','agent-controller')])
        first=f.execute('after');f.events.clear();ids={s:f.target(s)['Id'] for s in SERVICES}
        self.assertTrue(f.execute('restart')['same_containers']);self.assertEqual(f.events,[('stop','agent-controller'),('stop','temporal'),('start','temporal'),('start','agent-controller')])
        self.assertEqual({s:f.target(s)['Id'] for s in SERVICES},ids)
        self.assertEqual(f.execute('after'),first);f.target('agent-controller')['State']['Running']=False;f.events.clear()
        self.assertTrue(f.execute('resume')['temporal_ready_before_controller']);self.assertEqual(f.events,[('start','agent-controller')])
        self.assertEqual(first,dict(status='passed',containers=6,healthy=5,unaffected_processes=4,original_rows={t:1 for t in TABLES},workspace_unchanged=True,runtime_unchanged=True,active_runs=0,temporal_image=NEW))
        for name,value in saved.items():self.assertEqual((f.output/name).read_bytes(),value)
        for call in f.calls:
            if call[:2] in [['docker','stop'],['docker','start']]:self.assertRegex(call[-1],r'^[a-f0-9]{64}$')
            if call[:2]==['docker','exec']:self.assertRegex(call[3] if call[2]=='-i' else call[2],r'^[a-f0-9]{64}$')

    def test_output_conflicts_and_bound_inputs_fail_before_commands(self):
        cases={'before':['before.json','rows-before.json','compose.private.json','containers.private.json','deployment-context.private.json'],
            'deploy':['deployment-stops.json','backups.json','temporal-deployed.private.json','agent-controller-deployed.private.json','rollback.private.json','rollback-compose.private.json',*['fixture_'+d+'.dump' for d in ['temporal','visibility','agent','acp']]],
            'restart':['restart-stops.json','restarted.private.json','restart-recovery.private.json'],'resume':['resumed.private.json','resume-recovery.private.json'],'after':['after.json']}
        for mode,names in cases.items():
            for name in names:
                with self.subTest(mode=mode,name=name):
                    f=TemporalModel(self)
                    if mode=='deploy':f.baseline()
                    elif mode!='before':f.deployed_baseline()
                    f.output.mkdir(exist_ok=True);(f.output/name).mkdir();f.calls.clear()
                    with self.assertRaises((ValueError,AssertionError,FileExistsError)):f.execute(mode)
                    self.assertEqual(f.calls,[])
        for change in ['config','compose','full','context','alias']:
            with self.subTest(change=change):
                f=TemporalModel(self)
                if change!='alias':f.baseline()
                if change=='config':f.config['database']['user']='other'
                elif change=='compose':f.compose_file.write_text(f.compose_file.read_text()+'\n')
                elif change=='full':(f.output/'containers.private.json').write_text('[]')
                elif change=='context':(f.output/'deployment-context.private.json').unlink(missing_ok=True)
                else:f.config['images']['agent-controller']['rollbackTag']='docker.io/'+f.config['images']['temporal']['localTag']
                f.calls.clear()
                with self.assertRaises((ValueError,AssertionError,FileNotFoundError)):f.execute('before' if change=='alias' else 'deploy')
                self.assertEqual(f.calls,[])

    def test_all_eight_archive_failures_restore_old_services_in_order(self):
        for tool in ['pg_dump','pg_restore']:
            for index in range(4):
                with self.subTest(tool=tool,index=index):
                    f=TemporalModel(self);f.baseline();seen=[0]
                    def match(args):
                        if tool not in args:return False
                        seen[0]+=1;return seen[0]==index+1
                    f.fault(match)
                    with self.assertRaisesRegex(RuntimeError,'injected failure'):f.execute('deploy')
                    self.assertTrue(all(f.target(s)['State']['Running'] and f.target(s)['Image']==OLD for s in SERVICES))
                    self.assertEqual([e for e in f.events if e[0]=='start'],[('start','temporal'),('start','agent-controller')])
                    self.assertEqual(json.loads((f.output/'rollback.private.json').read_text())['status'],'recovered')

    def test_deploy_failures_restore_both_services_and_keep_failure(self):
        for service in SERVICES:
            for kind in ['stop','compose','missing','signal','unhealthy']:
                with self.subTest(service=service,kind=kind):
                    f=TemporalModel(self);f.baseline()
                    if kind=='unhealthy':f.bad_service=service
                    else:
                        def match(args):return (args[:2]==['docker','stop'] and args[-1]==f.target(service)['Id']) if kind=='stop' else 'up' in args and args[-1]==service
                        def failure():
                            if kind=='missing':f.missing.add(service)
                            if kind=='signal':signal.raise_signal(signal.SIGTERM)
                            raise RuntimeError('injected failure')
                        f.fault(match,failure,after=kind in ('stop','compose','signal'))
                    with self.assertRaises((RuntimeError,ValueError,InterruptedError)):f.execute('deploy')
                    self.assertTrue(all(f.target(s)['State']['Running'] and f.target(s)['Image']==OLD for s in SERVICES));self.assertEqual(f.missing,set())
                    self.assertEqual(json.loads((f.output/'rollback.private.json').read_text())['status'],'recovered')

    def test_removed_old_temporal_recovers_its_original_probe(self):
        f=TemporalModel(self);f.target('temporal')['Config']['Healthcheck']['Test']=['CMD','nc','-z','localhost','7233'];f.baseline()
        def fail():f.missing.add('temporal');raise RuntimeError('injected create failure')
        f.fault(lambda a:'up' in a and a[-1]=='temporal',fail)
        with self.assertRaisesRegex(RuntimeError,'injected create failure'):f.execute('deploy')
        self.assertEqual(f.target('temporal')['Config']['Healthcheck']['Test'],['CMD','nc','-z','localhost','7233'])
        override=json.loads((f.output/'rollback-compose.private.json').read_text())
        self.assertEqual(override['services']['temporal']['image'],OLD)
        self.assertTrue(f.target('agent-controller')['State']['Running'])

    def test_resume_waits_for_temporal_without_starting_it_or_using_idle_gate(self):
        f=TemporalModel(self);f.deployed_baseline();f.target('agent-controller')['State']['Running']=False;f.events.clear();f.active_runs=1;f.active_operations=1
        f.execute('resume');self.assertEqual(f.events,[('start','agent-controller')])
        f=TemporalModel(self);f.deployed_baseline();f.target('temporal')['State']['Health']['Status']='unhealthy';f.target('agent-controller')['State']['Running']=False;f.events.clear()
        with self.assertRaises((RuntimeError,ValueError)):f.execute('resume')
        self.assertEqual(f.events,[]);self.assertFalse((f.output/'resumed.private.json').exists())

    def test_candidate_mount_or_network_change_fails_and_recovers(self):
        for service in SERVICES:
            for change in ['mount','network']:
                with self.subTest(service=service,change=change):
                    f=TemporalModel(self);f.baseline()
                    def mutate():
                        row=f.target(service)
                        if change=='mount':row['Mounts']=[dict(Type='bind',Source='/unexpected',Destination='/data',RW=True)]
                        else:row['NetworkSettings']['Networks']={'unexpected':{}}
                    f.fault(lambda a:'up' in a and a[-1]==service,mutate,after=True)
                    with self.assertRaises((ValueError,RuntimeError)):f.execute('deploy')
                    self.assertFalse((f.output/(service+'-deployed.private.json')).exists())
                    self.assertEqual(json.loads((f.output/'rollback.private.json').read_text())['status'],'recovered')

    def test_resume_completes_partial_temporal_deployment_for_after_and_restart(self):
        f=TemporalModel(self);f.baseline()
        temporal=f.target('temporal');temporal['Image']=NEW;temporal['Id']='7'*64
        f.put('temporal-deployed.private.json',temporal)
        f.target('agent-controller')['State']['Running']=False
        f.execute('resume')
        self.assertEqual(f.execute('after')['status'],'passed')
        self.assertEqual(f.execute('restart')['status'],'restart_passed')

    def test_candidate_probe_cannot_degrade_before_restart_or_resume(self):
        for mode in ['restart','resume']:
            for location in ['live','record']:
                with self.subTest(mode=mode,location=location):
                    f=TemporalModel(self);f.deployed_baseline();f.events.clear()
                    if location=='live':f.target('temporal')['Config']['Healthcheck']['Test']=['CMD','true']
                    else:
                        path=f.output/'temporal-deployed.private.json';row=json.loads(path.read_text());row['Config']['Healthcheck']['Test']=['CMD','true'];path.write_text(json.dumps(row))
                    with self.assertRaises(ValueError):f.execute(mode)
                    self.assertEqual(f.events,[])

    def test_live_roles_and_tags_are_bound_before_stopping(self):
        for change in ['temporal-id','agent-id','postgres-id','runtime-id','foreign-id','scope','project','compose','candidate','rollback','agent-image']:
            with self.subTest(change=change):
                f=TemporalModel(self);f.baseline();f.calls.clear()
                if change.endswith('-id'):f.containers[{'temporal-id':0,'agent-id':4,'postgres-id':1,'runtime-id':2,'foreign-id':3}[change]]['Id']='f'*64
                elif change=='scope':f.containers[2]['Config']['Labels']['io.antnest.runtime-controller-scope']='other'
                elif change=='project':f.target('temporal')['Config']['Labels']['com.docker.compose.project']='other'
                elif change=='compose':f.compose['services']['agent-controller']['environment']['CHANGED']='yes'
                elif change=='candidate':f.tags[f.config['images']['temporal']['localTag']]=OLD
                elif change=='rollback':f.tags[f.config['images']['agent-controller']['rollbackTag']]=NEW
                else:f.tags['fixture/agent-controller:local']=NEW
                with self.assertRaises((ValueError,AssertionError)):f.execute('deploy')
                self.assertEqual(f.mutations(),[])

    def test_restart_and_resume_failures_keep_order_and_original_failure(self):
        for mode in ['restart','resume']:
            f=TemporalModel(self);f.deployed_baseline();f.events.clear()
            if mode=='resume':f.target('agent-controller')['State']['Running']=False
            f.fault(lambda a:a[:2]==['docker','start'] and a[-1]==f.target('agent-controller')['Id'],RuntimeError('start failed'),after=True)
            with self.assertRaisesRegex(RuntimeError,'start failed'):f.execute(mode)
            self.assertTrue(all(f.target(s)['State']['Running'] for s in SERVICES))
            self.assertTrue((f.output/(mode+'-recovery.private.json')).exists())
        f=TemporalModel(self);f.baseline()
        f.fault(lambda a:'pg_dump' in a,RuntimeError('backup failed'))
        f.fault(lambda a:a[:2]==['docker','start'] and a[-1]==f.target('temporal')['Id'],RuntimeError('Temporal cannot recover'))
        with self.assertRaisesRegex(RuntimeError,'recovery failed') as error:f.execute('deploy')
        self.assertEqual(str(error.exception.__cause__),'backup failed')
        self.assertFalse(f.target('agent-controller')['State']['Running'])

    def test_after_rejects_added_rows_workspace_process_and_readiness_drift(self):
        for change in ['added-row','workspace','runtime-id','foreign-start','foreign-restart','foreign-image','stopped-foreign','mount','network','readiness','active','environment']:
            with self.subTest(change=change):
                f=TemporalModel(self);f.deployed_baseline()
                if change=='added-row':f.rows['runs']['new']='f'*32
                elif change=='workspace':f.manifest=b'changed'
                elif change=='runtime-id':f.containers[2]['Id']='f'*64
                elif change=='foreign-start':f.containers[3]['State']['StartedAt']='2026-09-23T00:00:00Z'
                elif change=='foreign-restart':f.containers[3]['RestartCount']=1
                elif change=='foreign-image':f.containers[3]['Image']=NEW
                elif change=='stopped-foreign':f.containers[3]['State']['Running']=False
                elif change=='mount':f.containers[2]['Mounts'][0]['Source']='/other'
                elif change=='network':f.containers[3]['NetworkSettings']['Networks']={}
                elif change=='readiness':f.target('temporal')['Config']['Healthcheck']['Test']=['CMD','true']
                elif change=='active':f.active_operations=1
                else:f.target('agent-controller')['Config']['Env']=[]
                with self.assertRaises((ValueError,AssertionError)):f.execute('after')
                self.assertFalse((f.output/'after.json').exists())


if __name__=='__main__':unittest.main()
