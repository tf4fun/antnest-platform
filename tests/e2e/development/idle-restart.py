from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'support'/'verification'))
from development_configuration import development_arguments
config,_=development_arguments('idle-restart')
ROOT=Path(config['output'])
import json,subprocess,time,pathlib
p=ROOT
name=config['controller_container']
def inspect():return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
before=inspect();assert before['State']['Health']['Status']=='healthy'
subprocess.run(['docker','stop','-t','20',name],check=True,stdout=subprocess.DEVNULL)
stopped=inspect();assert stopped['State']['Status']=='exited' and stopped['State']['ExitCode']==0
subprocess.run(['docker','start',name],check=True,stdout=subprocess.DEVNULL)
for _ in range(90):
 after=inspect()
 if after['State']['Running'] and after['State']['Health']['Status']=='healthy':break
 time.sleep(1)
else:raise RuntimeError('Controller did not recover')
assert before['Id']==after['Id'] and before['State']['StartedAt']!=after['State']['StartedAt']
r={'status':'passed','exit_code':0,'same_container':True,'healthy':True,'image':after['Image']}
target=p/'idle-restart.json';target.write_text(json.dumps(r));target.chmod(0o600);print(json.dumps(r))
