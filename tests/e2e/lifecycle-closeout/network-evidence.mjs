import assert from "node:assert/strict";
import { isIPv4 } from "node:net";

export function privateIPv4(ip) {
  assert(isIPv4(ip), "invalid fixture IPv4");
  const [a, b] = ip.split(".").map(Number);
  assert(
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
  );
  return ip;
}

export function probeCommand(input) {
  assert(
    ["allowed", "held-a", "held-b", "denied", "restored", "private"].includes(
      input.phase,
    ),
  );
  assert.match(input.nonce, /^[a-z0-9-]{6,64}$/);
  if (input.phase === "private") privateIPv4(input.target);
  input = {
    phase: input.phase,
    nonce: input.nonce,
    ...(input.phase === "private" ? { target: input.target } : {}),
  };
  return `python3 - <<'PY'
import socket, json, os, time, pathlib
config = json.loads('${JSON.stringify(input)}')
os.environ['RES_OPTIONS'] = 'attempts:1 timeout:1 use-vc'
report = {'uid': os.getuid(), 'gid': os.getgid()}
start = time.monotonic()
try:
    addresses = sorted(set(item[4][0] for item in socket.getaddrinfo('network-target', 8080, socket.AF_INET, socket.SOCK_STREAM)))
    report['dns'] = {'addresses': addresses}
except socket.gaierror as error:
    report['dns'] = {'error': error.errno}
report['dns']['elapsed_ms'] = (time.monotonic()-start)*1000
if config['phase'] == 'denied':
    resolver = next(line.split()[1] for line in pathlib.Path('/etc/resolv.conf').read_text().splitlines() if line.startswith('nameserver '))
    started = time.monotonic()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as dns_connection:
        dns_connection.settimeout(2)
        try:
            dns_connection.connect((resolver, 53))
            report['dns_tcp'] = {'ok': True}
        except OSError as error:
            report['dns_tcp'] = {'ok': False, 'errno': error.errno, 'timed_out': isinstance(error, TimeoutError)}
    report['dns_tcp']['elapsed_ms'] = (time.monotonic()-started)*1000
connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
connection.settimeout(2)
def receive():
    data = bytearray()
    while len(data) < 4096:
        chunk = connection.recv(1)
        if not chunk:
            raise ConnectionResetError(104, 'unexpected EOF')
        if chunk == b'\\n':
            return json.loads(data)
        data.extend(chunk)
    raise ValueError('response too large')
def exchange(phase, connect=False):
    started = time.monotonic()
    try:
        if connect:
            connection.connect((config.get('target', '1.1.1.1'), 8080 if config['phase']=='private' else 18080))
        connection.sendall((json.dumps({'phase': phase, 'nonce': config['nonce']})+'\\n').encode())
        result = {'ok': True, 'body': receive()}
    except OSError as error:
        result = {'ok': False, 'errno': error.errno, 'timed_out': isinstance(error, TimeoutError)}
    result['elapsed_ms'] = (time.monotonic()-started)*1000
    return result
report['tcp'] = exchange(config['phase'], True)
if config['phase'].startswith('held-') and report['tcp']['ok']:
    source_port = connection.getsockname()[1]
    pathlib.Path('/workspace/.c3-network-'+config['nonce']).write_text('held')
    deadline = time.monotonic()+40
    while not pathlib.Path('/workspace/.c3-network-release-'+config['nonce']).exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('coordinator did not release probe')
        time.sleep(0.05)
    connection.settimeout(1)
    try:
        report['push'] = {'ok': True, 'body': receive()}
    except TimeoutError:
        report['push'] = {'ok': False, 'timed_out': True}
    report['same_socket'] = connection.getsockname()[1] == source_port
    report['continued'] = exchange(config['phase']+'-next')
    if config['phase'] == 'held-b':
        report['dns_after'] = sorted(set(item[4][0] for item in socket.getaddrinfo('network-target', 8080, socket.AF_INET, socket.SOCK_STREAM)))
connection.close()
print(json.dumps(report))
PY`;
}

function allowed(result, phase, nonce) {
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { phase, nonce });
}
function denied(result) {
  assert.equal(result.ok, false);
  assert(
    [32, 104, 111].includes(result.errno),
    "not a connection rejection/reset",
  );
  assert.notEqual(
    result.timed_out,
    true,
    "timeout is not policy-denial evidence",
  );
  assert(
    result.elapsed_ms >= 0 && result.elapsed_ms < 1500,
    "network rejection too slow",
  );
}
export function inspectProbe(report, input, targetIP) {
  assert.equal(report.uid, 1000);
  assert.equal(report.gid, 1000);
  if (input.phase === "denied") {
    assert([-2, -3].includes(report.dns.error));
    assert(report.dns.elapsed_ms < 2500);
    denied(report.dns_tcp);
  } else assert.deepEqual(report.dns.addresses, [targetIP]);
  if (["denied", "private"].includes(input.phase)) denied(report.tcp);
  else allowed(report.tcp, input.phase, input.nonce);
  if (input.phase.startsWith("held-")) {
    assert.equal(report.same_socket, true);
    if (input.phase === "held-a") {
      assert.deepEqual(report.push, { ok: false, timed_out: true });
      denied(report.continued);
    } else {
      assert.deepEqual(report.dns_after, [targetIP]);
      assert.deepEqual(report.push, { ok: true, body: { push: input.nonce } });
      allowed(report.continued, "held-b-next", input.nonce);
    }
  }
  return {
    phase: input.phase,
    tcp: report.tcp.ok ? "allowed" : "rejected",
    tcp_elapsed_ms: Math.round(report.tcp.elapsed_ms),
    dns: input.phase === "denied" ? "rejected" : "resolved",
  };
}
export function inspectTargetHistory(state, expected, peer) {
  assert.deepEqual(state.errors, []);
  assert.deepEqual(
    state.requests,
    expected.map((request) => ({ ...request, peer })),
  );
}
// Summarizes why a held probe never wrote its barrier without echoing the
// model payloads: which model stages ran and how the probe's TCP connect ended.
export function barrierDiagnostic(model, phase) {
  const calls = model.requests.filter((r) => r.phase === phase);
  const tcp = calls.find((c) => c.stage === "reply")?.report?.tcp;
  const stages = calls.map((c) => c.stage).join(",") || "none";
  return [
    `stages=${stages}`,
    `model_errors=${model.errors.length}`,
    ...(tcp
      ? [
          `tcp_ok=${tcp.ok}`,
          `errno=${tcp.errno ?? "-"}`,
          `timed_out=${tcp.timed_out ?? false}`,
        ]
      : []),
  ].join(" ");
}
