"""Executable observer contracts with an owned local process tree and fake Docker."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]
CHILD = ROOT / 'tests/support/fixtures/observer-child.py'
DOCKER = ROOT / 'tests/support/fixtures/observer-docker.py'
ENTRIES = {
    'commands': ROOT / 'tests/support/diagnostics/commands-observer.py',
    'sdk': ROOT / 'tests/support/diagnostics/sdk-observer.py',
    'interruption': ROOT / 'tests/e2e/acp-progress/interruption.py',
}


def alive(pid):
    try:
        os.kill(pid, 0)
        state = subprocess.check_output(['ps', '-p', str(pid), '-o', 'stat='], text=True).strip()
        return bool(state) and not state.startswith('Z')
    except (ProcessLookupError, subprocess.CalledProcessError):
        return False


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='antnest-observer-')
        self.root = Path(self.temporary.name)
        self.output = self.root / 'output'
        self.config = self.root / 'config.json'
        self.process = None
        self.stdout = (self.root / 'stdout').open('w+')
        self.stderr = (self.root / 'stderr').open('w+')
        binary = self.root / 'bin'
        binary.mkdir()
        # Keep the fake executable private to this test; repository mode is unchanged.
        fake = binary / 'docker'
        fake.write_bytes(DOCKER.read_bytes())
        fake.chmod(0o700)
        self.environment = {
            **os.environ,
            'PATH': str(binary) + os.pathsep + os.environ['PATH'],
            'OBSERVER_FIXTURE_ROOT': str(self.root),
            'OBSERVER_IGNORE_TERM': 'true',
        }

    def tearDown(self):
        # Always reap/kill our fixture, including on the pre-fix red runs.
        parent = self.root / 'parent.json'
        if parent.exists():
            self.signal_group(json.loads(parent.read_text())['pgid'], signal.SIGKILL)
        if self.process:
            self.signal_group(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        worker = self.root / 'worker.pid'
        if worker.exists():
            deadline = time.monotonic() + 5
            while alive(int(worker.read_text())) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(alive(int(worker.read_text())), 'fixture worker escaped test cleanup')
        self.stdout.close()
        self.stderr.close()
        self.temporary.cleanup()

    @staticmethod
    def signal_group(pgid, signum):
        try:
            os.killpg(pgid, signum)
        except ProcessLookupError:
            pass

    def settings(self, name, mode='waiting'):
        config = {
            'output': str(self.output),
            'command': [sys.executable, '-B', str(CHILD), mode],
            'environment': {},
            'cleanup_grace_seconds': 0.15,
        }
        if name == 'commands':
            config.update(project_pattern=r'antnest-stage3-e2e-\d+', services=[
                'agent-controller', 'runtime-controller', 'agent-acp-service', 'edge-gateway', 'admin-console'])
        elif name == 'sdk':
            config.update(container_filter='name=antnest-acp-sdk-', container_pattern=r'antnest-acp-sdk-[0-9a-f]{8}-(postgres|service)')
        else:
            config.update(project_template='antnest-stage3-e2e-{pid}', trigger_filter='name=^/{project}-progress-client$', trigger_description='progress-client created')
        return config

    def start(self, name, config=None, *, preload=None, **environment):
        self.config.write_text(json.dumps(config or self.settings(name)))
        if preload:
            bootstrap = f"import sys,runpy;sys.path.insert(0,{str(ROOT / 'tests/support/verification')!r});" + preload + ";sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')"
            command = [sys.executable, '-B', '-c', bootstrap, str(ENTRIES[name]), '--config', str(self.config)]
        else:
            command = [sys.executable, '-B', str(ENTRIES[name]), '--config', str(self.config)]
        self.process = subprocess.Popen(
            command,
            cwd=ROOT, env={**self.environment, **environment}, stdout=self.stdout, stderr=self.stderr,
            start_new_session=True,
        )

    def finish(self, timeout=12):
        code = self.process.wait(timeout=timeout)
        self.stdout.seek(0)
        self.stderr.seek(0)
        return code, self.stdout.read(), self.stderr.read()

    def ready(self):
        deadline = time.monotonic() + 5
        while not (self.root / 'ready').exists() and time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail(str(self.finish()))
            time.sleep(0.01)
        self.assertTrue((self.root / 'ready').exists())

    def assert_worker_gone(self):
        pid = int((self.root / 'worker.pid').read_text())
        self.assertFalse(alive(pid), f'observer left descendant {pid}')

    def test_commands_reaps_descendants_after_parent_exit_and_preserves_exit_code(self):
        self.start('commands', self.settings('commands', 'parent-exits'), OBSERVER_EXIT_CODE='7')
        code, _, error = self.finish()
        self.assertEqual(code, 7, error)
        self.assert_worker_gone()

    def test_sdk_reaps_descendants_after_parent_exit(self):
        self.start('sdk', self.settings('sdk', 'parent-exits'))
        code, _, error = self.finish()
        self.assertEqual(code, 0, error)
        self.assert_worker_gone()

    def test_sdk_reaps_descendants_when_signal_zero_probe_is_denied(self):
        preload = "import owned_process;real=owned_process.os.killpg;owned_process.os.killpg=lambda pid,sig: (_ for _ in ()).throw(PermissionError('probe denied')) if sig==0 else real(pid,sig)"
        self.start('sdk', self.settings('sdk', 'parent-exits'), preload=preload)
        code, _, error = self.finish()
        self.assertEqual(code, 0, error)
        self.assert_worker_gone()

    def test_commands_observer_failure_preserves_failure_and_reaps_children(self):
        self.start('commands', OBSERVER_DOCKER_MODE='error')
        code, _, error = self.finish()
        self.assertNotEqual(code, 0)
        self.assertIn('CalledProcessError', error)
        self.assert_worker_gone()

    def test_sdk_observer_failure_reaps_children(self):
        self.start('sdk', OBSERVER_DOCKER_MODE='error')
        code, _, _ = self.finish()
        self.assertNotEqual(code, 0)
        self.assert_worker_gone()

    def interrupt_observer(self, name):
        self.start(name)
        self.ready()
        self.process.send_signal(signal.SIGTERM)
        time.sleep(0.08)
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
        code, _, error = self.finish()
        self.assertEqual(code, 143, error)
        self.assert_worker_gone()

    def test_commands_handles_repeated_external_sigterm(self):
        self.interrupt_observer('commands')

    def test_sdk_handles_repeated_external_sigterm(self):
        self.interrupt_observer('sdk')

    def test_interruption_handles_external_sigterm(self):
        self.interrupt_observer('interruption')

    def test_interruption_reports_fixture_leak_before_harness_cleanup(self):
        self.start('interruption', OBSERVER_DOCKER_MODE='trigger')
        code, _, error = self.finish()
        self.assertNotEqual(code, 0)
        self.assertIn('verification child processes remain', error)
        report = json.loads((self.output / 'interruption.json').read_text())
        self.assertIn(int((self.root / 'worker.pid').read_text()), report['remainingChildPids'])
        self.assertEqual(report['signal'], 'SIGTERM')
        self.assertNotEqual(report['exitCode'], 0)
        self.assert_worker_gone()

    def test_interruption_accepts_fixture_that_cleans_its_own_children(self):
        self.start('interruption', self.settings('interruption', 'clean-trigger'), OBSERVER_DOCKER_MODE='trigger', OBSERVER_IGNORE_TERM='false')
        code, _, error = self.finish()
        self.assertEqual(code, 0, error)
        report = json.loads((self.output / 'interruption.json').read_text())
        self.assertEqual(report['remainingChildPids'], [])
        self.assertFalse(any(report['resources'].values()))
        self.assert_worker_gone()

    def test_interruption_does_not_count_an_undelivered_signal(self):
        preload = "import owned_process;original=owned_process.OwnedProcess.signal_group;calls=[];owned_process.OwnedProcess.signal_group=lambda self,sig: (calls.append(sig) or False) if not calls else original(self,sig)"
        self.start('interruption', preload=preload, OBSERVER_DOCKER_MODE='trigger')
        code, _, error = self.finish()
        self.assertNotEqual(code, 0)
        self.assertIn('fixture ended before SIGTERM was delivered', error)
        report = json.loads((self.output / 'interruption.json').read_text())
        self.assertIsNone(report['signal'])
        self.assertIsNone(report['exitCode'])
        self.assert_worker_gone()

    def test_interruption_timeout_is_not_reclassified_after_fallback_cleanup(self):
        preload = "import owned_process,subprocess;owned_process.OwnedProcess.wait=lambda self,timeout: (_ for _ in ()).throw(subprocess.TimeoutExpired(self.command,timeout))"
        self.start('interruption', preload=preload, OBSERVER_DOCKER_MODE='trigger')
        code, _, error = self.finish()
        self.assertNotEqual(code, 0)
        self.assertIn('TimeoutExpired', error)
        report = json.loads((self.output / 'interruption.json').read_text())
        self.assertIsNone(report['exitCode'])
        self.assertEqual(report['signal'], 'SIGTERM')
        self.assert_worker_gone()

    def test_interruption_preserves_resource_failure(self):
        self.start('interruption', self.settings('interruption', 'clean-trigger'), OBSERVER_DOCKER_MODE='leak', OBSERVER_IGNORE_TERM='false')
        code, _, error = self.finish()
        self.assertNotEqual(code, 0)
        self.assertIn('owned Docker resources remain', error)
        report = json.loads((self.output / 'interruption.json').read_text())
        self.assertTrue(all(report['resources'].values()))

    def test_interruption_rejects_bad_project_template_before_spawn(self):
        config = self.settings('interruption')
        config['project_template'] = '{unknown}'
        self.start('interruption', config)
        code, _, _ = self.finish()
        self.assertNotEqual(code, 0)
        self.assertFalse((self.root / 'parent.json').exists())
        self.assertFalse(self.output.exists())

    def test_sdk_rejects_invalid_selector_before_spawn(self):
        config = self.settings('sdk')
        config['container_pattern'] = '['
        self.start('sdk', config)
        code, _, _ = self.finish()
        self.assertNotEqual(code, 0)
        self.assertFalse((self.root / 'parent.json').exists())
        self.assertFalse(self.output.exists())

    def observe_snapshots(self, name):
        self.start(name, OBSERVER_DOCKER_MODE='observe')
        self.ready()
        suffix = '.diagnostic-states.json' if name == 'commands' else '.state.json'
        deadline = time.monotonic() + 6
        while not list(self.output.glob('*' + suffix)) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(list(self.output.glob('*' + suffix)))
        files = list(self.output.glob('*.private.log'))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_text(), 'private fixture log\n')
        self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
        self.process.send_signal(signal.SIGTERM)
        code, _, error = self.finish()
        self.assertEqual(code, 143, error)
        self.assert_worker_gone()

    def test_commands_keeps_container_states_and_selected_private_logs(self):
        self.observe_snapshots('commands')

    def test_sdk_keeps_filtered_container_states_and_private_logs(self):
        self.observe_snapshots('sdk')


if __name__ == '__main__':
    unittest.main()
