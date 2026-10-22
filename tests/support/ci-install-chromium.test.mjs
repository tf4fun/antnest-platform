import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(
  new URL("./ci-install-chromium.sh", import.meta.url),
);

const capabilities = String.raw`
import ctypes, fcntl, json, os, signal, sys
assert sys.platform == "linux"
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
fd = os.pidfd_open(os.getpid())
signal.pidfd_send_signal(fd, 0)
os.close(fd)
print(json.dumps({"python": sys.executable}))
`;

const realSudoCapabilities = String.raw`
import ctypes, fcntl, grp, json, os, pwd, shutil, signal, subprocess, sys

def unavailable(reason):
    print(json.dumps({"skip": reason}))
    sys.exit(0)

if sys.platform != "linux" or os.geteuid() != 0:
    unavailable("real sudo acceptance requires a root Linux test supervisor")
try:
    account = pwd.getpwuid(1000)
    grp.getgrgid(1000)
except KeyError:
    unavailable("real sudo acceptance requires UID/GID 1000")
sudo = shutil.which("sudo")
if not sudo:
    unavailable("system sudo is unavailable; real mode never substitutes a shim")
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    unavailable("root subreaper capability is unavailable")
try:
    fd = os.pidfd_open(os.getpid())
    signal.pidfd_send_signal(fd, 0)
    os.close(fd)
except (AttributeError, OSError):
    unavailable("root pidfd capability is unavailable")
env = dict(os.environ)
env.update({"HOME": "/home/node", "USER": account.pw_name, "LOGNAME": account.pw_name})
try:
    probe = subprocess.run(
        [sudo, "-n", "--", sys.executable, "-c", "import os; print(os.geteuid())"],
        user=1000, group=1000, extra_groups=[], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=5)
except (OSError, subprocess.TimeoutExpired):
    unavailable("UID 1000 could not execute a bounded real sudo -n capability probe")
if probe.returncode != 0 or probe.stdout.strip() != "0":
    unavailable("UID 1000 has no verified noninteractive sudo-to-root permission")
print(json.dumps({"python": sys.executable, "sudo": os.path.realpath(sudo),
                  "uid": 1000, "gid": 1000, "home": "/home/node"}))
`;

// This outer fixture is itself a subreaper so an unfixed installer cannot
// leave the deliberately escaped holder for PID 1 to reap. It exercises only
// the public shell CLI. Same-UID mode uses sudo/dpkg shims. Real-sudo mode
// drops only the ordinary coordinator to UID 1000; the outer reaper stays root.
const processFixture = String.raw`
import ctypes
import fcntl
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import signal
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
EVENTS = BASE / "events.jsonl"
LOCK = BASE / "fixture-dpkg.lock"
RELEASE = BASE / "release-holder"
RELEASE_PARENT = BASE / "release-parent"


def events():
    if not EVENTS.exists():
        return []
    rows = []
    for line in EVENTS.read_text().splitlines(keepends=True):
        if line.endswith("\n"):
            rows.append(json.loads(line))
    return rows


def emit(event, **fields):
    value = {"event": event, "pid": os.getpid(), "euid": os.geteuid(),
             "monotonic": time.monotonic(), **fields}
    fd = os.open(EVENTS, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(value) + "\n").encode())
    finally:
        os.close(fd)


def info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
        return {"pid": pid, "state": fields[0], "parent": int(fields[1]),
                "group": int(fields[2]), "start": fields[19],
                "uid": Path(f"/proc/{pid}").stat().st_uid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def holder():
    ready = [row for row in events() if row["event"] == "holder_ready"]
    return ready[-1]["identity"] if ready else None


def holder_reaped():
    original = holder()
    if original is None:
        return True
    current = info(original["pid"])
    return current is None or current["start"] != original["start"]


def lock_free():
    with LOCK.open("a") as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


def next_attempt():
    with (BASE / "attempts").open("a+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        file.seek(0)
        number = int(file.read() or "0") + 1
        file.seek(0)
        file.truncate()
        file.write(str(number))
        file.flush()
        return number


def start_holder():
    bridge = os.fork()
    if bridge == 0:
        os.setsid()
        child = os.fork()
        if child:
            os._exit(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        with LOCK.open("a") as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            # Never keep the CLI's output pipes open merely by inheritance.
            with open(os.devnull, "r+b", buffering=0) as null:
                for fd in (0, 1, 2):
                    os.dup2(null.fileno(), fd)
            emit("holder_ready", identity=info(os.getpid()), ignores_term=True)
            while not RELEASE.exists():
                time.sleep(0.01)
            fcntl.flock(file, fcntl.LOCK_UN)
            emit("holder_released")
        os._exit(0)
    os.waitpid(bridge, 0)
    deadline = time.monotonic() + 5
    while holder() is None:
        if time.monotonic() >= deadline:
            raise RuntimeError("fixture holder did not acquire its lock")
        time.sleep(0.01)


def playwright(args):
    scenario = json.loads((BASE / "config.json").read_text())["scenario"]
    combined = bool(args and args[0] == "install" and "--with-deps" in args)
    dependency = combined or bool(args and args[0] == "install-deps")
    if not dependency:
        if not args or args[0] != "install" or "--only-shell" not in args:
            raise RuntimeError("unexpected fake Playwright command")
        emit("download", uid=os.geteuid(), home=os.environ.get("HOME"),
             lock_free=lock_free(), holder_reaped=holder_reaped())
        return 0
    number = next_attempt()
    emit("attempt", number=number, group=os.getpgrp(), lock_free=lock_free(),
         holder_reaped=holder_reaped(), combined=combined)
    if number > 1:
        return 0
    if scenario in ("recovery-error", "recovery-timeout"):
        emit("original_exit", code=1)
        return 1
    start_holder()
    if scenario == "dependency-timeout":
        emit("dependency_waiting_for_deadline", holder=holder(), lock_free=lock_free())
    if scenario in ("cancel", "coordinator-kill", "dependency-timeout"):
        while not RELEASE_PARENT.exists():
            time.sleep(0.01)
        if scenario == "dependency-timeout":
            emit("dependency_returned_after_release")
        return 0
    code = 0 if scenario == "success-orphan" else 1
    emit("original_exit", code=code)
    return code


def recovery(args):
    if args != ["--configure", "-a"]:
        raise RuntimeError("fixture dpkg only supports --configure -a")
    scenario = json.loads((BASE / "config.json").read_text())["scenario"]
    emit("recovery", lock_free=lock_free(), holder_reaped=holder_reaped())
    if scenario == "recovery-error":
        print("fixture dpkg recovery failed: 23", file=sys.stderr)
        return 23
    if scenario == "recovery-timeout":
        start_holder()
        emit("recovery_waiting_for_deadline", holder=holder(), lock_free=lock_free())
        while not RELEASE_PARENT.exists():
            time.sleep(0.01)
        emit("recovery_returned_after_release")
    return 0


def sudo(args):
    # Preserve the command boundary, including a future privileged owner, but
    # never elevate and never invoke the host's dpkg from these fixture cases.
    while args and args[0] in ("-n", "--"):
        args = args[1:]
    if not args:
        raise RuntimeError("empty fixture sudo command")
    if Path(args[0]).name == "dpkg":
        return recovery(args[1:])
    os.execvpe(args[0], args, os.environ)


def children(pid):
    try:
        return [int(value) for value in
                Path(f"/proc/{pid}/task/{pid}/children").read_text().split()]
    except (FileNotFoundError, ProcessLookupError):
        return []


def descendants():
    result = set()
    todo = children(os.getpid())
    while todo:
        pid = todo.pop()
        if pid not in result:
            result.add(pid)
            todo.extend(children(pid))
    return result


def signal_owned(signum):
    # pidfds prevent a recycled numeric PID from receiving a fixture signal.
    for pid in descendants():
        original = info(pid)
        if original is None:
            continue
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            current = info(pid)
            if (current and current["start"] == original["start"] and
                    pid in descendants()):
                try:
                    signal.pidfd_send_signal(fd, signum)
                except ProcessLookupError:
                    pass
        finally:
            os.close(fd)


def reap(cli, receipts):
    if cli is not None:
        cli.poll()
    for pid in children(os.getpid()):
        if cli is not None and pid == cli.pid:
            continue
        try:
            joined, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            continue
        if joined:
            receipts.append({"pid": joined, "status": status})


def cleanup(cli):
    receipts = []
    errors = []
    RELEASE.touch()
    RELEASE_PARENT.touch()
    # First allow the explicitly released real holder to finish. This is not
    # admission evidence: all behavioral snapshots were captured before here.
    for signum, seconds in ((None, 0.5), (signal.SIGTERM, 1), (signal.SIGKILL, 5)):
        deadline = time.monotonic() + seconds
        while True:
            reap(cli, receipts)
            if not children(os.getpid()):
                break
            if signum is not None:
                try:
                    signal_owned(signum)
                except OSError as error:
                    errors.append(type(error).__name__ + ":" + str(error.errno))
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        if not children(os.getpid()):
            break
    reap(cli, receipts)
    remaining = children(os.getpid())
    return {"joined": not remaining and holder_reaped(), "remaining": remaining,
            "holder_reaped": holder_reaped(), "receipts": receipts,
            "cli_joined": cli is None or cli.poll() is not None,
            "errors": errors}


def wait_without_fallback(cli, seconds):
    # Reap only. No marker releases or signals may manufacture this observation.
    receipts = []
    deadline = time.monotonic() + seconds
    while True:
        reap(cli, receipts)
        try:
            joined, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return {"joined": True, "echild": True, "remaining": [],
                    "receipts": receipts}
        if joined:
            receipts.append({"pid": joined, "status": status})
            continue
        if time.monotonic() >= deadline:
            return {"joined": False, "echild": False,
                    "remaining": sorted(descendants()), "receipts": receipts}
        time.sleep(0.01)


def harness(scenario, installer, mode="same-uid", sudo_binary=""):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "fixture subreaper setup failed")
    cancelled = False

    def cancel(signum, frame):
        nonlocal cancelled
        cancelled = True

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, cancel)
    if mode not in ("same-uid", "real-sudo"):
        raise RuntimeError("unknown fixture privilege mode")
    real_sudo = mode == "real-sudo"
    if real_sudo and (os.geteuid() != 0 or not Path(sudo_binary).is_file()):
        raise RuntimeError("real-sudo fixture requires its verified root supervisor and system sudo")
    (BASE / "config.json").write_text(json.dumps({"scenario": scenario, "mode": mode}))
    binary = BASE / "bin"
    binary.mkdir()
    roles = [("playwright", "playwright"), ("dpkg", "recovery")]
    if not real_sudo:
        roles.append(("sudo", "sudo"))
    for name, role in roles:
        script = binary / name
        script.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) +
                          " -B " + shlex.quote(str(Path(__file__).resolve())) +
                          " " + role + ' "$@"\n')
        script.chmod(0o700)
    # Create shared writable files before dropping the coordinator's UID. Root
    # dependency children append to the same files without changing ownership.
    for file in (EVENTS, LOCK, BASE / "attempts", BASE / "cli.log"):
        file.touch()
    if real_sudo:
        for directory, _, files in os.walk(BASE):
            os.chown(directory, 1000, 1000)
            for name in files:
                os.chown(Path(directory) / name, 1000, 1000)
    env = dict(os.environ)
    env.update({"PATH": str(binary) + os.pathsep + env.get("PATH", ""),
                "ANTNEST_CHROMIUM_INSTALL_ATTEMPTS": "2",
                "ANTNEST_CHROMIUM_INSTALL_BUDGET": "2s"})
    credentials = {}
    if real_sudo:
        account = pwd.getpwuid(1000)
        env.update({"HOME": "/home/node", "USER": account.pw_name, "LOGNAME": account.pw_name})
        actual_sudo = shutil.which("sudo", path=env["PATH"])
        if (actual_sudo is None or Path(actual_sudo).resolve() != Path(sudo_binary).resolve()
                or (binary / "sudo").exists()):
            raise RuntimeError("real sudo resolution changed or a fixture sudo shim exists")
        credentials = {"user": 1000, "group": 1000, "extra_groups": []}
    cli = None
    result = {"scenario": scenario, "mode": mode, "error": None,
              "supervisor_euid": os.geteuid(), "sudo_shim": (binary / "sudo").exists(),
              "system_sudo": sudo_binary if real_sudo else None,
              "expected_home": env.get("HOME")}
    try:
        with (BASE / "cli.log").open("wb") as log:
            started = time.monotonic()
            cli = subprocess.Popen(["sh", installer, str(binary / "playwright")],
                                   env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True,
                                   **credentials)
            result["cli_group"] = cli.pid
            result["coordinator"] = info(cli.pid)
            deadline = time.monotonic() + 40
            signalled = False
            while cli.poll() is None:
                if cancelled:
                    raise RuntimeError("fixture runner cancelled")
                if scenario == "cancel" and holder() and not signalled:
                    emit("external_cancel")
                    cli.send_signal(signal.SIGTERM)
                    signalled = True
                if scenario == "coordinator-kill" and holder() and not signalled:
                    emit("external_kill", coordinator=info(cli.pid))
                    # Do not signal its group, sudo, the root owner or holder.
                    cli.kill()
                    signalled = True
                if time.monotonic() >= deadline:
                    raise TimeoutError("installer did not settle within fixture bound")
                time.sleep(0.01)
            result["cli_exit"] = cli.returncode
            result["holder"] = holder()
            result["holder_reaped_at_cli_exit"] = holder_reaped()
            if scenario == "coordinator-kill":
                result["natural_join"] = wait_without_fallback(cli, 10)
            result["holder_reaped_at_snapshot"] = holder_reaped()
            result["outer_children_at_snapshot"] = children(os.getpid())
            result["release_files_at_snapshot"] = {
                "holder": RELEASE.exists(), "parent": RELEASE_PARENT.exists()}
            result["snapshot_monotonic"] = time.monotonic()
            result["elapsed_seconds"] = result["snapshot_monotonic"] - started
            result["observed"] = events()
            result["cancel_sent"] = signalled and scenario == "cancel"
            result["kill_sent"] = signalled and scenario == "coordinator-kill"
            result["log_before_cleanup"] = (BASE / "cli.log").read_text()[-4096:]
    except BaseException as error:
        result["error"] = type(error).__name__ + ": " + str(error)
    finally:
        result["cleanup"] = cleanup(cli)
        result["all_events"] = events()
        result["log"] = (BASE / "cli.log").read_text()[-4096:] if cli else ""
    print(json.dumps(result), flush=True)


role, *args = sys.argv[1:]
if role == "harness":
    harness(*args)
elif role == "playwright":
    sys.exit(playwright(args))
elif role == "recovery":
    sys.exit(recovery(args))
elif role == "sudo":
    sys.exit(sudo(args))
else:
    raise RuntimeError("unknown fixture role")
`;

function pythonFor(t, realSudo = false) {
  if (process.platform !== "linux") {
    t.skip(
      "Linux fork/session/flock containment is not verified on this platform",
    );
    return;
  }
  if (realSudo && process.getuid?.() !== 0) {
    t.skip(
      "Real sudo cross-UID acceptance requires the Node/outer supervisor to run as root",
    );
    return;
  }
  const result = spawnSync(
    "python3",
    ["-B", "-c", realSudo ? realSudoCapabilities : capabilities],
    {
      encoding: "utf8",
      timeout: realSudo ? 10_000 : 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    t.skip(
      realSudo
        ? "Real sudo Python/subreaper/pidfd capability unavailable; cross-UID containment unverified"
        : "Python3/flock/subreaper/pidfd capability unavailable; containment unverified",
    );
    return;
  }
  const capability = JSON.parse(result.stdout);
  if (capability.skip) {
    t.skip(capability.skip);
    return;
  }
  t.diagnostic(
    realSudo
      ? "Real system sudo -n: ordinary coordinator UID 1000, root dependency/recovery owners, root outer subreaper"
      : "sudo/dpkg are temporary same-UID shims; real sudo/root containment is unverified by this case",
  );
  return capability;
}

async function runFixture(t, scenario, { realSudo = false } = {}) {
  const capability = pythonFor(t, realSudo);
  if (!capability) return;
  const { python } = capability;
  const directory = mkdtempSync(join(tmpdir(), "antnest-chromium-owner-"));
  const program = join(directory, "fixture.py");
  writeFileSync(program, processFixture, { mode: 0o700 });
  let child, closed;
  const forward = () => child?.kill("SIGTERM");
  try {
    child = spawn(
      python,
      [
        "-B",
        program,
        "harness",
        scenario,
        installer,
        realSudo ? "real-sudo" : "same-uid",
        ...(realSudo ? [capability.sudo] : []),
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forward);
    const outcome = await closed;
    assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.cleanup.joined, true, JSON.stringify(report.cleanup));
    assert.equal(report.cleanup.cli_joined, true);
    assert.equal(report.cleanup.holder_reaped, true);
    assert.deepEqual(report.cleanup.remaining, []);
    assert.deepEqual(report.cleanup.errors, []);
    assert.equal(report.error, null, report.error ?? report.log);
    return report;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, forward);
    rmSync(directory, { recursive: true, force: true });
  }
}

function escapedHolder(report) {
  assert(
    report.holder,
    "the actual forked holder acquired its temporary flock",
  );
  const first = report.observed.find((row) => row.event === "attempt");
  assert.notEqual(report.holder.group, first.group);
  assert.notEqual(report.holder.group, report.cli_group);
  assert.equal(
    report.observed.find((row) => row.event === "holder_ready").ignores_term,
    true,
  );
}

test(
  "Chromium retry joins the failed attempt's escaped lock holder before recovery and retry",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "failed-orphan");
    if (!report) return;
    escapedHolder(report);
    const recoveries = report.observed.filter(
      (row) => row.event === "recovery",
    );
    const attempts = report.observed.filter((row) => row.event === "attempt");
    assert.equal(recoveries.length, 1, report.log);
    assert.equal(
      recoveries[0].lock_free,
      true,
      "recovery overlapped the original flock holder",
    );
    assert.equal(
      recoveries[0].holder_reaped,
      true,
      "recovery started before actual holder join",
    );
    assert.deepEqual(
      attempts.map((row) => row.number),
      [1, 2],
    );
    assert.equal(attempts[1].lock_free, true);
    assert.equal(attempts[1].holder_reaped, true);
    assert(
      report.observed.indexOf(recoveries[0]) <
        report.observed.indexOf(attempts[1]),
    );
    assert.equal(report.holder_reaped_at_cli_exit, true);
    assert.equal(report.cli_exit, 0, report.log);
  },
);

test(
  "Chromium successful installation still joins an escaped descendant before returning",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "success-orphan");
    if (!report) return;
    escapedHolder(report);
    assert.equal(report.cli_exit, 0, report.log);
    assert.equal(
      report.holder_reaped_at_cli_exit,
      true,
      "successful parent exit left its real holder alive",
    );
    assert.equal(
      report.all_events.filter((row) => row.event === "attempt").length,
      1,
    );
    assert.equal(
      report.all_events.filter((row) => row.event === "recovery").length,
      0,
    );
  },
);

test(
  "Chromium external cancellation joins the escaped holder without recovery or another attempt",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "cancel");
    if (!report) return;
    escapedHolder(report);
    assert.equal(report.cancel_sent, true);
    assert.notEqual(report.cli_exit, 0, report.log);
    assert.equal(
      report.holder_reaped_at_cli_exit,
      true,
      "cancel returned before actual holder join",
    );
    assert.equal(
      report.all_events.filter((row) => row.event === "attempt").length,
      1,
    );
    assert.equal(
      report.all_events.filter((row) => row.event === "recovery").length,
      0,
    );
  },
);

test(
  "Chromium dpkg recovery failure remains fatal and prevents the next attempt",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "recovery-error");
    if (!report) return;
    assert.equal(
      report.observed.filter((row) => row.event === "recovery").length,
      1,
    );
    assert.deepEqual(
      {
        installationSucceeded: report.cli_exit === 0,
        attempts: report.observed.filter((row) => row.event === "attempt")
          .length,
      },
      { installationSucceeded: false, attempts: 1 },
      "a failed recovery was swallowed and installation retried",
    );
    assert.match(report.log, /fixture dpkg recovery failed: 23/u);
  },
);

function realSudoStages(report, downloads, hasHolder = true) {
  assert.equal(report.mode, "real-sudo");
  assert.equal(report.supervisor_euid, 0);
  assert.equal(
    report.coordinator.uid,
    1000,
    "the ordinary installer coordinator must actually run unprivileged",
  );
  assert.equal(
    report.sudo_shim,
    false,
    "real sudo mode must never create or use the fixture sudo shim",
  );
  assert.equal(typeof report.system_sudo, "string");
  assert.equal(report.expected_home, "/home/node");
  const dependencies = report.observed.filter((row) => row.event === "attempt");
  assert.ok(
    dependencies.length > 0,
    "a real sudo dependency child must actually execute",
  );
  for (const row of dependencies) assert.equal(row.euid, 0);
  for (const row of report.observed.filter((row) => row.event === "recovery"))
    assert.equal(row.euid, 0);
  const browserDownloads = report.observed.filter(
    (row) => row.event === "download",
  );
  assert.equal(browserDownloads.length, downloads);
  for (const row of browserDownloads) {
    assert.equal(row.euid, 1000);
    assert.equal(row.uid, 1000);
    assert.equal(
      row.home,
      "/home/node",
      "browser download must retain the invoking user's original HOME",
    );
    assert.equal(row.lock_free, true);
    assert.equal(row.holder_reaped, true);
  }
  if (hasHolder) {
    escapedHolder(report);
    assert.equal(report.holder.uid, 0);
    assert.equal(
      report.observed.find((row) => row.event === "holder_ready").euid,
      0,
    );
  }
  assert.deepEqual(report.release_files_at_snapshot, {
    holder: false,
    parent: false,
  });
  assert.deepEqual(
    report.outer_children_at_snapshot,
    [],
    "no privileged installer descendant may remain for outer fallback cleanup",
  );
  assert.equal(
    report.observed.some((row) => row.event === "holder_released"),
    false,
    "outer fallback release cannot count as installer containment evidence",
  );
  assert.match(report.log_before_cleanup, /Chromium owner uid=0 joined=True/u);
}

for (const scenario of [
  "failed-orphan",
  "success-orphan",
  "cancel",
  "recovery-error",
]) {
  test(
    `Chromium real sudo cross-UID containment: ${scenario}`,
    { timeout: 90000 },
    async (t) => {
      const report = await runFixture(t, scenario, { realSudo: true });
      if (!report) return;
      realSudoStages(
        report,
        scenario === "failed-orphan" || scenario === "success-orphan" ? 1 : 0,
        scenario !== "recovery-error",
      );
      const attempts = report.observed.filter((row) => row.event === "attempt");
      const recoveries = report.observed.filter(
        (row) => row.event === "recovery",
      );
      assert.equal(
        report.holder_reaped_at_cli_exit,
        true,
        "ordinary coordinator returned before its privileged descendants were actually reaped",
      );
      if (scenario === "failed-orphan") {
        assert.equal(report.cli_exit, 0, report.log_before_cleanup);
        assert.deepEqual(
          attempts.map((row) => row.number),
          [1, 2],
        );
        assert.equal(recoveries.length, 1);
        assert.equal(recoveries[0].lock_free, true);
        assert.equal(recoveries[0].holder_reaped, true);
        assert.equal(attempts[1].lock_free, true);
        assert.equal(attempts[1].holder_reaped, true);
        assert.ok(
          report.observed.indexOf(recoveries[0]) <
            report.observed.indexOf(attempts[1]),
        );
      } else if (scenario === "success-orphan") {
        assert.equal(report.cli_exit, 0, report.log_before_cleanup);
        assert.equal(attempts.length, 1);
        assert.equal(recoveries.length, 0);
      } else if (scenario === "cancel") {
        assert.equal(report.cancel_sent, true);
        assert.notEqual(report.cli_exit, 0, report.log_before_cleanup);
        assert.equal(attempts.length, 1);
        assert.equal(recoveries.length, 0);
      } else {
        assert.notEqual(report.cli_exit, 0, report.log_before_cleanup);
        assert.equal(attempts.length, 1);
        assert.equal(recoveries.length, 1);
        assert.match(
          report.log_before_cleanup,
          /fixture dpkg recovery failed: 23/u,
        );
        assert.match(
          report.log_before_cleanup,
          /installation command exited with status 1/u,
        );
      }
    },
  );
}

test(
  "Chromium real sudo owner joins root descendants after the ordinary coordinator is SIGKILLed",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "coordinator-kill", { realSudo: true });
    if (!report) return;
    realSudoStages(report, 0);
    assert.equal(report.kill_sent, true);
    assert.equal(report.cancel_sent, false);
    assert.equal(
      report.cli_exit,
      -9,
      "only the ordinary coordinator receives SIGKILL",
    );
    const kill = report.observed.filter((row) => row.event === "external_kill");
    assert.equal(kill.length, 1);
    assert.equal(kill[0].coordinator.uid, 1000);
    assert.equal(kill[0].coordinator.pid, report.coordinator.pid);
    assert.equal(kill[0].coordinator.start, report.coordinator.start);
    assert.equal(
      report.natural_join.joined,
      true,
      "root owner cleanup must complete before outer fallback begins",
    );
    assert.equal(
      report.natural_join.echild,
      true,
      "the outer supervisor must actually reap every adopted child",
    );
    assert.deepEqual(report.natural_join.remaining, []);
    assert.deepEqual(report.outer_children_at_snapshot, []);
    assert.equal(report.holder_reaped_at_snapshot, true);
    assert.equal(
      report.observed.filter((row) => row.event === "attempt").length,
      1,
    );
    assert.equal(
      report.observed.filter((row) => row.event === "recovery").length,
      0,
    );
    assert.equal(
      report.observed.filter((row) => row.event === "download").length,
      0,
    );
  },
);

test(
  "Chromium real sudo attempt deadline joins a held root dependency before recovery and successful retry",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "dependency-timeout", {
      realSudo: true,
    });
    if (!report) return;
    realSudoStages(report, 1);
    const attempts = report.observed.filter((row) => row.event === "attempt");
    const recoveries = report.observed.filter(
      (row) => row.event === "recovery",
    );
    const waiting = report.observed.filter(
      (row) => row.event === "dependency_waiting_for_deadline",
    );
    const downloads = report.observed.filter((row) => row.event === "download");
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].euid, 0);
    assert.equal(waiting[0].lock_free, false);
    assert.deepEqual(waiting[0].holder, report.holder);
    assert.equal(report.cancel_sent, false);
    assert.equal(report.kill_sent, false);
    assert.equal(
      report.observed.some(
        (row) =>
          row.event === "external_cancel" || row.event === "external_kill",
      ),
      false,
    );
    assert.equal(
      report.observed.some(
        (row) =>
          row.event === "original_exit" ||
          row.event === "dependency_returned_after_release",
      ),
      false,
      "the held dependency must not finish voluntarily or through an outer release",
    );
    assert.deepEqual(
      attempts.map((row) => row.number),
      [1, 2],
    );
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].lock_free, true);
    assert.equal(recoveries[0].holder_reaped, true);
    assert.equal(attempts[1].lock_free, true);
    assert.equal(attempts[1].holder_reaped, true);
    assert.ok(attempts[0].monotonic <= waiting[0].monotonic);
    assert.ok(waiting[0].monotonic < recoveries[0].monotonic);
    assert.ok(recoveries[0].monotonic < attempts[1].monotonic);
    assert.ok(attempts[1].monotonic < downloads[0].monotonic);
    assert.match(
      report.log_before_cleanup,
      /Chromium attempt 1: installation command exceeded its attempt deadline/u,
    );
    assert.equal(report.holder_reaped_at_cli_exit, true);
    assert.equal(report.holder_reaped_at_snapshot, true);
    assert.equal(report.cli_exit, 0, report.log_before_cleanup);
    assert.ok(report.elapsed_seconds < 40);
  },
);

test(
  "Chromium real sudo recovery deadline joins its own held root descendants and preserves both failure reasons",
  { timeout: 90000 },
  async (t) => {
    const report = await runFixture(t, "recovery-timeout", { realSudo: true });
    if (!report) return;
    realSudoStages(report, 0);
    const attempts = report.observed.filter((row) => row.event === "attempt");
    const exits = report.observed.filter(
      (row) => row.event === "original_exit",
    );
    const recoveries = report.observed.filter(
      (row) => row.event === "recovery",
    );
    const waiting = report.observed.filter(
      (row) => row.event === "recovery_waiting_for_deadline",
    );
    assert.deepEqual(
      attempts.map((row) => row.number),
      [1],
    );
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, 1);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].lock_free, true);
    assert.equal(recoveries[0].holder_reaped, true);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].euid, 0);
    assert.equal(waiting[0].lock_free, false);
    assert.deepEqual(waiting[0].holder, report.holder);
    assert.ok(exits[0].monotonic < recoveries[0].monotonic);
    assert.ok(recoveries[0].monotonic < waiting[0].monotonic);
    // Recovery uses the production 30-second phase budget, which reserves time
    // for cleanup. It must not inherit the fixture's two-second attempt budget.
    assert.ok(
      report.snapshot_monotonic - waiting[0].monotonic >= 5,
      "the actual held recovery must outlive the ordinary two-second attempt budget",
    );
    assert.ok(
      report.elapsed_seconds < 40,
      "the unchanged production recovery deadline must fit the outer bound",
    );
    assert.equal(report.cancel_sent, false);
    assert.equal(report.kill_sent, false);
    assert.equal(
      report.observed.some(
        (row) =>
          row.event === "external_cancel" || row.event === "external_kill",
      ),
      false,
    );
    assert.equal(
      report.observed.some(
        (row) => row.event === "recovery_returned_after_release",
      ),
      false,
    );
    assert.match(
      report.log_before_cleanup,
      /Chromium installation failed: installation command exited with status 1; dpkg recovery failed: installation command exceeded its attempt deadline/u,
    );
    assert.notEqual(report.cli_exit, 0, report.log_before_cleanup);
    assert.equal(report.holder_reaped_at_cli_exit, true);
    assert.equal(report.holder_reaped_at_snapshot, true);
    assert.equal(
      report.observed.filter((row) => row.event === "download").length,
      0,
    );
  },
);
