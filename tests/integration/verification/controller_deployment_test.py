"""Controller 20260921 entry contracts using a complete running-daemon model."""
from copy import deepcopy
import contextlib
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

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/support/verification'))
from runtime_deployment_configuration_test import RuntimeConfigurationFixture, OLD, NEW, TABLES
ENTRY=ROOT/'tests/e2e/development/deployment/controller-20260921.py'
SERVICE='agent-controller'


class ControllerModel(RuntimeConfigurationFixture):
    def __init__(self,test):
        super().__init__(test,False)
        self.test=test
        self.config['images']={SERVICE:self.config['images'].pop('runtime-controller')}
        self.config['expected']=dict(containers=5,healthy=4,otherContainersUnchanged=3)
        self.config['reports']=dict(recovery=str(self.root/'recovered-runtime.json'))
        target=self.containers[0]
        target['Name']='/'+self.config['project']+'-'+SERVICE+'-1'
        target['Config']['Labels']['com.docker.compose.service']=SERVICE
        rtc=deepcopy(target);rtc['Id']='5'*64;rtc['Name']='/'+self.config['project']+'-runtime-controller-1'
        rtc['Config']['Labels']['com.docker.compose.service']='runtime-controller'
        self.containers.append(rtc)
        self.compose['services'][SERVICE]=self.compose['services'].pop('runtime-controller')
        self.compose['services']['runtime-controller']=dict(image='fixture/runtime-controller:local',environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=self.config['project']))
        self.compose_file.write_text(json.dumps(self.compose))
        refs=self.config['images'][SERVICE]
        self.tags={refs['localTag']:OLD,refs['candidateTag']:NEW}
        self.calls=[];self.faults=[];self.active=0;self.backups=[]
        self.wrong_image=False;self.unhealthy=False
        self.missing_target=False

    def row(self,name):
        row=next((row for row in self.containers if name in (row['Id'],row['Name'].lstrip('/'))),None)
        if row is self.containers[0] and self.missing_target:row=None
        if row is None:raise subprocess.CalledProcessError(1,['docker','inspect',name])
        return row

    def fault(self,predicate,error,after=False):
        self.faults.append((predicate,error,after))

    def begin(self,args):
        self.calls.append(args)
        item=next((item for item in self.faults if item[0](args)),None)
        if item:
            self.faults.remove(item)
            if not item[2]:
                if callable(item[1]):item[1]()
                else:raise item[1]
        return item

    def command(self,args,**kwargs):
        fault=self.begin(args);value=''
        if args==['docker','ps','--format','{{.Names}}']:
            value='\n'.join(row['Name'].lstrip('/') for row in self.containers if row['State']['Running'] and not (row is self.containers[0] and self.missing_target))
        elif args[:4]==['docker','ps','-aq','--filter']:
            self.test.assertEqual(args[-1],'name=^/'+self.config['project']+'-'+SERVICE+'-1$')
            value='' if self.missing_target else self.containers[0]['Id']
        elif args[:2]==['docker','inspect'] or args[:3]==['docker','image','inspect']:
            refs=args[3:] if args[1]=='image' else args[2:]
            value=json.dumps([dict(Id=self.tags[name]) if name in self.tags else self.row(name) for name in refs])
        elif args==self.config['compose']+['config','--format','json']:value=json.dumps(self.compose)
        elif args[:4]==['docker','image','ls','-q']:value=self.tags.get(args[-1].removeprefix('reference='),'')
        elif args==['git','rev-parse','HEAD']:value='d'*40
        elif args[:2]==['docker','tag']:self.tags[args[-1]]=self.tags.get(args[-2],args[-2])
        elif args[:2]==['docker','start']:
            self.row(args[-1])['State'].update(Running=True,Status='running',Health=dict(Status='healthy'))
        elif args[:2]==['docker','exec'] and 'psql' in args:
            self.test.assertEqual(self.row(args[3])['Id'],self.containers[1]['Id'])
            query=kwargs['input'].decode()
            self.test.assertEqual(args[4:],['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',self.config['database']['user'],'-d',self.config['database']['names']['acp']])
            if query=="SELECT count(*) FROM runs WHERE state IN ('admitting','running');":value=str(self.active)
            else:
                table=next(table for table in TABLES if query==f"SELECT coalesce(jsonb_object_agg(id, md5(row_to_json(t)::text)), '{{}}'::jsonb) FROM {table} t;")
                value=json.dumps(self.rows[table])
        elif args[:len(self.config['compose'])]==self.config['compose'] and 'up' in args:
            self.compose_up(args)
        else:self.test.fail('unexpected command '+repr(args))
        if fault and fault[2]:
            if callable(fault[1]):fault[1]()
            else:raise fault[1]
        return value if kwargs.get('text') else value.encode()

    def compose_up(self,args):
        self.test.assertEqual(args[len(self.config['compose']):],['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120',SERVICE])
        row=self.containers[0];image=self.tags[self.config['images'][SERVICE]['localTag']]
        self.missing_target=False
        row['Id']=('6' if image==NEW else '8')*64;row['Image']=image
        row['State'].update(Running=True,Status='running',Health=dict(Status='unhealthy' if self.unhealthy and image==NEW else 'healthy'))
        # Compose recreates the configured environment/healthcheck.
        row['Config']['Env']=['ANTNEST_RUNTIME_CONTROLLER_SCOPE='+self.config['project']]
        row['Config']['Healthcheck']=dict(Test=['CMD','true'])
        row['Mounts']=[]
        if image==NEW and self.wrong_image:row['Image']='sha256:'+'f'*64

    def process(self,args,**kwargs):
        fault=self.begin(args)
        if 'up' in args:self.compose_up(args)
        elif 'pg_dump' in args:
            expected=[self.config['database']['names'][role] for role in ['agentController','runtimeController','acp']][len(self.backups)]
            self.test.assertEqual(args[3:],['pg_dump','-U',self.config['database']['user'],'-Fc',expected])
            self.test.assertEqual(self.row(args[2])['Id'],self.containers[1]['Id'])
            self.last_dump=b'PGDMP-'+expected.encode();kwargs['stdout'].write(self.last_dump)
            self.test.assertEqual(os.fstat(kwargs['stdout'].fileno()).st_mode&0o777,0o600)
            self.backups.append(expected)
        elif 'pg_restore' in args:
            self.test.assertEqual(args[4:],['pg_restore','--list'])
            self.test.assertEqual(self.row(args[3])['Id'],self.containers[1]['Id'])
            self.test.assertEqual(kwargs['stdin'].read(),self.last_dump)
        else:self.test.fail('unexpected process '+repr(args))
        if fault and fault[2]:
            if callable(fault[1]):fault[1]()
            else:raise fault[1]
        return subprocess.CompletedProcess(args,0)

    def execute(self,mode):
        file=self.root/'config.json';file.write_text(json.dumps(self.config));stdout=io.StringIO()
        def unhandled(signum,frame):raise InterruptedError('unhandled fixture signal')
        previous=signal.signal(signal.SIGTERM,unhandled)
        try:
            with patch.object(sys,'argv',[str(ENTRY),'--config',str(file),mode]),patch('subprocess.check_output',side_effect=self.command),patch('subprocess.run',side_effect=self.process),contextlib.redirect_stdout(stdout):
                runpy.run_path(str(ENTRY),run_name='__main__')
        finally:signal.signal(signal.SIGTERM,previous)
        return json.loads(stdout.getvalue())

    def baseline(self):
        self.execute('before');self.calls.clear()

    def deployed(self):
        self.baseline();self.execute(SERVICE);self.calls.clear()

    def rebuild(self,index=2):
        row=self.containers[index];before=row['Id'];row['Id']='7'*64
        recovery=dict(before_id=before,after_id=row['Id'],workspace=self.config['workspace']['volume'],configuration_preserved=True,workspace_bytes_preserved=True)
        Path(self.config['reports']['recovery']).write_text(json.dumps(recovery))
        return recovery

    def ready(self):
        self.deployed();self.rebuild()

    def mutations(self):
        return [args for args in self.calls if args[1] in ['tag','start','stop'] or 'up' in args]


class ControllerDeploymentTests(unittest.TestCase):
    def test_full_chain_keeps_original_rows_allows_additions_and_binds_recovery(self):
        f=ControllerModel(self);f.baseline()
        self.assertTrue((f.output/'deployment-context.private.json').exists())
        preserved={p.name:p.read_bytes() for p in f.output.iterdir()}
        self.assertEqual(f.execute(SERVICE)['image'],NEW)
        f.rebuild()
        first=f.execute('after')
        for table in TABLES:f.rows[table]['new-row']='e'*32
        final=f.execute('final')
        self.assertEqual(first['other_platform_containers_unchanged'],3)
        self.assertTrue(final['retained_runtime_rebuilt'])
        self.assertEqual(final['original_rows_preserved'],{t:1 for t in TABLES})
        self.assertEqual(final['current_rows'],{t:2 for t in TABLES})
        for name,data in preserved.items():self.assertEqual((f.output/name).read_bytes(),data)

    def test_before_outputs_reject_before_external_calls(self):
        for name in ['database-before.json','containers-before.json','baseline.json','compose.private.json','containers.private.json','backups.json','deployment-context.private.json','fixture_agent-before.dump','fixture_runtime-before.dump','fixture_acp-before.dump']:
            with self.subTest(name=name):
                f=ControllerModel(self);f.output.mkdir();(f.output/name).write_text('existing')
                with self.assertRaises((ValueError,AssertionError,FileExistsError)):f.execute('before')
                self.assertEqual(f.calls,[])

    def test_later_modes_reject_output_conflicts_before_calls(self):
        for mode,names in [(SERVICE,['agent-controller-deployed.json','agent-controller-deployed.private.json','agent-controller-rollback.private.json']),('after',['containers-after.json','checks-after.json']),('final',['containers-final.json','checks-final.json'])]:
            for name in names:
                with self.subTest(mode=mode,name=name):
                    f=ControllerModel(self);f.ready() if mode in ['after','final'] else f.baseline()
                    f.calls.clear();(f.output/name).write_text('existing')
                    with self.assertRaises((ValueError,AssertionError)):f.execute(mode)
                    self.assertEqual(f.calls,[])

    def test_baseline_and_configuration_changes_reject_before_commands(self):
        for case in ['baseline','rows','compose-file','config','empty','missing-context','backup']:
            with self.subTest(case=case):
                f=ControllerModel(self);f.baseline()
                if case=='baseline':(f.output/'containers-before.json').write_text('[]')
                elif case=='rows':(f.output/'database-before.json').write_text('{}')
                elif case=='compose-file':f.compose_file.write_text(f.compose_file.read_text()+' ')
                elif case=='config':f.config['images'][SERVICE]['candidateImage']='sha256:'+'e'*64
                elif case=='empty':(f.output/'baseline.json').write_text('{}')
                elif case=='missing-context':(f.output/'deployment-context.private.json').unlink(missing_ok=True)
                else:(f.output/'fixture_agent-before.dump').write_bytes(b'changed')
                with self.assertRaises((ValueError,AssertionError)):f.execute(SERVICE)
                self.assertEqual(f.calls,[])

    def test_live_changes_and_image_aliases_reject_before_mutation(self):
        for case in ['target-id','pg-id','runtime-id','foreign-id','effective-compose','target-env','candidate','local','rollback']:
            with self.subTest(case=case):
                f=ControllerModel(self);f.baseline();refs=f.config['images'][SERVICE]
                if case.endswith('-id'):f.containers[{'target-id':0,'pg-id':1,'runtime-id':2,'foreign-id':3}[case]]['Id']='9'*64
                elif case=='effective-compose':f.compose['services'][SERVICE]['environment']['NEW']='changed'
                elif case=='target-env':f.containers[0]['Config']['Env']=[]
                else:f.tags[refs[case+'Tag']]='sha256:'+'f'*64
                with self.assertRaises((ValueError,AssertionError)):f.execute(SERVICE)
                self.assertEqual(f.mutations(),[])
        f=ControllerModel(self);f.config['images'][SERVICE].update(candidateTag='node',localTag='docker.io/library/node:latest')
        with self.assertRaises((ValueError,AssertionError)):f.execute('before')
        self.assertEqual(f.calls,[])

    def test_all_archives_fail_without_success_or_tag_mutation(self):
        for tool in ['pg_dump','pg_restore']:
            for index in range(3):
                with self.subTest(tool=tool,index=index):
                    f=ControllerModel(self);seen=[0]
                    def fault(args):
                        if tool not in args:return False
                        seen[0]+=1;return seen[0]==index+1
                    f.fault(fault,RuntimeError('archive failed'))
                    with self.assertRaisesRegex(RuntimeError,'archive failed'):f.execute('before')
                    self.assertFalse((f.output/'deployment-context.private.json').exists())
                    self.assertEqual(f.mutations(),[])

    def test_only_bound_runtime_recovery_can_authorize_replacement(self):
        for case in ['unknown-before','same-id','wrong-after','wrong-volume','configuration-false','workspace-false','foreign-rebuild','wrong-agent','wrong-scope','readonly','nested','tmpfs']:
            with self.subTest(case=case):
                f=ControllerModel(self);f.deployed();recovery=f.rebuild(1 if case=='foreign-rebuild' else 2)
                if case=='unknown-before':recovery['before_id']='9'*64
                elif case=='same-id':recovery['after_id']=recovery['before_id']
                elif case=='wrong-after':recovery['after_id']='9'*64
                elif case=='wrong-volume':recovery['workspace']='other-volume'
                elif case=='configuration-false':recovery['configuration_preserved']=False
                elif case=='workspace-false':recovery['workspace_bytes_preserved']=False
                elif case=='wrong-agent':f.containers[2]['Config']['Labels']['io.antnest.agent-id']='agent_'+'f'*32
                elif case=='wrong-scope':f.containers[2]['Config']['Labels']['io.antnest.runtime-controller-scope']='other'
                elif case=='readonly':f.containers[2]['Mounts'][0]['RW']=False
                elif case=='nested':f.containers[2]['Mounts'].append(dict(Type='bind',Source='/tmp',Destination='/workspace/sub',RW=True))
                elif case=='tmpfs':f.containers[2]['HostConfig']['Tmpfs']={'/workspace/sub':'rw'}
                Path(f.config['reports']['recovery']).write_text(json.dumps(recovery))
                with self.assertRaises((ValueError,AssertionError)):f.execute('after')
                self.assertFalse((f.output/'checks-after.json').exists())

    def test_original_global_mount_image_health_and_row_assertions_remain(self):
        for case in ['stopped','missing','extra','foreign-image','foreign-id','mount-source','network','health','row-delete','row-change','active']:
            with self.subTest(case=case):
                f=ControllerModel(self);f.ready();foreign=f.containers[3]
                if case=='stopped':foreign['State']['Running']=False
                elif case=='missing':f.containers.pop(3)
                elif case=='extra':row=deepcopy(foreign);row.update(Id='9'*64,Name='/extra');f.containers.append(row)
                elif case=='foreign-image':foreign['Image']=NEW
                elif case=='foreign-id':foreign['Id']='9'*64
                elif case=='mount-source':f.containers[2]['Mounts'][0]['Source']='/changed'
                elif case=='network':foreign['NetworkSettings']['Networks']['extra']={}
                elif case=='health':foreign['State']['Health']['Status']='unhealthy'
                elif case=='row-delete':f.rows['runs'].clear()
                elif case=='row-change':f.rows['runs']['runs-row']='e'*32
                else:f.active=1
                with self.assertRaises((ValueError,AssertionError,StopIteration)):f.execute('after')
                self.assertFalse((f.output/'checks-after.json').exists())

    def test_deployment_failures_recover_old_image_and_preserve_original_error(self):
        for case in ['tag','compose','unhealthy','wrong-image','interrupt']:
            with self.subTest(case=case):
                f=ControllerModel(self);f.baseline()
                if case=='tag':f.fault(lambda a:a[1]=='tag',RuntimeError('tag failed'),True)
                elif case=='compose':f.fault(lambda a:'up' in a,RuntimeError('compose failed'),True)
                elif case=='unhealthy':f.unhealthy=True
                elif case=='wrong-image':f.wrong_image=True
                else:f.fault(lambda a:'up' in a,lambda:signal.raise_signal(signal.SIGTERM),True)
                expected=InterruptedError if case=='interrupt' else ValueError if case in ['unhealthy','wrong-image'] else RuntimeError
                with self.assertRaises(expected):f.execute(SERVICE)
                self.assertEqual(f.tags[f.config['images'][SERVICE]['localTag']],OLD)
                self.assertEqual(f.containers[0]['Image'],OLD)
                self.assertTrue(f.containers[0]['State']['Running'])
                self.assertTrue((f.output/'agent-controller-rollback.private.json').exists())
                self.assertFalse((f.output/'agent-controller-deployed.json').exists())

    def test_running_container_order_is_not_a_deployment_change(self):
        f=ControllerModel(self);f.baseline();command=f.command
        def reordered(args,**kwargs):
            value=command(args,**kwargs)
            return '\n'.join(reversed(value.splitlines())) if args==['docker','ps','--format','{{.Names}}'] else value
        f.command=reordered
        self.assertEqual(f.execute(SERVICE)['image'],NEW)

    def test_failure_between_removal_and_creation_recovers_missing_controller(self):
        f=ControllerModel(self);f.baseline()
        def missing():
            f.missing_target=True
            raise RuntimeError('create failed after removal')
        f.fault(lambda a:'up' in a,missing,True)
        with self.assertRaisesRegex(RuntimeError,'create failed after removal'):f.execute(SERVICE)
        self.assertFalse(f.missing_target);self.assertEqual(f.containers[0]['Image'],OLD)
        self.assertTrue((f.output/'agent-controller-rollback.private.json').exists())

    def test_rollback_failure_preserves_original_cause(self):
        f=ControllerModel(self);f.baseline();original=RuntimeError('deployment cause')
        f.fault(lambda a:'up' in a,original,True)
        f.fault(lambda a:a[:3]==['docker','tag',OLD],RuntimeError('rollback cause'))
        with self.assertRaisesRegex(RuntimeError,'rollback cause') as raised:f.execute(SERVICE)
        self.assertIs(raised.exception.__cause__,original)
        self.assertFalse((f.output/'agent-controller-deployed.json').exists())


if __name__=='__main__':unittest.main()
