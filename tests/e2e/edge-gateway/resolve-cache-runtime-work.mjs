import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { runtimePhysical } from "../lifecycle-closeout/recovery-support.mjs";
import { prepareRuntimeStatus } from "../lifecycle-closeout/runtime-status.mjs";
import { processStat, readProcesses } from "../workspace-closeout/process.mjs";
import { cacheRuntimeFiles } from "../workspace-closeout/cache-runtime-work.mjs";
import { joinedRuntimeExec } from "./resolve-cache-runtime-exec.mjs";

export async function pollOutageObservation(
  check,
  label,
  signal,
  timeoutMS = 15000,
  intervalMS = 25,
) {
  const deadline = performance.now() + timeoutMS;
  const bounded = AbortSignal.any(
    [signal, AbortSignal.timeout(Math.ceil(timeoutMS))].filter(Boolean),
  );
  for (;;) {
    bounded.throwIfAborted();
    const value = await check(bounded);
    bounded.throwIfAborted();
    assert(performance.now() < deadline, `${label}: timed out`);
    if (value) return value;
    await delay(intervalMS, undefined, { signal: bounded });
  }
}

export async function createCacheRuntimeWork({
  docker,
  config,
  agent,
  principal,
  readerPrincipal,
  signal,
  execRuntime = joinedRuntimeExec,
}) {
  assert(
    typeof principal.organization_id === "string" &&
      principal.organization_id.length,
  );
  assert.equal(readerPrincipal.organization_id, principal.organization_id);
  assert.equal(agent.owner_user_id, principal.user_id);
  assert(agent.executable_execution_revision);
  assert(agent.runtime?.runtime_revision);
  let runtimeID;
  const evidence = {
    organization_id: principal.organization_id,
    observations: [],
    exec_failures: [],
    exec_failures_dropped: 0,
  };
  const operation = (
    { signal: requestSignal = signal, timeoutMS = 15000 } = {},
    stage = "process",
  ) => {
    assert(Number.isFinite(timeoutMS) && timeoutMS > 0);
    const deadline = performance.now() + timeoutMS;
    const bounded = AbortSignal.any(
      [signal, requestSignal, AbortSignal.timeout(Math.ceil(timeoutMS))].filter(
        Boolean,
      ),
    );
    const remaining = () => {
      bounded.throwIfAborted();
      const value = deadline - performance.now();
      assert(value > 0, "Runtime observation timed out");
      return value;
    };
    return {
      signal: bounded,
      remaining,
      docker: async (args, long, options = {}) => {
        const call = {
          ...options,
          signal: AbortSignal.any([bounded, options.signal].filter(Boolean)),
          timeoutMS: Math.min(remaining(), options.timeoutMS ?? Infinity),
        };
        let result;
        if (args[0] === "exec" && args.at(-4) === runtimeID) {
          try {
            result = await execRuntime({
              args,
              environment: config.env,
              ...call,
            });
          } catch (error) {
            // Capture before the status reader wraps a rejected credential.
            // Retain the original rejection and join behavior, and bound
            // diagnostics even during initial credential selection.
            if (evidence.exec_failures.length < 16)
              evidence.exec_failures.push({
                stage:
                  args[1] === "-e"
                    ? stage === "initial"
                      ? "status-selection"
                      : "status"
                    : stage,
                name: error.name,
                message: error.message,
                remote_cleanup_pending: error.remoteCleanupPending ?? null,
                receipt: error.runtimeExec ?? null,
              });
            else evidence.exec_failures_dropped++;
            throw error;
          }
        } else result = await docker(args, long, call);
        remaining();
        return result;
      },
    };
  };
  const physical = async (bounded) => {
    const row = await runtimePhysical(bounded.docker, config, agent.agent_id);
    assert(
      row.id && row.running && row.healthy,
      "actual ready Runtime missing",
    );
    return {
      id: row.id,
      image: config.resolvedImage,
      project: config.project,
      agent_id: row.agent_id,
      started_at: row.started_at,
      restarts: row.restarts,
      running: row.running,
      health: row.healthy ? "healthy" : "unhealthy",
      generation: row.generation,
      digest: row.digest,
      volume: row.volume,
    };
  };
  const initial = operation(undefined, "initial");
  const container = await physical(initial);
  runtimeID = container.id;
  const statusReader = await prepareRuntimeStatus(
    initial.docker,
    config.project,
    container.id,
    {
      signal: initial.signal,
      timeoutMS: initial.remaining(),
    },
  );
  const status = statusReader.status;
  assert.equal(status.status, "ready");
  assert(typeof status.execution_id === "string" && status.execution_id.length);
  Object.assign(evidence, {
    container,
    runtime_revision: agent.runtime.runtime_revision,
    runtime_execution_id: status.execution_id,
    execution_revision: agent.executable_execution_revision,
  });
  const exec = (bounded, command) =>
    bounded.docker([
      "exec",
      "--user",
      "1000:1000",
      container.id,
      "sh",
      "-c",
      command,
    ]);
  // One captured command reads only synthetic phase files and /proc metadata.
  // Base64 keeps process names/newlines separate from the four evidence fields.
  const command = [
    `runtime_work_pid=$(cat ${cacheRuntimeFiles.started} 2>/dev/null || true)`,
    'case "$runtime_work_pid" in ""|*[!0-9]*) runtime_work_pid=;; esac',
    'printf "pid:%s\\neffects:" "$runtime_work_pid"',
    `base64 -w 0 ${cacheRuntimeFiles.effects} 2>/dev/null || true`,
    'printf "\\nstat:"',
    'if [ -n "$runtime_work_pid" ] && [ -f "/proc/$runtime_work_pid/stat" ]; then base64 -w 0 "/proc/$runtime_work_pid/stat"; fi',
    'printf "\\nprocesses:"',
    `{ ${readProcesses}; } | base64 -w 0`,
  ].join("\n");
  return {
    evidence,
    async assertFresh(options) {
      await exec(
        operation(options, "freshness"),
        Object.values(cacheRuntimeFiles)
          .map((path) => `test ! -e ${path}`)
          .join(" && "),
      );
    },
    async observe(options) {
      const bounded = operation(options);
      const started_at = performance.now();
      // Discovery, live status and /proc read the same bound Runtime
      // independently. Join every read before exposing errors or stamping the
      // complete sample; slow discovery must not postpone the process read.
      const readers = [
        async () => {
          const current = await physical(bounded);
          assert.deepEqual(
            current,
            container,
            "Runtime replaced during held work",
          );
          return current;
        },
        () =>
          statusReader.read(bounded.docker, {
            signal: bounded.signal,
            timeoutMS: bounded.remaining(),
          }),
        () => exec(bounded, command),
      ];
      const results = await Promise.allSettled(
        readers.map((read) => Promise.resolve().then(read)),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Runtime observation failed");
      bounded.remaining();
      const [observedContainer, observedStatus, raw] = results.map(
        (result) => result.value,
      );
      const fields = raw.split("\n");
      assert.equal(fields.length, 4, "incomplete Runtime process observation");
      const values = fields.map((value, index) => {
        const prefix = ["pid:", "effects:", "stat:", "processes:"][index];
        assert(value.startsWith(prefix), "invalid Runtime process field");
        return value.slice(prefix.length);
      });
      const [pidText, ...encoded] = values;
      const [effects, stat, processes] = encoded.map((value) => {
        assert.match(
          value,
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
        );
        return Buffer.from(value, "base64").toString();
      });
      const pid = pidText ? Number(pidText) : null;
      if (pid !== null) assert(Number.isSafeInteger(pid) && pid > 1);
      const pgid =
        evidence.started?.work.pgid ?? (stat ? processStat(stat).group : null);
      const row = {
        started_at,
        at: performance.now(),
        container: observedContainer,
        status: observedStatus,
        work: { pid, pgid, stat, processes, effects },
      };
      evidence.observations.push(row);
      return row;
    },
    async emit(options) {
      const bounded = operation(options, "emit");
      assert(evidence.started, "Runtime work not observed before emit");
      assert(!evidence.emit, "Runtime stdout gate already emitted");
      const row = {
        started_at: performance.now(),
        container_id: container.id,
        path: cacheRuntimeFiles.emit,
      };
      evidence.emit = row;
      await exec(
        bounded,
        `test ! -e ${cacheRuntimeFiles.emit} && : > ${cacheRuntimeFiles.emit}`,
      );
      row.at = performance.now();
      return row;
    },
  };
}
