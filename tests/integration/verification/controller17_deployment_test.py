"""Dual-Controller entry contracts, including the original 0917 final acceptance."""
from copy import deepcopy
import contextlib
import io
import json
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

from controller_deployment_test import ControllerModel, ROOT, OLD, NEW, TABLES

ENTRY=ROOT/'tests/e2e/development/deployment/controller-20260917.py'
SERVICES=('agent-controller','runtime-controller')


class Controller17Model(ControllerModel):
    def __init__(self,test):
        super().__init__(test)
        self.config['images']['runtime-controller']=dict(candidateTag='fixture/runtime-controller:candidate',candidateImage='sha256:'+'c'*64,localTag='fixture/runtime-controller:local',rollbackTag='fixture/runtime-controller:rollback')
        refs=self.config['images']['runtime-controller']
        self.tags.update({refs['candidateTag']:refs['candidateImage'],refs['localTag']:OLD})
        self.compose['services']['runtime-controller']['healthcheck']=dict(test=['CMD','true'])
        self.compose_file.write_text(json.dumps(self.compose))
        self.session='12345678-1234-1234-1234-123456789abc'
        self.agent=self.config['workspace']['container'].removeprefix('antnest-runtime-')
        self.temporary='agent_'+'e'*32
        self.reports=dict(browser=dict(agent_id=self.agent,session_id=self.session,checks=['check-'+str(i) for i in range(8)],browser_errors=0,workspace_file='/workspace/acceptance-note.txt',workspace_marker='0917 marker\n'),
            agentBefore=dict(checked_at='before',agent_id=self.agent,value='retained'),agentFinal=dict(checked_at='after',agent_id=self.agent,value='retained'),temporaryAgent=dict(agent_id=self.temporary),
            lifecycle=dict(status='passed',lifecycle=[dict(evidence=dict(warnings=['clock skew adjustment disabled fixture']))]))
        self.config['reports']={key:str(self.root/(key+'.json')) for key in self.reports}
        self.save_reports()
        self.run_rows=[dict(state='completed',stop_reason='end_turn',executor_state='quiescent') for _ in range(3)]
        self.attempts=[dict(tool='shell',state='completed',effect='settled') for _ in range(3)]
        self.rejected=[dict(toolCallId='rejected-'+str(i),content=[dict(text='Tool arguments do not match the declared schema: invalid')]) for i in range(2)]
        self.attempt_count='0';self.marker=self.reports['browser']['workspace_marker'];self.resources='';self.processes=''
        self.missing=set();self.bad_service=None

    def save_reports(self):
        for key,value in self.reports.items():Path(self.config['reports'][key]).write_text(json.dumps(value))

    def row(self,name):
        row=super().row(name)
        if row['Config']['Labels'].get('com.docker.compose.service') in self.missing:raise subprocess.CalledProcessError(1,['docker','inspect',name])
        return row

    def command(self,args,**kwargs):
        value=None
        if args[:4]==['docker','ps','-aq','--filter'] and args[-1].startswith('name=^/'):
            self.calls.append(args)
            name=args[-1][len('name=^/'):-1]
            row=next(row for row in self.containers if row['Name']=='/'+name)
            value='' if row['Config']['Labels']['com.docker.compose.service'] in self.missing else row['Id']
        elif args==['docker','ps','--format','{{.Names}}']:
            self.calls.append(args)
            value='\n'.join(row['Name'].lstrip('/') for row in self.containers if row['State']['Running'] and row['Config']['Labels'].get('com.docker.compose.service') not in self.missing)
        elif args[:2]==['docker','exec'] and 'psql' in args:
            query=kwargs['input'].decode()
            if 'WHERE session_id=' in query or 'WHERE r.session_id=' in query:
                self.calls.append(args)
                self.test.assertEqual(args[3],self.containers[1]['Id'])
                self.test.assertIn("'"+self.session+"'",query)
                value=json.dumps(self.run_rows if 'FROM runs WHERE' in query else self.attempts if 'FROM tool_attempts t' in query else self.rejected)
            elif 'WHERE tool_call_id=' in query:self.calls.append(args);value=self.attempt_count
            elif 'FROM acp_sessions WHERE id=' in query:self.calls.append(args);value=json.dumps(dict(agent_id=self.agent,cwd='/workspace'))
        elif args[:2]==['docker','exec'] and 'psql' not in args:
            self.calls.append(args);self.test.assertEqual(args[2],self.containers[2]['Id']);value=self.marker
        elif args[0]=='ps':self.calls.append(args);value=self.processes
        elif args[:2] in [['docker','ps'],['docker','volume'],['docker','network']] and '--filter' in args:
            self.calls.append(args);self.test.assertIn(self.temporary,args[-1]);value=self.resources
        if value is None:return super().command(args,**kwargs)
        return value if kwargs.get('text') else value.encode()

    def compose_up(self,args):
        service=args[-1];self.test.assertIn(service,SERVICES)
        self.test.assertEqual(args[len(self.config['compose']):-1],['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120'])
        row=next(row for row in self.containers if row['Config']['Labels'].get('com.docker.compose.service')==service)
        self.missing.discard(service)
        refs=self.config['images'][service];image=self.tags[refs['localTag']]
        row['Id']=(('6' if service==SERVICES[0] else '7') if image!=OLD else ('8' if service==SERVICES[0] else '9'))*64
        row['Image']=image;row['State'].update(Running=True,Status='running',Health=dict(Status='unhealthy' if self.bad_service==service and image!=OLD else 'healthy'))

    def execute(self,mode):
        file=self.root/'config.json';file.write_text(json.dumps(self.config));stdout=io.StringIO()
        def unhandled(signum,frame):raise InterruptedError('unhandled fixture signal')
        previous=signal.signal(signal.SIGTERM,unhandled)
        try:
            with patch.object(sys,'argv',[str(ENTRY),'--config',str(file),mode]),patch('subprocess.check_output',side_effect=self.command),patch('subprocess.run',side_effect=self.process),contextlib.redirect_stdout(stdout):runpy.run_path(str(ENTRY),run_name='__main__')
        finally:signal.signal(signal.SIGTERM,previous)
        return json.loads(stdout.getvalue())

    def ready(self,order=SERVICES):
        self.baseline()
        for service in order:self.execute(service)
        self.calls.clear()


class Controller17DeploymentTests(unittest.TestCase):
    def test_both_orders_keep_runtime_and_foreign_ids_and_exact_final_fields(self):
        for order in [SERVICES,tuple(reversed(SERVICES))]:
            with self.subTest(order=order):
                f=Controller17Model(self);original=deepcopy(f.containers);f.ready(order)
                self.assertTrue((f.output/'deployment-context.private.json').is_file())
                f.execute('after')
                for table in TABLES:f.rows[table]['added']='f'*32
                report=f.execute('final')
                self.assertEqual({k:report[k] for k in ['session_id','new_completed_runs','completed_runtime_calls','preflight_rejections','workspace_marker_matches','agent_configuration_unchanged','temporary_resources','verification_children','other_containers_unchanged']},dict(session_id=f.session,new_completed_runs=3,completed_runtime_calls=3,preflight_rejections=2,workspace_marker_matches=True,agent_configuration_unchanged=True,temporary_resources=0,verification_children=0,other_containers_unchanged=3))
                self.assertEqual(report['original_rows_preserved'],{t:1 for t in TABLES})
                self.assertEqual(report['current_rows'],{t:2 for t in TABLES})
                for index in (1,2,3):self.assertEqual(f.containers[index]['Id'],original[index]['Id'])
                self.assertEqual(f.backups,['fixture_agent','fixture_runtime','fixture_acp'])
                self.assertTrue(all(p.stat().st_mode&0o777==0o600 for p in f.output.iterdir()))

    def test_all_fixed_outputs_fail_before_external_calls(self):
        cases={'before':['database-before.json','containers-before.json','baseline.json','compose.private.json','containers.private.json','backups.json','deployment-context.private.json','fixture_agent-before.dump','fixture_runtime-before.dump','fixture_acp-before.dump'],
            **{s:[s+'-deployed.json',s+'-deployed.private.json',s+'-rollback.private.json'] for s in SERVICES},'after':['checks-after.json','containers-after.json'],'final':['checks-final.json','containers-final.json']}
        for mode,names in cases.items():
            for name in names:
                with self.subTest(mode=mode,name=name):
                    f=Controller17Model(self)
                    if mode in SERVICES:f.baseline()
                    elif mode!='before':f.ready()
                    f.output.mkdir(exist_ok=True);(f.output/name).write_text('retained');f.calls.clear()
                    with self.assertRaises((ValueError,AssertionError,FileExistsError)):f.execute(mode)
                    self.assertEqual(f.calls,[])

    def test_bound_inputs_and_normalized_cross_service_tag_aliases(self):
        for change in ['configuration','compose','archive','full','missing-context','workspace','missing-reports','alias']:
            with self.subTest(change=change):
                f=Controller17Model(self)
                if change not in ('workspace','missing-reports','alias'):f.baseline()
                if change=='configuration':f.config['expected']['healthy']=3
                elif change=='compose':f.compose_file.write_text(f.compose_file.read_text()+'\n')
                elif change=='archive':(f.output/'fixture_agent-before.dump').write_bytes(b'changed')
                elif change=='full':(f.output/'containers.private.json').write_text('[]')
                elif change=='missing-context':(f.output/'deployment-context.private.json').unlink(missing_ok=True)
                elif change=='workspace':del f.config['workspace']
                elif change=='missing-reports':del f.config['reports']
                else:f.config['images']['runtime-controller']['rollbackTag']='docker.io/'+f.config['images']['agent-controller']['localTag']
                f.calls.clear()
                with self.assertRaises((ValueError,AssertionError,FileNotFoundError)):f.execute('before' if change in ('workspace','missing-reports','alias') else SERVICES[0])
                self.assertEqual(f.calls,[])

    def test_original_snapshot_and_database_failures_still_fail(self):
        for change in ['runtime-id','foreign-id','foreign-image','mount','network','health','rows','active','missing-deployment']:
            with self.subTest(change=change):
                f=Controller17Model(self);f.ready()
                if change=='runtime-id':f.containers[2]['Id']='a'*64
                elif change=='foreign-id':f.containers[3]['Id']='a'*64
                elif change=='foreign-image':f.containers[3]['Image']=NEW
                elif change=='mount':f.containers[2]['Mounts'][0]['Source']='/different'
                elif change=='network':f.containers[3]['NetworkSettings']['Networks']={}
                elif change=='health':f.containers[3]['State']['Health']['Status']='unhealthy'
                elif change=='rows':f.rows['runs']['runs-row']='e'*32
                elif change=='active':f.active=1
                else:(f.output/'runtime-controller-deployed.private.json').unlink()
                with self.assertRaises((ValueError,AssertionError,FileNotFoundError)):f.execute('after')
                self.assertFalse((f.output/'checks-after.json').exists())

    def test_exact_final_business_and_cleanup_failures_are_preserved(self):
        for change in ['checks','browser-errors','agent','agent-changed','temporary-same','lifecycle-status','lifecycle-warning','runs-count','run-state','attempt-count','attempt-state','rejection-count','rejection-text','rejection-attempt','rejection-id','marker','resources','children']:
            with self.subTest(change=change):
                f=Controller17Model(self);f.ready()
                if change=='checks':f.reports['browser']['checks'].pop()
                elif change=='browser-errors':f.reports['browser']['browser_errors']=1
                elif change=='agent':f.reports['browser']['agent_id']='agent_'+'d'*32
                elif change=='agent-changed':f.reports['agentFinal']['value']='changed'
                elif change=='temporary-same':f.reports['temporaryAgent']['agent_id']=f.agent
                elif change=='lifecycle-status':f.reports['lifecycle']['status']='failed'
                elif change=='lifecycle-warning':f.reports['lifecycle']['lifecycle'][0]['evidence']['warnings']=['missing parent']
                elif change=='runs-count':f.run_rows.pop()
                elif change=='run-state':f.run_rows[0]['state']='failed'
                elif change=='attempt-count':f.attempts.pop()
                elif change=='attempt-state':f.attempts[0]['effect']='unknown'
                elif change=='rejection-count':f.rejected.pop()
                elif change=='rejection-text':f.rejected[0]['content'][0]['text']='execution failed'
                elif change=='rejection-attempt':f.attempt_count='1'
                elif change=='rejection-id':f.rejected[0]['toolCallId']="bad' OR '1'='1"
                elif change=='marker':f.marker+='changed'
                elif change=='resources':f.resources='owned-orphan'
                else:f.processes='999999 1 node tests/e2e/development/lifecycle.mjs --config fixture.json'
                f.save_reports()
                with self.assertRaises((ValueError,AssertionError)):f.execute('final')
                self.assertFalse((f.output/'checks-final.json').exists())
                self.assertFalse((f.output/'containers-final.json').exists())

    def test_each_service_failure_restores_only_it_and_retains_failure(self):
        for service in SERVICES:
            for kind in ['tag','compose','unhealthy','signal','missing']:
                with self.subTest(service=service,kind=kind):
                    f=Controller17Model(self);f.baseline()
                    other=next(s for s in SERVICES if s!=service);f.execute(other)
                    preserved=deepcopy(next(c for c in f.containers if c['Config']['Labels'].get('com.docker.compose.service')==other))
                    if kind=='unhealthy':f.bad_service=service
                    else:
                        predicate=(lambda a:a[:2]==['docker','tag'] and a[-1]==f.config['images'][service]['localTag']) if kind=='tag' else (lambda a:'up' in a and a[-1]==service)
                        def failure():
                            if kind=='missing':f.missing.add(service)
                            if kind=='signal':signal.raise_signal(signal.SIGTERM)
                            raise subprocess.CalledProcessError(73,['controlled-'+kind])
                        f.fault(predicate,failure,after=kind in ('compose','signal'))
                    with self.assertRaises((ValueError,AssertionError,subprocess.CalledProcessError,InterruptedError)):f.execute(service)
                    target=next(c for c in f.containers if c['Config']['Labels'].get('com.docker.compose.service')==service)
                    self.assertEqual(target['Image'],OLD);self.assertNotIn(service,f.missing)
                    self.assertEqual(f.tags[f.config['images'][service]['localTag']],OLD)
                    self.assertEqual(next(c for c in f.containers if c['Config']['Labels'].get('com.docker.compose.service')==other),preserved)
                    self.assertEqual(json.loads((f.output/(service+'-rollback.private.json')).read_text())['status'],'recovered')
                    self.assertFalse((f.output/(service+'-deployed.json')).exists())

    def test_completed_sibling_record_and_live_identity_bind_second_deployment(self):
        for first,second in [SERVICES,tuple(reversed(SERVICES))]:
            for change in ['live-id','private-record','safe-record','missing-record']:
                with self.subTest(first=first,change=change):
                    f=Controller17Model(self);f.baseline();f.execute(first);f.calls.clear()
                    live=next(row for row in f.containers if row['Config']['Labels'].get('com.docker.compose.service')==first)
                    if change=='live-id':live['Id']='f'*64
                    else:
                        path=f.output/(first+('-deployed.json' if change=='safe-record' else '-deployed.private.json'))
                        if change=='missing-record':path.unlink()
                        else:
                            value=json.loads(path.read_text());value['id' if change=='safe-record' else 'Id']='f'*64
                            path.write_text(json.dumps(value))
                    with self.assertRaises((ValueError,FileNotFoundError)):f.execute(second)
                    self.assertEqual(f.mutations(),[])

    def test_both_services_and_effective_compose_are_bound_before_mutation(self):
        for change in ['agent-id','runtime-id','postgres-id','candidate','local','rollback','environment','compose']:
            with self.subTest(change=change):
                f=Controller17Model(self);f.baseline();f.calls.clear()
                if change.endswith('-id'):f.containers[{'agent-id':0,'runtime-id':4,'postgres-id':1}[change]]['Id']='f'*64
                elif change in ['candidate','local','rollback']:f.tags[f.config['images']['runtime-controller'][change+'Tag']]='sha256:'+'f'*64
                elif change=='environment':f.containers[4]['Config']['Env']=[]
                else:f.compose['services']['runtime-controller']['environment']['OTHER']='changed'
                with self.assertRaises((ValueError,AssertionError)):f.execute('agent-controller')
                self.assertEqual(f.mutations(),[])


if __name__=='__main__':unittest.main()
