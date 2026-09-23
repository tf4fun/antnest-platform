"""Bounded ownership of one subprocess session, including surviving descendants."""
import os
import signal
import subprocess
import time


def process_table():
    output = subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid=,pgid=,stat='], text=True, timeout=15)
    return {int(pid): {'parent': int(parent), 'group': int(group), 'state': state}
            for line in output.splitlines()
            if len(fields := line.split()) == 4
            for pid, parent, group, state in [fields]}


class OwnedProcess:
    def __init__(self, command, *, grace_seconds, **kwargs):
        self.command = command
        self.grace_seconds = grace_seconds
        self.kwargs = kwargs
        self.child = None
        self.cancelled = None
        self.handlers = {}

    def _cancel(self, signum, frame):
        # Never raise between Popen and assignment, or interrupt finally cleanup.
        if self.cancelled is None:
            self.cancelled = signum

    def check_cancel(self):
        if self.cancelled is not None:
            raise SystemExit(128 + self.cancelled)

    def __enter__(self):
        for signum in [signal.SIGINT, signal.SIGTERM]:
            self.handlers[signum] = signal.signal(signum, self._cancel)
        try:
            self.check_cancel()
            self.child = subprocess.Popen(self.command, start_new_session=True, **self.kwargs)
            self.check_cancel()
            return self
        except BaseException as error:
            self.__exit__(type(error), error, error.__traceback__)
            raise

    def call(self, function, *args, **kwargs):
        self.check_cancel()
        try:
            result = function(*args, **kwargs)
        except Exception:
            self.check_cancel()
            raise
        self.check_cancel()
        return result

    def pause(self, seconds):
        deadline = time.monotonic() + seconds
        while self.child.poll() is None and time.monotonic() < deadline:
            self.check_cancel()
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        self.check_cancel()

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while self.child.poll() is None:
            self.check_cancel()
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.command, timeout)
            time.sleep(0.05)
        self.check_cancel()
        return self.child.returncode

    def signal_group(self, signum):
        if self.child is not None:
            try:
                os.killpg(self.child.pid, signum)
                return True
            except ProcessLookupError:
                pass
            except PermissionError:
                # Some process backends deny signals during group teardown.
                # Only an independent, successful member snapshot can prove
                # that this signal is no longer needed.
                try:
                    if self.child.poll() is not None and not self.group_members():
                        return False
                except (OSError, subprocess.SubprocessError):
                    pass
                raise
        return False

    def group_members(self):
        if self.child is None:
            return []
        return sorted(pid for pid, row in process_table().items()
                      if row['group'] == self.child.pid and not row['state'].startswith('Z'))

    def _group_alive(self):
        # Reap the direct child even if its descendants outlive it.
        self.child.poll()
        try:
            os.killpg(self.child.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            # A denied existence probe is not evidence that the group is gone.
            # Confirm with the process table below, retaining live/unknown state.
            pass
        # A zombie cannot respond to KILL; its adopter is responsible for reaping.
        try:
            return self.child.poll() is None or bool(self.group_members())
        except (OSError, subprocess.SubprocessError):
            # Cancellation of a diagnostic ps must not prevent the owned KILL.
            return True

    def cleanup(self):
        if self.child is None:
            return
        self.signal_group(signal.SIGTERM)
        deadline = time.monotonic() + self.grace_seconds
        while self._group_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        if self._group_alive():
            self.signal_group(signal.SIGKILL)
        self.child.wait(timeout=5)
        deadline = time.monotonic() + 5
        while self._group_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        if self._group_alive():
            raise RuntimeError('owned subprocess group survived cleanup')

    def __exit__(self, error_type, error, traceback):
        try:
            try:
                self.cleanup()
            except BaseException as cleanup_error:
                if error is None:
                    raise
                error.add_note(f'owned subprocess cleanup failed: {cleanup_error}')
            if error is None:
                self.check_cancel()
        finally:
            for signum, handler in self.handlers.items():
                signal.signal(signum, handler)
        return False
