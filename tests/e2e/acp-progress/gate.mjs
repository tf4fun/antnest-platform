import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { progressProbeCommand, progressProbeResult } from "./gate-probe.mjs";
import { serveProgressRuntimeInspection } from "./runtime-inspection.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value) + "\n");
const failureReason = (reason) =>
  reason instanceof Error
    ? reason
    : new Error("Progress gate rejected with a non-Error reason", {
        cause: reason,
      });
const clients = new Map();
const name = (sequence, type) =>
  `gate-${String(sequence).padStart(6, "0")}.${type}.json`;
function keys(value, expected) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.sort());
}
function configuration(env) {
  const project = env.COMPOSE_PROJECT_NAME,
    run_id = env.ANTNEST_E2E_RUN_ID;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(run_id ?? "", uuid);
  const runtime_image = `antnest/antnest-runtime:progress-${run_id}`;
  assert.equal(
    env.TEST_RUNTIME_IMAGE ?? env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    runtime_image,
  );
  return { project, run_id, runtime_image };
}
function prepare(directory) {
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return realpathSync(directory);
}
function publish(directory, file, value) {
  const temporary = `pending-${randomUUID()}.json`,
    bytes = encode(value);
  try {
    writeEvidenceFile(directory, temporary, bytes);
    linkSync(join(directory, temporary), join(directory, file));
  } finally {
    rmSync(join(directory, temporary), { force: true });
  }
  return bytes;
}
async function message(directory, file) {
  try {
    const bytes = await readFile(join(directory, file));
    assert(bytes.length <= 65536, "Progress gate message too large");
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function identity(value, config, agent) {
  keys(value, [
    "project",
    "agent_id",
    "container_id",
    "image_id",
    "image_ref",
    "generation",
    "started_at",
  ]);
  assert.equal(value.project, config.project);
  assert.equal(value.agent_id, agent);
  assert.equal(value.image_ref, config.runtime_image);
  assert.match(value.container_id ?? "", /^[a-f0-9]{64}$/u);
  assert.match(value.image_id ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(value.generation) && value.generation > 0);
  assert.match(
    value.started_at ?? "",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/u,
  );
  assert(
    Number.isFinite(Date.parse(value.started_at)) &&
      Date.parse(value.started_at) > 0,
  );
  return value;
}
function requestContract(value, config, sequence) {
  keys(value, [
    "version",
    "project",
    "run_id",
    "runtime_image",
    "agent_id",
    "sequence",
    "nonce",
    "action",
    "phase",
    "binding",
    "timeout_ms",
  ]);
  assert.equal(value.version, 1);
  for (const [key, expected] of Object.entries(config))
    assert.equal(value[key], expected);
  assert.match(value.agent_id ?? "", /^agent_[a-f0-9]+$/u);
  assert.match(value.nonce ?? "", uuid);
  assert.equal(value.sequence, sequence);
  assert(Number.isSafeInteger(sequence) && sequence > 0 && sequence < 1000000);
  assert(
    Number.isSafeInteger(value.timeout_ms) &&
      value.timeout_ms > 0 &&
      value.timeout_ms <= 10000,
  );
  assert(["bind", "release", "alive", "stopped"].includes(value.action));
  if (value.action === "bind") {
    assert.equal(value.phase, null);
    assert.equal(value.binding, null);
  } else {
    identity(value.binding, config, value.agent_id);
    assert.match(
      value.phase ?? "",
      /^v[12]-(bash|managed)-(success|failure|cancel)$/u,
    );
    assert.equal(value.phase.endsWith("-cancel"), value.action !== "release");
  }
}
function receiptContract(value, request, config) {
  keys(value, [
    "request",
    "status",
    "runtime",
    "result",
    "raw_sha256",
    "error",
  ]);
  assert.deepEqual(
    value.request,
    request,
    "Progress gate receipt belongs to another request",
  );
  assert.match(value.raw_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert(["verified", "failed"].includes(value.status));
  if (value.status === "failed") {
    assert.equal(value.error, "operation_failed");
    assert.equal(value.result, null);
    return value;
  }
  assert.equal(value.error, null);
  identity(value.runtime, config, request.agent_id);
  if (request.binding)
    assert.deepEqual(value.runtime, request.binding, "bound Runtime changed");
  progressProbeResult(request.action, request.phase, value.result);
  return value;
}

// The browser fixture has only a run-scoped file channel. Docker access and raw
// container inspection remain in the coordinating host process.
export async function runtimeGate(
  agent,
  {
    env = process.env,
    directory = env.ANTNEST_PROGRESS_GATE_DIR,
    signal,
    wait = delay,
    now = () => performance.now(),
    joinTimeoutMS = 120000,
  } = {},
) {
  const config = configuration(env);
  assert.match(agent, /^agent_[a-f0-9]+$/u);
  assert(
    Number.isSafeInteger(joinTimeoutMS) &&
      joinTimeoutMS > 0 &&
      joinTimeoutMS <= 120000,
  );
  directory = prepare(directory);
  let channel = clients.get(directory);
  if (!channel)
    clients.set(directory, (channel = { sequence: 0, active: false }));
  let binding;
  async function exchange(action, phase = null, { timeoutMS = 10000 } = {}) {
    assert(!channel.active, "overlapping Progress gate requests");
    signal?.throwIfAborted();
    const started = now();
    assert(Number.isFinite(timeoutMS) && timeoutMS >= 1 && timeoutMS <= 10000);
    channel.active = true;
    try {
      const request = {
        version: 1,
        ...config,
        agent_id: agent,
        sequence: ++channel.sequence,
        nonce: randomUUID(),
        action,
        phase,
        binding: binding ?? null,
        timeout_ms: Math.floor(timeoutMS),
      };
      requestContract(request, config, channel.sequence);
      publish(directory, name(request.sequence, "request"), request);
      let cancelled, joinUntil;
      for (;;) {
        const found = await message(
          directory,
          name(request.sequence, "receipt"),
        );
        const elapsed = now() - started;
        assert(
          Number.isFinite(elapsed) && elapsed >= 0,
          "invalid Progress gate monotonic time",
        );
        if (found) {
          const receipt = receiptContract(found.value, request, config);
          publish(directory, name(request.sequence, "consumed"), {
            sequence: request.sequence,
            nonce: request.nonce,
            receipt_sha256: digest(found.bytes),
          });
          signal?.throwIfAborted();
          assert(
            !cancelled && elapsed <= request.timeout_ms,
            "Progress gate deadline exceeded",
          );
          assert.equal(
            receipt.status,
            "verified",
            "Progress host gate operation failed",
          );
          return receipt;
        }
        if (!cancelled && (signal?.aborted || elapsed > request.timeout_ms)) {
          cancelled = true;
          publish(directory, name(request.sequence, "cancel"), { request });
          // Cancellation fails admission immediately, but the caller still joins
          // the host's settled operation before it may clean up its Agent.
          joinUntil = performance.now() + joinTimeoutMS;
        }
        assert(
          !cancelled || performance.now() < joinUntil,
          "Progress gate cancellation join deadline exceeded",
        );
        await wait(25);
      }
    } finally {
      channel.active = false;
    }
  }
  binding = (await exchange("bind")).runtime;
  const checkedSource = (phase, source) =>
    assert.equal(phase.split("-")[1], source);
  return Object.freeze({
    release: async (phase) => {
      await exchange("release", phase);
    },
    alive: async (phase, source) => {
      checkedSource(phase, source);
      await exchange("alive", phase);
    },
    stopped: async (phase, source, options) => {
      checkedSource(phase, source);
      return (await exchange("stopped", phase, options)).result.stopped;
    },
  });
}

function inspectRuntime(rows, config, agent, imageID) {
  assert(
    Array.isArray(rows) && rows.length === 1,
    "one original Runtime required",
  );
  const row = rows[0],
    labels = row.Config?.Labels ?? {},
    state = row.State ?? {};
  assert.equal(labels["io.antnest.agent-id"], agent, "Runtime Agent differs");
  assert.equal(labels["io.antnest.managed"], "runtime");
  assert.equal(labels["io.antnest.runtime-controller-scope"], config.project);
  assert.equal(row.Image, imageID);
  assert.equal(row.Config.Image, imageID);
  for (const [key, expected] of [
    ["ANTNEST_RUNTIME_IMAGE_REFERENCE", config.runtime_image],
    ["ANTNEST_RUNTIME_IMAGE_ID", imageID],
  ])
    assert.deepEqual(
      row.Config.Env.filter((item) => item.startsWith(key + "=")),
      [`${key}=${expected}`],
    );
  assert.equal(state.Running, true);
  for (const key of ["Paused", "Restarting", "Dead"])
    assert.equal(state[key], false);
  const generation = labels["io.antnest.runtime-generation"];
  assert.match(generation ?? "", /^[1-9]\d*$/u);
  return identity(
    {
      project: config.project,
      agent_id: agent,
      container_id: row.Id,
      image_id: row.Image,
      image_ref: config.runtime_image,
      generation: Number(generation),
      started_at: state.StartedAt,
    },
    config,
    agent,
  );
}

export function createProgressGateHost({
  env,
  directory,
  evidence,
  imageID,
  docker,
  wait = delay,
  now = () => performance.now(),
}) {
  const config = configuration(env);
  assert.match(imageID, /^sha256:[a-f0-9]{64}$/u);
  directory = prepare(directory);
  evidence = prepare(evidence);
  const evidencePath = relative(directory, evidence);
  assert(
    evidencePath.startsWith("../") || isAbsolute(evidencePath),
    "raw Docker evidence must not be exposed in client IPC",
  );
  const bound = new Map(),
    alive = new Map(),
    receipts = [],
    nonces = new Set();
  const originals = new Map();
  let sequence = 1,
    active = false,
    failure,
    finished = false;
  const inspect = async (agent, signal, timeoutMS, capture) => {
    const raw = await docker(
      ["container", "inspect", `antnest-runtime-${agent}`],
      false,
      { signal, timeoutMS },
    );
    capture?.(raw);
    const rows = JSON.parse(raw);
    return { raw, rows, runtime: inspectRuntime(rows, config, agent, imageID) };
  };
  async function consumed(all = false) {
    for (const item of all ? receipts : receipts.slice(-1)) {
      const found = await message(directory, name(item.sequence, "consumed"));
      assert(found, "Progress gate receipt not consumed");
      assert.deepEqual(found.value, item);
      const original = originals.get(item.sequence);
      for (const type of ["request", "receipt", "evidence"]) {
        const bytes = await readFile(
          join(
            type === "evidence" ? evidence : directory,
            name(item.sequence, type),
          ),
        );
        assert.equal(
          digest(bytes),
          original[type],
          `original gate ${type} hash changed`,
        );
      }
    }
  }
  async function settledInventory() {
    const requests = (await readdir(directory))
      .filter((file) => file.endsWith(".request.json"))
      .sort();
    assert.deepEqual(
      requests,
      receipts.map((r) => name(r.sequence, "request")),
      "unsettled gate request at final ACK",
    );
  }
  return {
    async poll(signal) {
      assert(!active && !finished, "Progress host gate unavailable");
      if (failure) throw failure;
      signal?.throwIfAborted();
      const found = await message(directory, name(sequence, "request"));
      if (!found) return false;
      active = true;
      let request,
        runtime = null,
        result = null,
        error,
        monitor;
      const stopMonitor = new AbortController(),
        cancel = new AbortController();
      const original = { request: found.value };
      try {
        await consumed();
        assert.equal(
          await message(directory, name(sequence, "receipt")),
          undefined,
          "gate replay refused",
        );
        request = found.value;
        requestContract(request, config, sequence);
        assert(!nonces.has(request.nonce), "duplicate Progress gate nonce");
        nonces.add(request.nonce);
        const started = now();
        const operationSignal = AbortSignal.any([
          cancel.signal,
          AbortSignal.timeout(request.timeout_ms),
          ...(signal ? [signal] : []),
        ]);
        const remaining = () => {
          operationSignal.throwIfAborted();
          const elapsed = now() - started;
          assert(Number.isFinite(elapsed) && elapsed >= 0);
          const value = request.timeout_ms - elapsed;
          assert(value > 0, "host gate deadline exceeded");
          return value;
        };
        async function checkCancel() {
          const value = await message(directory, name(sequence, "cancel"));
          if (value) {
            assert.deepEqual(value.value, { request });
            cancel.abort(new Error("Progress gate cancelled"));
          }
          operationSignal.throwIfAborted();
        }
        await checkCancel();
        monitor = (async () => {
          while (!stopMonitor.signal.aborted) {
            await checkCancel();
            await wait(25, undefined, { signal: stopMonitor.signal });
          }
        })().catch((reason) => {
          if (!stopMonitor.signal.aborted) {
            error ??= failureReason(reason);
            cancel.abort(reason);
          }
        });
        const prior = bound.get(request.agent_id);
        if (request.action === "bind")
          assert(!prior && bound.size < 4, "duplicate or excess bound Runtime");
        else
          assert.deepEqual(
            request.binding,
            prior,
            "original bound Runtime required",
          );
        const before = await inspect(
          request.agent_id,
          operationSignal,
          remaining(),
          (raw) => {
            original.before_raw = raw;
          },
        );
        original.before = before.rows;
        original.before_raw = before.raw;
        runtime = before.runtime;
        if (prior)
          assert.deepEqual(
            runtime,
            prior,
            "bound Runtime changed before probe",
          );
        if (request.action !== "bind") {
          const phaseKey = `${request.agent_id}:${request.phase}`,
            process = alive.get(phaseKey);
          if (request.action === "stopped")
            assert(
              process !== undefined,
              "original alive process proof required",
            );
          if (request.action === "alive")
            assert(!alive.has(phaseKey), "duplicate alive proof");
          const command = progressProbeCommand(
            request.action,
            request.phase,
            process,
          );
          await checkCancel();
          original.execution = { command };
          original.execution.stdout = await docker(
            [
              "exec",
              "--user",
              "1000:1000",
              runtime.container_id,
              "/bin/sh",
              "-c",
              command,
            ],
            false,
            { signal: operationSignal, timeoutMS: remaining() },
          );
          result = progressProbeResult(
            request.action,
            request.phase,
            original.execution.stdout,
            process,
          );
        }
        const after = await inspect(
          request.agent_id,
          operationSignal,
          remaining(),
          (raw) => {
            original.after_raw = raw;
          },
        );
        original.after = after.rows;
        original.after_raw = after.raw;
        assert.deepEqual(
          after.runtime,
          runtime,
          "bound Runtime changed during probe",
        );
        await checkCancel();
        remaining();
        if (request.action === "bind") bound.set(request.agent_id, runtime);
        if (request.action === "alive")
          alive.set(`${request.agent_id}:${request.phase}`, result.process);
      } catch (reason) {
        error ??= failureReason(reason);
      } finally {
        stopMonitor.abort();
        if (monitor) await monitor;
      }
      try {
        if (signal?.aborted) error ??= failureReason(signal.reason);
        if (error)
          original.error = {
            name: error.name,
            message: error.message,
            stack: error.stack,
          };
        const bytes = encode(original);
        writeEvidenceFile(evidence, name(sequence, "evidence"), bytes);
        const receipt = {
          request: found.value,
          status: error ? "failed" : "verified",
          runtime,
          result: error ? null : result,
          raw_sha256: digest(bytes),
          error: error ? "operation_failed" : null,
        };
        const receiptBytes = publish(
          directory,
          name(sequence, "receipt"),
          receipt,
        );
        receipts.push({
          sequence,
          nonce: request?.nonce,
          receipt_sha256: digest(receiptBytes),
        });
        originals.set(sequence, {
          request: digest(found.bytes),
          receipt: digest(receiptBytes),
          evidence: digest(bytes),
        });
        sequence++;
        if (error) throw error;
        return true;
      } catch (reason) {
        failure = failureReason(reason);
        throw failure;
      } finally {
        active = false;
      }
    },
    async finish(agents, signal) {
      assert(!active && !finished && !failure, "Progress gate not settled");
      assert(
        Array.isArray(agents) &&
          agents.length === 4 &&
          new Set(agents).size === 4,
      );
      assert.deepEqual(
        new Set(agents),
        new Set(bound.keys()),
        "final Runtime Agents differ from original bindings",
      );
      active = true;
      const rows = [],
        runtimes = [];
      try {
        await consumed(true);
        await settledInventory();
        for (const agent of agents) {
          signal?.throwIfAborted();
          const checked = await inspect(agent, signal, 10000, (raw) => {
            rows.push({ agent_id: agent, raw });
          });
          assert.deepEqual(
            checked.runtime,
            bound.get(agent),
            "bound Runtime changed before final ACK",
          );
          runtimes.push(checked.runtime);
        }
        await consumed(true);
        await settledInventory();
        signal?.throwIfAborted();
        const bytes = publish(evidence, "gate-final.evidence.json", {
          rows,
          runtimes,
          receipts,
        });
        finished = true;
        return { runtimes, raw_sha256: digest(bytes) };
      } catch (reason) {
        failure = failureReason(reason);
        publish(evidence, "gate-final-failed.evidence.json", {
          rows,
          runtimes,
          receipts,
          error: {
            name: failure.name,
            message: failure.message,
            stack: failure.stack,
          },
        });
        throw failure;
      } finally {
        active = false;
      }
    },
  };
}

// A single owner serves the probes while waiting for the final request. Waiting
// for that request before starting probes would deadlock the business client.
export async function serveProgressGates({
  checkpointDirectory,
  signal,
  timeout,
  check = async () => {},
  ...options
}) {
  const host = createProgressGateHost(options);
  return serveProgressRuntimeInspection({
    env: options.env,
    directory: checkpointDirectory,
    signal,
    timeout,
    wait: options.wait,
    waiting: async (boundedSignal) => {
      await check(boundedSignal);
      return host.poll(boundedSignal);
    },
    inspect: async (request, boundedSignal) => {
      await check(boundedSignal);
      const proof = await host.finish(request.agent_ids, boundedSignal);
      await check(boundedSignal);
      return proof;
    },
  });
}
