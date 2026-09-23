"""Explicit Controller deployment profile."""
from pathlib import Path
import json
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'support'/'verification'))
from development_configuration import development_arguments
from controller_deployment_driver import execute, signals

if __name__=='__main__':
    config,mode=development_arguments('controller-20260921')
    with signals():print(json.dumps(execute(config,mode)))
