"""Own every Linux installer descendant, including setsid/double-fork children.

The coordinator retains the caller's HOME/cache. Only dependency installation
and dpkg recovery cross sudo. A private Unix connection carries cancellation
independently of sudo's process group/PTY, and EOF also stops the owner.
"""
import ctypes
import errno
import json
import math
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time


def remaining(deadline):
    return max(0.0, deadline - time.monotonic())


def failure(error):
    return f"{type(error).__name__}: {error}"


def require_linux_owner():
    if sys.platform != "linux":
        raise RuntimeError("Chromium ownership requires Linux /proc and pidfds")
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text()
    direct_children(os.getpid())


class Cancellation:
    def __init__(self):
        self.requested = False
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, self.receive)

    def receive(self, signum, frame):
        # Do not raise between Popen and assigning its owned handle.
        self.requested = True


class Channel:
    def __init__(self, connection):
        self.socket = connection
        self.socket.setblocking(False)
        self.buffer = b""
        self.eof = False

    def send(self, value, deadline):
        self.socket.settimeout(min(0.1, remaining(deadline)))
        try:
            self.socket.sendall((json.dumps(value) + "\n").encode())
        finally:
            self.socket.setblocking(False)

    def read(self):
        while not self.eof:
            try:
                chunk = self.socket.recv(4096)
            except BlockingIOError:
                break
            if not chunk:
                self.eof = True
                break
            self.buffer += chunk
            if len(self.buffer) > 65536:
                raise RuntimeError("owner control frame exceeded its bound")
        messages = []
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError("invalid owner control frame")
            messages.append(value)
        if self.eof and self.buffer:
            raise RuntimeError("incomplete owner control frame")
        return messages


def proc_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
        return fields[19], int(fields[1])
    except (FileNotFoundError, ProcessLookupError):
        return None


def direct_children(pid):
    # A child can be spawned by any thread, not just the thread-group leader.
    result = set()
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except (FileNotFoundError, ProcessLookupError):
        return result
    for task in tasks:
        try:
            result.update(int(value) for value in
                          (task / "children").read_text().split())
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def descendants():
    found = set()
    pending = list(direct_children(os.getpid()))
    while pending:
        pid = pending.pop()
        if pid not in found:
            found.add(pid)
            pending.extend(direct_children(pid))
    return found


def belongs_to_owner(pid):
    seen = set()
    while pid not in seen:
        seen.add(pid)
        identity = proc_identity(pid)
        if identity is None:
            return False
        pid = identity[1]
        if pid == os.getpid():
            return True
        if pid <= 1:
            return False
    return False


class Children:
    def __init__(self):
        self.process = None
        self.code = None

    def start(self, command, node_directory):
        env = dict(os.environ)
        env["PATH"] = node_directory + os.pathsep + env.get("PATH", "")
        self.process = subprocess.Popen(
            command, env=env, stdin=subprocess.DEVNULL,
            close_fds=True, start_new_session=True)

    def reap(self):
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True  # ECHILD, including adopted double-fork children.
            if pid == 0:
                return False
            if self.process is not None and pid == self.process.pid:
                self.code = os.waitstatus_to_exitcode(status)
                self.process.returncode = self.code

    def send(self, signum):
        for pid in descendants():
            original = proc_identity(pid)
            if original is None:
                continue
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                # Check identity and current ancestry after opening the pidfd.
                # Never signal by name, stale PID, or a historical PGID.
                if proc_identity(pid) == original and belongs_to_owner(pid):
                    try:
                        signal.pidfd_send_signal(fd, signum)
                    except ProcessLookupError:
                        pass
            finally:
                os.close(fd)

    def finish(self, deadline, poll_control):
        errors = []
        term_sent = False
        term_until = min(deadline, time.monotonic() +
                         min(1.0, remaining(deadline) / 3))
        while True:
            try:
                if self.reap():
                    return True, errors
                poll_control()
            except Exception as error:
                message = failure(error)
                if message not in errors:
                    errors.append(message)
            signum = signal.SIGTERM if not term_sent or time.monotonic() < term_until else signal.SIGKILL
            term_sent = True
            try:
                self.send(signum)
            except Exception as error:
                message = failure(error)
                if message not in errors:
                    errors.append(message)
            if not remaining(deadline):
                # A successful signal is not a successful join.
                try:
                    if signum != signal.SIGKILL:
                        self.send(signal.SIGKILL)
                    joined = self.reap()
                except Exception as error:
                    errors.append(failure(error))
                    joined = False
                if not joined:
                    errors.append("cleanup deadline expired before ECHILD")
                return joined, errors
            time.sleep(min(0.01, remaining(deadline)))


def owner(socket_path, deadline, node_directory, command):
    cancellation = Cancellation()
    require_linux_owner()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(remaining(deadline))
    connection.connect(socket_path)
    channel = Channel(connection)
    children = Children()
    primary = None
    started = False
    budget_cancel = False

    def poll_control():
        nonlocal started, budget_cancel
        for message in channel.read():
            if message == {"kind": "run"} and not started:
                started = True
            elif message == {"kind": "cancel"}:
                cancellation.requested = True
            elif message == {"kind": "budget"}:
                budget_cancel = True
            else:
                raise RuntimeError("unexpected owner control message")
        if channel.eof:
            cancellation.requested = True

    try:
        channel.send({"kind": "ready", "pid": os.getpid(),
                      "uid": os.geteuid()}, deadline)
        # Reserve cleanup inside this phase's existing absolute deadline.
        work_deadline = deadline - min(30.0, remaining(deadline) / 2)
        while not started and not cancellation.requested and not budget_cancel:
            poll_control()
            if time.monotonic() >= work_deadline:
                budget_cancel = True
                break
            select.select([connection], [], [], min(0.01, remaining(work_deadline)))
        if not cancellation.requested and not budget_cancel:
            children.start(command, node_directory)
            while True:
                children.reap()
                poll_control()
                if cancellation.requested or children.code is not None:
                    break
                if budget_cancel or time.monotonic() >= work_deadline:
                    budget_cancel = True
                    break
                select.select([connection], [], [], min(0.01, remaining(work_deadline)))
        if children.code is not None and children.code != 0:
            primary = f"installation command exited with status {children.code}"
        elif cancellation.requested:
            primary = "installation cancelled"
        elif budget_cancel:
            primary = "installation command exceeded its attempt deadline"
        elif children.code != 0:
            primary = f"installation command exited with status {children.code}"
    except Exception as error:
        primary = failure(error)
    finally:
        joined, errors = children.finish(deadline, poll_control)
        try:
            poll_control()
        except Exception as error:
            errors.append(failure(error))
        if cancellation.requested and primary is None:
            primary = "installation cancelled"
        result = {"kind": "result", "exit_code": children.code,
                  "primary": primary, "cleanup_errors": errors,
                  "joined": joined, "cancelled": cancellation.requested,
                  "uid": os.geteuid()}
        try:
            channel.send(result, deadline)
        except OSError:
            # Parent disappearance still requires the completed cleanup above.
            print(f"Chromium owner uid={os.geteuid()} joined={joined}", file=sys.stderr)
        finally:
            connection.close()
    return 130 if cancellation.requested else int(primary is not None or bool(errors) or not joined)


def validate_result(value, uid):
    if (set(value) != {"kind", "exit_code", "primary", "cleanup_errors",
                       "joined", "cancelled", "uid"} or
            value["kind"] != "result" or value["uid"] != uid or
            (value["exit_code"] is not None and type(value["exit_code"]) is not int) or
            (value["primary"] is not None and not isinstance(value["primary"], str)) or
            type(value["joined"]) is not bool or type(value["cancelled"]) is not bool or
            not isinstance(value["cleanup_errors"], list) or
            any(not isinstance(error, str) for error in value["cleanup_errors"])):
        raise RuntimeError("invalid owner completion receipt")
    return value


def phase(command, elevated, deadline, node_directory, sudo, cancellation):
    if cancellation.requested:
        return {"primary": "installation cancelled", "cleanup_errors": [],
                "joined": True, "cancelled": True, "exit_code": None}
    errors = []
    result = None
    channel = None
    process = None
    ready_uid = None
    sent_cancel = False
    owner_deadline = deadline - min(2.0, remaining(deadline) / 10)

    def receive():
        nonlocal result, ready_uid
        for message in channel.read():
            if message.get("kind") == "ready" and ready_uid is None:
                pid, uid, _ = struct.unpack(
                    "3i", channel.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if message != {"kind": "ready", "pid": pid, "uid": uid}:
                    raise RuntimeError("owner identity differs from its control peer")
                ready_uid = uid
                channel.send({"kind": "cancel" if cancellation.requested else "run"}, deadline)
            elif message.get("kind") == "result" and ready_uid is not None and result is None:
                result = validate_result(message, ready_uid)
            else:
                raise RuntimeError("unexpected coordinator control message")

    with tempfile.TemporaryDirectory(prefix="antnest-chromium-") as directory:
        path = str(Path(directory) / "control.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(path)
            listener.listen(1)
            listener.setblocking(False)
            args = [sys.executable, "-B", str(Path(__file__).resolve()),
                    "--owner", path, str(owner_deadline), node_directory, *command]
            if elevated:
                args = [sudo, "-n", "--", *args]
            if remaining(owner_deadline) <= 0:
                raise TimeoutError("attempt deadline expired before owner startup")
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                       close_fds=True, start_new_session=True)
            while remaining(owner_deadline):
                if channel is None:
                    try:
                        connection, _ = listener.accept()
                        channel = Channel(connection)
                    except BlockingIOError:
                        pass
                if channel is not None:
                    receive()
                    if cancellation.requested and not sent_cancel:
                        channel.send({"kind": "cancel"}, deadline)
                        sent_cancel = True
                if process.poll() is not None:
                    if result is not None or channel is None or channel.eof:
                        break
                select.select([channel.socket if channel else listener], [], [],
                              min(0.01, remaining(owner_deadline)))
        except Exception as error:
            errors.append(failure(error))
        finally:
            if channel is not None and process is not None and process.poll() is None:
                try:
                    channel.send({"kind": "cancel" if cancellation.requested or errors
                                  else "budget"}, deadline)
                except OSError as error:
                    errors.append(failure(error))
            # Leave time for the actual sudo wrapper to exit and be reaped.
            # The owner has its earlier absolute deadline, not a fresh grace.
            kill_at = deadline - min(0.1, remaining(deadline) / 4)
            while process is not None and process.poll() is None and remaining(kill_at):
                try:
                    if channel is not None:
                        receive()
                except Exception as error:
                    errors.append(failure(error))
                time.sleep(min(0.01, remaining(kill_at)))
            if process is not None and process.poll() is None:
                errors.append("installer wrapper required termination after owner deadline")
                try:
                    process.kill()
                except OSError as error:
                    if error.errno != errno.ESRCH:
                        errors.append(failure(error))
                try:
                    process.wait(timeout=remaining(deadline))
                except subprocess.TimeoutExpired:
                    errors.append("installer wrapper did not join before the attempt deadline")
            if channel is not None:
                try:
                    receive()
                except Exception as error:
                    errors.append(failure(error))
                channel.socket.close()
            listener.close()
    if result is None:
        result = {"primary": "installer owner produced no completion receipt",
                  "cleanup_errors": [], "joined": False, "cancelled": False,
                  "exit_code": None}
    expected = None
    if result.get("kind") == "result":
        expected = (130 if result["cancelled"] else
                    int(result["primary"] is not None or
                        bool(result["cleanup_errors"]) or not result["joined"]))
    result["cleanup_errors"].extend(dict.fromkeys(errors))
    wrapper_joined = process is not None and process.poll() is not None
    if wrapper_joined and expected is not None:
        if process.returncode != expected:
            result["cleanup_errors"].append(
                f"installer wrapper exited with status {process.returncode}; owner expected {expected}")
    result["joined"] = result["joined"] and wrapper_joined
    # Also join any sudo monitor/orphan adopted by the coordinator. This uses
    # the same ancestry/pidfd checks; permission failures remain fatal evidence.
    adopted_joined, adopted_errors = Children().finish(deadline, lambda: None)
    result["joined"] = result["joined"] and adopted_joined
    result["cleanup_errors"].extend(adopted_errors)
    if not remaining(deadline):
        result["cleanup_errors"].append("installer phase exceeded the shared attempt deadline")
    if cancellation.requested:
        result["cancelled"] = True
    print(f"Chromium owner uid={ready_uid} joined={result['joined']} "
          f"wrapper_joined={wrapper_joined} exit_code={result['exit_code']}", file=sys.stderr)
    return result


def successful(result):
    return (result["primary"] is None and not result["cleanup_errors"] and
            result["joined"] and not result["cancelled"] and result["exit_code"] == 0)


def describe(result):
    return "; ".join([result["primary"] or "installation failed", *result["cleanup_errors"]])


def duration(value):
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([smhd]?)", value)
    if match is None:
        raise ValueError("invalid ANTNEST_CHROMIUM_INSTALL_BUDGET")
    seconds = float(match[1]) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[match[2]]
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Chromium attempt budget must be finite and positive")
    return seconds


def install(playwright):
    cancellation = Cancellation()
    require_linux_owner()
    executable = str(Path(playwright).resolve())
    if not Path(executable).is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("Playwright is not installed or executable")
    node = shutil.which("node")
    sudo = shutil.which("sudo")
    dpkg = shutil.which("dpkg")
    if not node or not sudo or not dpkg:
        raise RuntimeError("Chromium installation requires Node, sudo and dpkg")
    node_directory = str(Path(node).resolve().parent)
    attempts_text = os.environ.get("ANTNEST_CHROMIUM_INSTALL_ATTEMPTS", "3")
    if not re.fullmatch(r"[1-9][0-9]*", attempts_text):
        raise ValueError("Chromium install attempts must be a positive integer")
    attempts = int(attempts_text)
    budget = duration(os.environ.get("ANTNEST_CHROMIUM_INSTALL_BUDGET", "8m"))
    last = None
    # Default bound: 3*8m + 2*30s = 25m, below the existing 28m CI step.
    for attempt in range(1, attempts + 1):
        if cancellation.requested:
            return 130
        deadline = time.monotonic() + budget
        dependency = phase([executable, "install-deps", "chromium"], True,
                           deadline, node_directory, sudo, cancellation)
        last = dependency
        if successful(dependency) and not cancellation.requested:
            last = phase([executable, "install", "--only-shell", "chromium"], False,
                         deadline, node_directory, sudo, cancellation)
            if successful(last) and not cancellation.requested:
                return 0
        print(f"Chromium attempt {attempt}: {describe(last)}", file=sys.stderr)
        if last["cleanup_errors"] or not last["joined"]:
            return 1
        if cancellation.requested or last["cancelled"]:
            return 130
        if last["exit_code"] is None:
            # Startup/capability failure did not establish an installer result.
            return 1
        if attempt == attempts:
            break
        if not successful(dependency):
            recovery = phase([dpkg, "--configure", "-a"], True,
                             time.monotonic() + 30, node_directory, sudo, cancellation)
            if not successful(recovery):
                print(f"Chromium installation failed: {describe(last)}; "
                      f"dpkg recovery failed: {describe(recovery)}", file=sys.stderr)
                return 130 if cancellation.requested or recovery["cancelled"] else 1
        if cancellation.requested:
            return 130
        print(f"::warning::Chromium install attempt {attempt} failed; retrying after owned cleanup",
              file=sys.stderr)
    print(f"Chromium install failed after {attempts} attempts: {describe(last)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 7 and sys.argv[1] == "--owner":
            absolute = float(sys.argv[3])
            if not math.isfinite(absolute):
                raise ValueError("invalid owner deadline")
            code = owner(sys.argv[2], absolute, sys.argv[4], sys.argv[5:])
        elif len(sys.argv) == 2:
            code = install(sys.argv[1])
        else:
            raise ValueError("usage: ci-install-chromium.sh <playwright binary>")
    except Exception as error:
        print(f"Chromium install failed: {failure(error)}", file=sys.stderr)
        code = 1
    sys.exit(code)
