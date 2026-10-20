import assert from "node:assert/strict";

function processIdentity(value) {
  assert(value && Object.keys(value).sort().join(",") === "pid,start_ticks");
  assert(Number.isSafeInteger(value.pid) && value.pid > 1);
  assert.match(value.start_ticks, /^[1-9]\d*$/u);
  return value;
}

// This is the entire command vocabulary. No client-supplied shell text or path
// crosses IPC. A failed Docker command is never interpreted as probe false.
export function progressProbeCommand(action, phase, process) {
  assert.match(phase, /^v[12]-(bash|managed)-(success|failure|cancel)$/u);
  assert(["release", "alive", "stopped"].includes(action));
  assert.equal(phase.endsWith("-cancel"), action !== "release");
  const prefix = `test "$(id -u)" = 1000 || exit 2\n`;
  const path = `/workspace/${phase}`;
  if (action === "release")
    return prefix + `touch ${path}-release || exit 2\nprintf 'released\\n'`;
  if (phase.includes("-managed-")) {
    assert(action !== "stopped" || process === null);
    return (
      prefix +
      `test -s ${path}-started || exit 2\n` +
      (action === "alive"
        ? `test ! -e ${path}-canceled || exit 2\nprintf 'alive managed\\n'`
        : `if test -s ${path}-canceled; then printf 'stopped managed\\n'; elif test ! -e ${path}-canceled; then printf 'pending managed\\n'; else exit 2; fi`)
    );
  }
  if (action === "stopped") processIdentity(process);
  return (
    prefix +
    `pid=$(cat ${path}-pid) || exit 2
case "$pid" in ''|*[!0-9]*) exit 2;; esac
[ "$pid" -gt 1 ] || exit 2
${action === "stopped" ? `[ "$pid" = ${process.pid} ] || exit 2` : ""}
read_identity() {
  if [ ! -d /proc/"$pid" ]; then state=gone; return; fi
  if ! stat=$(cat /proc/"$pid"/stat); then
    if [ ! -d /proc/"$pid" ]; then state=gone; return; fi
    exit 2
  fi
  tail=\${stat##*) }
  [ "$tail" != "$stat" ] || exit 2
  set -- $tail
  [ "$#" -ge 20 ] || exit 2
  state=$1
  ticks=\${20}
  case "$ticks" in ''|*[!0-9]*) exit 2;; esac
  [ "$ticks" -gt 0 ] || exit 2
  if ! kill -0 "$pid" 2>/dev/null; then
    if [ ! -d /proc/"$pid" ]; then state=gone; return; fi
    exit 2
  fi
}
read_identity
` +
    (action === "alive"
      ? `[ "$state" != gone ] && [ "$state" != Z ] || exit 2\nprintf 'alive %s %s\\n' "$pid" "$ticks"`
      : `if [ "$state" = gone ]; then printf 'stopped ${process.pid} ${process.start_ticks}\\n'; else
  [ "$ticks" = ${process.start_ticks} ] || exit 2
  printf 'pending ${process.pid} ${process.start_ticks}\\n'
fi`)
  );
}

export function progressProbeResult(action, phase, value, original) {
  if (action === "bind") {
    assert.equal(value, null);
    return null;
  }
  let result = value;
  if (typeof value === "string") {
    if (action === "release") {
      assert.equal(value, "released");
      result = { released: true };
    } else {
      const managed = phase.includes("-managed-");
      const match = value.match(
        managed
          ? /^(alive|pending|stopped) managed$/u
          : /^(alive|pending|stopped) ([1-9]\d*) ([1-9]\d*)$/u,
      );
      assert(match, "invalid Progress probe output");
      assert(action === "alive" ? match[1] === "alive" : match[1] !== "alive");
      const process = managed
        ? null
        : { pid: Number(match[2]), start_ticks: match[3] };
      result =
        action === "alive"
          ? { alive: true, process }
          : { stopped: match[1] === "stopped", process };
    }
  }
  assert(result && typeof result === "object");
  assert.deepEqual(
    Object.keys(result).sort(),
    action === "release"
      ? ["released"]
      : [action === "alive" ? "alive" : "stopped", "process"].sort(),
  );
  if (action === "release") assert.equal(result.released, true);
  else {
    if (action === "alive") assert.equal(result.alive, true);
    else assert.equal(typeof result.stopped, "boolean");
    if (phase.includes("-managed-")) assert.equal(result.process, null);
    else processIdentity(result.process);
    if (original !== undefined)
      assert.deepEqual(
        result.process,
        original,
        "original alive PID identity changed",
      );
  }
  return result;
}
