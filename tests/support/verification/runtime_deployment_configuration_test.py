"""Runtime deployment inputs must fail before the first Docker command."""
from copy import deepcopy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

from configuration import durable_path
from development_configuration import validate_development
from runtime_deployment import write_runtime_report

ROOT = Path(__file__).resolve().parents[3]
SERVICE = 'runtime-controller'
TABLES = ['acp_sessions', 'runs', 'session_messages', 'tool_attempts']
FILES = ['before.json', 'containers.private.json', 'compose.private.json', 'rows-before.json']
OLD, NEW = 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64


class RuntimeConfigurationFixture:
    def __init__(self, test, baseline=True):
        temporary = tempfile.TemporaryDirectory(dir=durable_path(tempfile.gettempdir()))
        test.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.output = self.root / 'evidence'
        self.compose_file = self.root / 'compose.json'
        project = 'antnest-fixture'
        self.config = dict(output=str(self.output), project=project,
            database=dict(container=project+'-postgres-1', user='fixture_admin', names=dict(acp='fixture_acp', agentController='fixture_agent', runtimeController='fixture_runtime')),
            images={SERVICE:dict(candidateTag='antnest/runtime-controller:candidate', candidateImage=NEW, localTag='antnest/runtime-controller:local', rollbackTag='antnest/runtime-controller:rollback')},
            compose=['docker','compose','-p',project,'-f',str(self.compose_file)],
            workspace=dict(container='antnest-runtime-agent_'+'c'*32,path='/workspace',volume='fixture-workspace'),
            expected=dict(containers=4,healthy=3,unaffectedProcesses=3))
        self.compose = dict(name=project, services={SERVICE:dict(image=self.config['images'][SERVICE]['localTag'], environment=dict(ANTNEST_RUNTIME_CONTROLLER_SCOPE=project), healthcheck=dict(test=['CMD','true'])),'postgres':dict(image='postgres:17.11-bookworm')})
        self.compose_file.write_text(json.dumps(self.compose))
        def container(number,name,service,healthy=True):
            return dict(Id=str(number)*64,Name='/'+name,Image=OLD,RestartCount=0,
                State=dict(Running=True,Status='running',StartedAt='2026-09-21T00:00:00Z',ExitCode=0,OOMKilled=False,**({'Health':dict(Status='healthy')} if healthy else {})),
                Mounts=[],NetworkSettings=dict(Networks={project:{}}),HostConfig=dict(Tmpfs={}),
                Config=dict(Labels={'com.docker.compose.project':project,'com.docker.compose.service':service},Env=['ANTNEST_RUNTIME_CONTROLLER_SCOPE='+project],Healthcheck=dict(Test=['CMD','true'])))
        self.containers = [container(1,project+'-'+SERVICE+'-1',SERVICE),container(2,self.config['database']['container'],'postgres'),container(3,self.config['workspace']['container'],'runtime',False),container(4,'unrelated-project-service-1','foreign')]
        self.containers[3]['Config']['Labels']['com.docker.compose.project']='unrelated-project'
        runtime=self.containers[2]
        runtime['Config']['Labels']={'io.antnest.agent-id':'agent_'+'c'*32,'io.antnest.managed':'runtime','io.antnest.runtime-controller-scope':project}
        runtime['Mounts']=[dict(Destination='/workspace',Type='volume',Name='fixture-workspace',Source='/var/lib/docker/volumes/fixture-workspace/_data',RW=True,Mode='z',Propagation='')]
        self.rows={table:{table+'-row':'d'*32} for table in TABLES}
        self.before=dict(containers=[self.safe(row) for row in self.containers],workspace_sha256=hashlib.sha256(b'').hexdigest(),row_counts={table:1 for table in TABLES})
        if baseline:
            for name,value in [('before.json',self.before),('containers.private.json',self.containers),('compose.private.json',self.compose),('rows-before.json',self.rows)]:self.put(name,value)
            self.deployed=deepcopy(self.containers[0]);self.deployed['Id']='5'*64;self.deployed['Image']=NEW
            self.put('deployed.private.json',self.deployed)
            self.context()

    @staticmethod
    def safe(row):
        return dict(id=row['Id'],name=row['Name'],image=row['Image'],started=row['State']['StartedAt'],restarts=row['RestartCount'],running=row['State']['Running'],health=row['State'].get('Health',{}).get('Status'),mounts=sorted(row['Mounts'],key=lambda m:m['Destination']),networks=sorted(row['NetworkSettings']['Networks']))

    def put(self,name,value):
        self.output.mkdir(exist_ok=True)
        (self.output/name).write_text(json.dumps(value))

    def context(self):
        self.put('deployment-context.private.json',dict(version=1,configuration=self.config,compose_inputs={str(self.compose_file):hashlib.sha256(self.compose_file.read_bytes()).hexdigest()},baseline_files={name:hashlib.sha256((self.output/name).read_bytes()).hexdigest() for name in FILES}))

    def validate(self,mode):
        validate_development(self.config,'runtime-20260921',mode)

    def cli(self,mode):
        file=self.root/'config.json';file.write_text(json.dumps(self.config))
        binary=self.root/'bin';binary.mkdir(exist_ok=True)
        marker=self.root/'docker-called'
        script=binary/'docker';script.write_text('#!/bin/sh\n/usr/bin/touch "'+str(marker)+'"\nexit 73\n');script.chmod(0o700)
        result=subprocess.run([sys.executable,'-B',str(ROOT/'tests/e2e/development/deployment/runtime-20260921.py'),'--config',str(file),mode],env={**os.environ,'PATH':str(binary)},text=True,capture_output=True,timeout=5)
        return result,marker.exists()


class RuntimeDeploymentConfigurationTests(unittest.TestCase):
    def test_before_entry_writes_a_private_bound_baseline_accepted_by_deploy(self):
        f=RuntimeConfigurationFixture(self,False);commands=[]
        def command(args,**kwargs):
            commands.append(args)
            if args==['docker','ps','-aq']:value='\n'.join(row['Id'] for row in f.containers)
            elif args[:2]==['docker','inspect']:
                rows=[]
                for name in args[2:]:
                    if name==f.config['images'][SERVICE]['localTag']:rows.append(dict(Id=OLD))
                    elif name==f.config['images'][SERVICE]['candidateTag']:rows.append(dict(Id=NEW))
                    else:rows.append(next(row for row in f.containers if name in (row['Name'].lstrip('/'),row['Id'])))
                value=json.dumps(rows)
            elif args==f.config['compose']+['config','--format','json']:value=json.dumps(f.compose)
            elif args[:4]==['docker','image','ls','-q']:value=''
            elif 'psql' in args:
                query=args[-1]
                if query in ["SELECT count(*) FROM runs WHERE state IN ('admitting','running')", "SELECT count(*) FROM agent_controller.agents WHERE active_operation_request_id <> ''"]:value='0'
                else:
                    table=next(table for table in TABLES if query.endswith('FROM '+table+' t'))
                    self.assertEqual(args[args.index('-d')+1],f.config['database']['names']['acp'])
                    value=json.dumps(f.rows[table])
            elif args[:2]==['docker','exec'] and args[2] in (f.config['workspace']['container'],f.containers[2]['Id']) and args[3]=='sh':value=''
            else:self.fail('unexpected command: '+repr(args))
            return value if kwargs.get('text') else value.encode()
        file=f.root/'config.json';file.write_text(json.dumps(f.config));stdout=io.StringIO()
        entry=ROOT/'tests/e2e/development/deployment/runtime-20260921.py'
        with patch.object(sys,'argv',[str(entry),'--config',str(file),'before']),patch('subprocess.check_output',side_effect=command),contextlib.redirect_stdout(stdout):
            runpy.run_path(str(entry),run_name='__main__')
        self.assertEqual(json.loads(stdout.getvalue())['status'],'baseline_passed')
        f.validate('deploy')
        for name in [*FILES,'deployment-context.private.json']:
            self.assertEqual((f.output/name).stat().st_mode&0o777,0o600)
        self.assertFalse(any('stop' in row or 'tag' in row or 'up' in row for row in commands))

    def test_after_report_rejects_hardlinks_without_changing_the_target(self):
        for outside in [False,True]:
            with self.subTest(outside=outside):
                f=RuntimeConfigurationFixture(self)
                target=f.root/'outside.json' if outside else f.output/'before.json'
                if outside:target.write_bytes(b'untouched')
                original=target.read_bytes();mode=target.stat().st_mode
                os.link(target,f.output/'after.json')
                with self.assertRaises(ValueError):write_runtime_report(f.config,'after.json',dict(changed=True),fresh=False)
                self.assertEqual(target.read_bytes(),original);self.assertEqual(target.stat().st_mode,mode)

    def test_deployment_mount_reordering_preserves_full_mount_comparison(self):
        f=RuntimeConfigurationFixture(self)
        mounts=[dict(Destination='/z',Type='bind',Source='/first',RW=True),dict(Destination='/a',Type='bind',Source='/second',RW=False)]
        f.containers[0]['Mounts']=mounts
        f.before['containers']=[f.safe(row) for row in f.containers]
        f.put('before.json',f.before);f.put('containers.private.json',f.containers);f.context()
        f.deployed['Mounts']=list(reversed(mounts));f.put('deployed.private.json',f.deployed)
        f.validate('after')
        f.deployed['Mounts'][0]['Source']='/different';f.put('deployed.private.json',f.deployed)
        with self.assertRaisesRegex(ValueError,'mounts'):f.validate('after')

    def test_valid_before_and_bound_later_modes_reach_the_command_boundary(self):
        for mode in ['before','deploy','restart','after']:
            with self.subTest(mode=mode):
                f=RuntimeConfigurationFixture(self,mode!='before')
                if mode=='deploy':(f.output/'deployed.private.json').unlink()
                f.validate(mode)
                result,called=f.cli(mode)
                self.assertTrue(called,result.stderr)
                self.assertNotEqual(result.returncode,0)

    def test_every_mode_preflights_its_output_leaves_before_docker(self):
        names={'before':FILES+['deployment-context.private.json'],
               'deploy':['deployment-stops.json','backups.json','deployed.private.json','rollback.private.json','fixture_acp.dump','fixture_agent.dump','fixture_runtime.dump'],
               'restart':['restart-stops.json','restarted.private.json','restart-recovery.private.json'],
               'after':['after.json']}
        for mode,leaves in names.items():
            for name in leaves:
                with self.subTest(mode=mode,name=name):
                    f=RuntimeConfigurationFixture(self,mode!='before')
                    if mode=='deploy':(f.output/'deployed.private.json').unlink()
                    f.output.mkdir(exist_ok=True);path=f.output/name
                    if path.exists():path.unlink()
                    path.mkdir()
                    result,called=f.cli(mode)
                    self.assertFalse(called,result.stderr)
                    self.assertNotEqual(result.returncode,0)

    def test_dump_and_fresh_stage_reports_cannot_be_overwritten(self):
        for name in ['fixture_runtime.dump','backups.json','deployed.private.json']:
            with self.subTest(name=name):
                f=RuntimeConfigurationFixture(self);(f.output/'deployed.private.json').unlink()
                (f.output/name).write_bytes(b'existing')
                result,called=f.cli('deploy')
                self.assertFalse(called,result.stderr)
                self.assertEqual((f.output/name).read_bytes(),b'existing')

    def test_after_can_update_its_ordinary_report_but_never_a_link(self):
        f=RuntimeConfigurationFixture(self);f.put('after.json',dict(previous=True));f.validate('after')
        (f.output/'after.json').unlink();(f.output/'after.json').symlink_to(f.root/'.cache/missing')
        with self.assertRaises(ValueError):f.validate('after')

    def test_context_binds_configuration_and_compose_file_bytes(self):
        for change in ['project','database','workspace','expected','candidate','compose-bytes','missing-context','context-schema','baseline-hash']:
            with self.subTest(change=change):
                f=RuntimeConfigurationFixture(self);(f.output/'deployed.private.json').unlink()
                if change=='project':f.config['project']='other';f.config['compose'][3]='other'
                elif change=='database':f.config['database']['names']['runtimeController']='other_runtime'
                elif change=='workspace':f.config['workspace']['volume']='other-workspace'
                elif change=='expected':f.config['expected']['healthy']=2
                elif change=='candidate':f.config['images'][SERVICE]['candidateImage']='sha256:'+'f'*64
                elif change=='compose-bytes':f.compose_file.write_text(f.compose_file.read_text()+'\n')
                elif change=='missing-context':(f.output/'deployment-context.private.json').unlink()
                elif change=='context-schema':f.put('deployment-context.private.json',{})
                elif change=='baseline-hash':(f.output/'before.json').write_text((f.output/'before.json').read_text()+'\n')
                result,called=f.cli('deploy');self.assertFalse(called,result.stderr)

    def test_structural_baselines_cannot_be_empty_partial_or_inconsistent(self):
        for change in ['empty','duplicate-id','duplicate-name','missing-container','safe-mismatch','bad-hash','bad-row-count','missing-table','invalid-row-hash','unhealthy-target','unhealthy-count','wrong-project','wrong-db-role','wrong-scope','wrong-agent','unmanaged','read-only','wrong-volume','nested-mount','tmpfs','compose-name','compose-image','compose-healthcheck']:
            with self.subTest(change=change):
                f=RuntimeConfigurationFixture(self);(f.output/'deployed.private.json').unlink()
                target,pg,runtime,foreign=f.containers
                if change=='empty':f.before={}
                elif change=='duplicate-id':foreign['Id']=runtime['Id']
                elif change=='duplicate-name':foreign['Name']=runtime['Name']
                elif change=='missing-container':f.containers.pop()
                elif change=='safe-mismatch':f.before['containers'][0]['id']='9'*64
                elif change=='bad-hash':f.before['workspace_sha256']='bad'
                elif change=='bad-row-count':f.before['row_counts']['runs']=2
                elif change=='missing-table':del f.rows['runs']
                elif change=='invalid-row-hash':f.rows['runs']['runs-row']='not-md5'
                elif change=='unhealthy-target':target['State']['Health']['Status']='unhealthy'
                elif change=='unhealthy-count':foreign['State'].pop('Health')
                elif change=='wrong-project':target['Config']['Labels']['com.docker.compose.project']='other'
                elif change=='wrong-db-role':pg['Config']['Labels']['com.docker.compose.service']='other'
                elif change=='wrong-scope':runtime['Config']['Labels']['io.antnest.runtime-controller-scope']='other'
                elif change=='wrong-agent':runtime['Config']['Labels']['io.antnest.agent-id']='agent_'+'d'*32
                elif change=='unmanaged':runtime['Config']['Labels']['io.antnest.managed']='other'
                elif change=='read-only':runtime['Mounts'][0]['RW']=False
                elif change=='wrong-volume':runtime['Mounts'][0]['Name']='other'
                elif change=='nested-mount':runtime['Mounts'].append(dict(Destination='/workspace/child',Type='bind',Source='/tmp',RW=True))
                elif change=='tmpfs':runtime['HostConfig']['Tmpfs']={'/workspace/child':'rw'}
                elif change=='compose-name':f.compose['name']='other'
                elif change=='compose-image':f.compose['services'][SERVICE]['image']='wrong:image'
                elif change=='compose-healthcheck':f.compose['services'][SERVICE]['healthcheck']['test']=[]
                if change not in ['empty','safe-mismatch']:f.before['containers']=[f.safe(row) for row in f.containers]
                for name,value in [('before.json',f.before),('containers.private.json',f.containers),('rows-before.json',f.rows),('compose.private.json',f.compose)]:f.put(name,value)
                f.context();result,called=f.cli('deploy');self.assertFalse(called,result.stderr)

    def test_restart_and_after_require_a_bound_candidate_deployment_record(self):
        for mode in ['restart','after']:
            for change in ['missing','empty','image','name','project','mounts']:
                with self.subTest(mode=mode,change=change):
                    f=RuntimeConfigurationFixture(self)
                    if change=='missing':(f.output/'deployed.private.json').unlink()
                    else:
                        row=deepcopy(f.deployed)
                        if change=='empty':row={}
                        elif change=='image':row['Image']=OLD
                        elif change=='name':row['Name']='/wrong-runtime-controller-1'
                        elif change=='project':row['Config']['Labels']['com.docker.compose.project']='other'
                        elif change=='mounts':row['Mounts']=[dict(Destination='/data',Type='bind',Source='/tmp',RW=True)]
                        f.put('deployed.private.json',row)
                    result,called=f.cli(mode);self.assertFalse(called,result.stderr)

    def test_image_reference_normalization_rejects_aliases_and_invalid_tags(self):
        for candidate,local in [('runtime-controller','docker.io/library/runtime-controller:latest'),('docker.io/antnest/runtime-controller:local','antnest/runtime-controller:local'),('index.docker.io/antnest/runtime-controller:local','docker.io/antnest/runtime-controller:local'),('antnest/runtime-controller:bad:tag','antnest/runtime-controller:local'),('antnest/Bad:tag','antnest/runtime-controller:local')]:
            with self.subTest(candidate=candidate):
                f=RuntimeConfigurationFixture(self,False);f.config['images'][SERVICE]['candidateTag']=candidate;f.config['images'][SERVICE]['localTag']=local
                result,called=f.cli('before');self.assertFalse(called,result.stderr)


if __name__=='__main__':unittest.main()
