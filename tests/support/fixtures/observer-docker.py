#!/usr/bin/env python3
"""Read-only fake Docker for diagnostic observer contracts."""
import json
import os
from pathlib import Path
import sys

root = Path(os.environ['OBSERVER_FIXTURE_ROOT'])
args = sys.argv[1:]
with (root / 'docker-calls.jsonl').open('a') as output:
    output.write(json.dumps(args) + '\n')
mode = os.environ.get('OBSERVER_DOCKER_MODE', 'empty')
if mode == 'error' and (root / 'ready').exists():
    raise SystemExit(7)
if mode in ['trigger', 'leak']:
    trigger = any(value.startswith('name=^/') for value in args)
    if (root / 'ready').exists() and (trigger or mode == 'leak'):
        print('owned-fixture-resource')
elif mode == 'observe':
    if args[0] == 'ps':
        print('antnest-acp-sdk-1234abcd-service' if '--format' in args else 'fixture-id')
    elif args[0] == 'inspect':
        if '--format' in args:
            print(json.dumps({'Status': 'running'}))
        else:
            print(json.dumps([{'Name': '/antnest-stage3-e2e-12345-agent-controller', 'Id': 'fixture-id', 'State': {'Status': 'running'}, 'RestartCount': 0}]))
    elif args[0] == 'logs':
        print('private fixture log')
