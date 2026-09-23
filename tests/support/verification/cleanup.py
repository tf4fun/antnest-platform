#!/usr/bin/env python3
"""Read-only cleanup verification; all baselines and evidence paths are explicit."""
import json
import os
from pathlib import Path
import re
import subprocess
from cleanup_contracts import (assert_retained_state, check_retained, foundation_project,
                               process_violations, read_json, temporal_results, trace_summary)
from cleanup_profiles import PROFILES
from configuration import configured_arguments, durable_path

RESOURCES = {'containers': ['ps', '-aq'], 'volumes': ['volume', 'ls', '-q'], 'networks': ['network', 'ls', '-q']}
LABELS = ['com.docker.compose.project', 'io.antnest.runtime-controller-scope']


def required_string(value, label):
    if not isinstance(value, str) or not value.strip() or value.startswith('-'):
        raise ValueError(f'{label} must be a nonempty string')
    return value


def image_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise ValueError('image ID must be a full sha256 digest')
    return value


def project_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'antnest-[a-zA-Z0-9_-]+', value):
        raise ValueError('invalid explicit project name')
    return value


def prepare(config):
    name = config.get('profile')
    if name not in PROFILES:
        raise ValueError('unknown cleanup profile')
    profile = PROFILES[name]
    allowed = {'profile', 'input_root', 'output'}
    if profile.get('required_projects'):
        allowed.add('projects')
    if profile['trace'] in ['network', 'shutdown']:
        allowed.add('trace_directory')
    if profile['trace'] == 'temporal':
        allowed.add('trace_roots')
    if name == 'runtime-inspect-absence':
        allowed.update(['candidate_reference', 'candidate_image'])
    if set(config) - allowed:
        raise ValueError('unknown cleanup configuration fields: ' + ', '.join(sorted(set(config) - allowed)))
    root = durable_path(required_string(config.get('input_root'), 'input_root'))
    output = durable_path(required_string(config.get('output'), 'output'))
    if not root.is_dir():
        raise ValueError('input_root must be an existing evidence directory')
    for filename in [profile['report']] + (['retained-final.json'] if profile['result'] == 'final' else []):
        if durable_path(output / filename).exists():
            raise ValueError('output report already exists; use a new output directory')
    before = read_json(root / profile['baseline'])
    schema = profile['schema']
    fields = {'id', 'name', 'image', 'health'} if schema.startswith('lower') else {
        'Id', 'Name', 'Image', 'RestartCount', 'Mounts', 'StartedAt', 'Running', 'Health', 'Networks'}
    if schema.startswith(('lower5', 'lower6')):
        fields.add('running')
    if schema.startswith('lower6'):
        fields.add('mounts')
    if not isinstance(before, list) or not before or any(not isinstance(row, dict) or set(row) != fields for row in before):
        raise ValueError('retained baseline must contain complete schema rows')
    id_key = 'id' if schema.startswith('lower') else 'Id'
    ids = [row[id_key] for row in before]
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in ids) or len(set(ids)) != len(ids):
        raise ValueError('retained baseline requires unique full container IDs')
    projects = []
    if profile.get('project_glob'):
        for path in sorted(root.glob(profile['project_glob'])):
            projects.extend(re.findall(profile['project_regex'], durable_path(path).read_text()))
    for filename in profile['required_logs']:
        path = durable_path(root / filename)
        if profile.get('project_regex'):
            match = re.search(profile['project_regex'], path.read_text())
            if not match:
                raise ValueError(f'required project missing from {filename}')
            projects.append(match[1])
        else:
            projects.append(foundation_project(path))
    if profile.get('project_report'):
        projects.append(read_json(root / profile['project_report'])['project'])
    if profile.get('required_projects'):
        explicit = config.get('projects')
        if (not isinstance(explicit, list) or len(explicit) != profile['required_projects']
                or not all(isinstance(project, str) for project in explicit) or len(set(explicit)) != len(explicit)):
            raise ValueError('profile requires its exact number of distinct explicit projects')
        if not all(re.fullmatch(profile['explicit_project_regex'], project) for project in explicit):
            raise ValueError('explicit projects must match the original project family')
        projects.extend(explicit)
    projects = [project_name(project) for project in projects]
    if profile['require_projects'] and not projects:
        raise ValueError('profile requires projects from its logs')
    if profile['result'] in ['identity', 'legacy', 'retirement', 'crash']:
        projects = sorted(set(projects))
    prepared = dict(profile=profile, name=name, root=root, output=output, before=before, ids=ids, projects=projects)
    if profile['trace'] in ['network', 'shutdown']:
        directory = durable_path(required_string(config.get('trace_directory'), 'trace_directory'))
        if directory.name != 'traces' or directory.parent.name != foundation_project(root / profile['trace_project_log']):
            raise ValueError('trace project must match the selected run log')
        prepared['trace'] = trace_summary(sorted(directory.glob('*.json')), profile['trace'])
    if profile['trace'] == 'temporal':
        roots = config.get('trace_roots')
        if not isinstance(roots, dict) or set(roots) != {'shutdown', 'foundation'}:
            raise ValueError('trace_roots requires shutdown and foundation directories')
        roots = {key: durable_path(required_string(value, key)) for key, value in roots.items()}
        prepared['runs'] = temporal_results(root, roots)
    if name == 'runtime-inspect-absence':
        prepared['local_image'] = image_id(read_json(root / 'local-image-before.json')['runtime_controller'])
        prepared['candidate_reference'] = required_string(config.get('candidate_reference'), 'candidate_reference')
        prepared['candidate_image'] = image_id(config.get('candidate_image'))
    if profile['result'] == 'final':
        resources = read_json(root / 'resource-baseline.json')
        if (not isinstance(resources, dict) or set(resources) != set(RESOURCES)
                or any(not isinstance(values, list) or not all(isinstance(v, str) and v for v in values)
                       or len(values) != len(set(values)) for values in resources.values())):
            raise ValueError('resource baseline requires all three unique resource inventories')
        images = read_json(root / 'images-candidate.json')
        if not isinstance(images, list) or not images:
            raise ValueError('candidate images baseline must not be empty')
        for row in images:
            required_string(row['reference'], 'image reference')
            image_id(row['id'])
        if len({row['reference'] for row in images}) != len(images):
            raise ValueError('candidate images baseline must have unique references')
        prepared.update(resources=resources, images=images)
    return prepared


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def write_report(output, name, value):
    path = durable_path(output / name)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(json.dumps(value, indent=2) + '\n')


def verify(prepared, *, call=command):
    profile, projects = prepared['profile'], prepared['projects']
    schema, kind = profile['schema'], profile['result']
    resources = {}
    for project in projects:
        labels = LABELS[1:] if profile['scope_only'] else LABELS
        for label in labels:
            for resource, args in RESOURCES.items():
                found = call('docker', *args, '--filter', f'label={label}={project}').split()
                resources[f'{project}/{label}/{resource}'] = found
                assert not found, f'resources remain: {project} {label} {resource}: {found}'
        if profile['resource_names']:
            for resource, args in RESOURCES.items():
                assert not call('docker', *args, '--filter', f'name={project}').strip(), f'resources remain by name: {project} {resource}'
    ids = call('docker', 'ps', '-aq').split() if schema == 'lower6-all' else prepared['ids']
    rows = json.loads(call('docker', 'inspect', *ids)) if ids else []
    after, changes = check_retained(prepared['before'], rows, schema, check=kind != 'final')
    if profile['process']:
        children = process_violations(profile['process'], call('ps', '-axo', 'pid=,ppid=,command='),
                                      legacy_mode=profile.get('legacy_mode', ''), legacy_prefix=profile.get('legacy_prefix', ''))
        assert not children, f'verification children remain: {children}'
    running = sum(row['State']['Running'] for row in rows)
    healthy = sum(row['State'].get('Health', {}).get('Status') == 'healthy' for row in rows)
    if kind == 'identity':
        result = dict(retained_containers=len(rows), retained_ids_images_health_unchanged=True,
                      temporary_projects=projects, all_owned_containers_networks_volumes_removed=True)
    elif kind == 'legacy':
        result = dict(projects=projects, remaining_owned_resources=0, retained_unchanged=len(rows), running_verification_children=0)
    elif kind == 'selected':
        result = dict(projects=projects, resources=resources, retained_containers_unchanged=len(rows),
                      retained_running=running, retained_healthy=healthy, verification_children=[])
        if prepared['name'] == 'runtime-inspect-absence':
            assert call('docker', 'image', 'inspect', '--format', '{{.Id}}', 'antnest/runtime-controller:local').strip() == prepared['local_image'], 'local image changed'
            assert call('docker', 'image', 'inspect', '--format', '{{.Id}}', prepared['candidate_reference']).strip() == prepared['candidate_image'], 'candidate image changed'
            assert not call('docker', 'ps', '-aq', '--filter', 'name=antnest-image-reference-test-').strip(), 'temporary image reference container remains'
            assert not call('docker', 'image', 'ls', '-q', '--filter', 'reference=antnest-image-reference-test-*').strip(), 'temporary image reference image remains'
            result.update(local_image_unchanged=True, candidate_preserved=True)
    elif kind == 'retirement':
        result = dict(projects=projects, owned_resources=0, retained_containers_unchanged=len(rows),
                      running=running, healthy=healthy, verification_children=0)
    elif kind == 'crash':
        result = dict(scopes=projects, owned_resources=0, retained_unchanged=len(rows), running=running, healthy=healthy, verification_children=0)
    elif kind in ['network', 'shutdown']:
        trace = prepared['trace']
        result = dict(projects_cleaned=projects, retained_containers_unchanged=len(rows), verification_children=0)
        prefix = 'network' if kind == 'network' else 'successful_run'
        result.update({f'{prefix}_raw_traces': trace['traces'], f'{prefix}_missing_parent_edges': trace['missing'],
                       f'{prefix}_' + ('error_spans' if kind == 'network' else 'error_tag_spans'): trace['errors'],
                       f'{prefix}_warning_traces': trace['warning_traces']})
    elif kind == 'temporal':
        result = dict(runs=prepared['runs'], retained_containers_unchanged=len(rows), verification_children=0, mutation_transport_errors=0)
    else:
        inventory = {key: sorted(call('docker', *args, *(['--no-trunc'] if key != 'volumes' else [])).split()) for key, args in RESOURCES.items()}
        delta = {key: dict(added=sorted(set(values) - set(prepared['resources'][key])),
                           removed=sorted(set(prepared['resources'][key]) - set(values))) for key, values in inventory.items()}
        images = json.loads(call('docker', 'image', 'inspect', *[row['reference'] for row in prepared['images']]))
        assert len(images) == len(prepared['images']), 'image inspection count mismatch'
        image_changes = [old['reference'] for old, new in zip(prepared['images'], images) if old['id'] != new['Id']]
        result = dict(resource_counts={key: len(values) for key, values in inventory.items()}, resource_delta=delta,
                      retained_count=len(rows), retained_running=running, retained_healthy=healthy,
                      retained_changes=changes, image_changes=image_changes)
        write_report(prepared['output'], 'retained-final.json', after)
        write_report(prepared['output'], profile['report'], result)
        assert not any(values for item in delta.values() for values in item.values()), 'resource inventory drift'
        assert not changes, 'retained container changed'
        assert not image_changes, 'image drift'
        assert_retained_state(rows, schema)
        return result
    write_report(prepared['output'], profile['report'], result)
    return result


def main():
    prepared = None

    def validate(config):
        nonlocal prepared
        prepared = prepare(config)

    configured_arguments(require_mode=False, validate_config=validate)
    print(json.dumps(verify(prepared)))


if __name__ == '__main__':
    main()
