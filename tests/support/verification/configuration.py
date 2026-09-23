"""Explicit inputs and durable storage for manual deployment acceptance tools."""
import argparse
import json
import os
from pathlib import Path


def durable_path(value):
    path = Path(value).absolute()
    if '.cache' in path.parts or '.cache' in path.resolve().parts:
        raise ValueError('durable files must not use .cache or a cache alias')
    return path.resolve()


def configured_arguments(argv=None, *, require_mode=True, validate_config=None, validate_mode=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=durable_path)
    if require_mode:
        parser.add_argument('mode')
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text())
    if not isinstance(config, dict) or not isinstance(config.get('output'), str) or not config['output']:
        raise ValueError('configuration requires an explicit output directory')
    output = durable_path(config['output'])

    def validate(value, key='', report=False):
        if isinstance(value, dict):
            return {k: validate(v, k, report or key == 'reports') for k, v in value.items()}
        if key.endswith('_path') or report or key in ['envFile', 'secretFile', 'workspaceManifest']:
            if not isinstance(value, str) or not value:
                raise ValueError('configured file paths must be nonempty strings')
            return str(durable_path(output / value))
        if key.endswith('_glob'):
            if not isinstance(value, str) or not value:
                raise ValueError('configured trace patterns must be nonempty strings')
            durable_path(output / value)
        if key in ['publication_trace_prefix', 'process_scope', 'process_exclude']:
            if not isinstance(value, str) or not value:
                raise ValueError('configured selectors must be nonempty strings')
        if key in ['verification_commands', 'processPatterns', 'compose']:
            if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
                raise ValueError('configured command selectors must be nonempty string arrays')
        return value

    config = validate(config)
    config['output'] = str(output)
    if validate_config is not None:
        validate_config(config)
    if validate_mode is not None:
        validate_mode(config, getattr(args, 'mode', None))
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    return config, getattr(args, 'mode', None)
