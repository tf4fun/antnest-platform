"""Replay historical cleanup reports with reconstructed Docker fixtures, never live Docker."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'verification'))
from cleanup import prepare, verify, write_report
from cleanup_profiles import PROFILES
from cleanup_contracts import read_json
from configuration import durable_path


def historical_config(name, profile, root, output):
    config = dict(profile=name, input_root=str(root), output=str(output))
    fixed_projects = {
        'controller-workflow-span': ['antnest-workflow-tests-44188', 'antnest-workflow-tests-44327', 'antnest-workflow-tests-44543'],
        'lifecycle-loss-migration': ['antnest-lifecycle-bb05d687', 'antnest-lifecycle-3b2471aa', 'antnest-lifecycle-6d5d6261'],
        'lifecycle-restore-migration': ['antnest-lifecycle-284110cf', 'antnest-lifecycle-c5855a3f'],
    }
    if name in fixed_projects:
        config['projects'] = fixed_projects[name]
    if name == 'runtime-inspect-absence':
        config.update(candidate_reference='antnest/runtime-controller:inspect-absence-20260921',
                      candidate_image='sha256:4612f0bcd3bc86a95bd5b71f0de2c5fb509c9ffce819ef67a49d38bbf26137e0')
    if profile['trace'] in ['network', 'shutdown']:
        project = {'network': 'antnest-lifecycle-db6c8d75', 'shutdown': 'antnest-lifecycle-f575edfc'}[profile['trace']]
        config['trace_directory'] = str(root.parent / ('lifecycle-' + profile['trace']) / project / 'traces')
    if profile['trace'] == 'temporal':
        config['trace_roots'] = {kind: str(root.parent / ('lifecycle-' + kind)) for kind in ['shutdown', 'foundation']}
    return config


def reconstruct(row, schema):
    lower = schema.startswith('lower')
    key = lambda lo, upper: row.get(lo if lower else upper)
    health = key('health', 'Health')
    return {'Id': key('id', 'Id'), 'Name': '/' + key('name', 'Name').lstrip('/'), 'Image': key('image', 'Image'),
            'RestartCount': row.get('RestartCount', 0), 'Mounts': key('mounts', 'Mounts') or [],
            'State': {'Running': row.get('running' if lower else 'Running', True), 'StartedAt': row.get('StartedAt', ''),
                      **({'Health': {'Status': health}} if health is not None else {})},
            'NetworkSettings': {'Networks': {key: {} for key in row.get('Networks', [])}}}


def replay(evidence, output):
    results = []
    for name, profile in PROFILES.items():
        root = durable_path(evidence / Path(profile['source']).parent.name)
        config = historical_config(name, profile, root, output / name)
        prepared = prepare(config)
        rows = [reconstruct(row, profile['schema']) for row in prepared['before']]
        calls = []

        def fixture(*args):
            calls.append(args)
            if args[:2] == ('docker', 'inspect'):
                assert list(args[2:]) == [row['Id'] for row in rows]
                return json.dumps(rows)
            if args == ('docker', 'ps', '-aq'):
                return '\n'.join(row['Id'] for row in rows)
            if args[0] == 'ps' or '--filter' in args:
                return ''
            if args[:3] == ('docker', 'image', 'inspect'):
                if '--format' in args:
                    return prepared['local_image'] if args[-1].endswith(':local') else prepared['candidate_image']
                assert list(args[3:]) == [row['reference'] for row in prepared['images']]
                return json.dumps([{'Id': row['id']} for row in prepared['images']])
            inventory = {('docker', 'ps', '-aq', '--no-trunc'): 'containers',
                         ('docker', 'volume', 'ls', '-q'): 'volumes',
                         ('docker', 'network', 'ls', '-q', '--no-trunc'): 'networks'}
            if args in inventory:
                return '\n'.join(prepared['resources'][inventory[args]])
            raise AssertionError(f'unexpected fixture command: {args}')

        result = verify(prepared, call=fixture)
        expected = read_json(root / profile['report'])
        removed_metadata = expected.pop('local_tests', None) if profile['trace'] == 'temporal' else None
        assert result == expected, f'historical cleanup report differs: {name}'
        results.append(dict(profile=name, report_matches=True, external_calls=len(calls),
                            running_fixture_assumption=profile['schema'].startswith('lower4'),
                            removed_unverified_constant=removed_metadata))
    report = dict(status='passed', profiles=results,
                  scope='Historical report and real saved Trace equivalence using baseline-reconstructed Docker rows and empty resource/process fixtures; not current Docker acceptance. Lower4 baselines omit Running, assumed true only in this replay.')
    write_report(output, 'comparison.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-root', required=True, type=durable_path)
    parser.add_argument('--output', required=True, type=durable_path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(replay(args.evidence_root, args.output)))
