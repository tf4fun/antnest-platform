import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";

// Executed inside the owned model container. The envelope preserves body bytes,
// including an incomplete UTF-8 suffix, independently of Docker stdout trimming.
export async function captureCostModelResponse(
  url,
  method,
  { signal, onChunk = () => {} } = {},
) {
  signal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(5000),
  ]);
  const chunks = [];
  let status = null,
    complete = false,
    error_type = null,
    size = 0;
  try {
    const response = await fetch(url, { method, signal });
    status = response.status;
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      assert(size <= 1024 * 1024, "Cost model response exceeds limit");
      await onChunk();
    }
    signal.throwIfAborted();
    complete = true;
  } catch (error) {
    error_type = error.name;
  }
  return {
    status,
    body_base64: Buffer.concat(chunks).toString("base64"),
    complete,
    error_type,
  };
}
const modelCommand = `import { captureCostModelResponse } from "/app/tests/e2e/acp-cost/restart.mjs";
console.log(JSON.stringify(await captureCostModelResponse(new URL(process.argv[1], "http://127.0.0.1:8080"), process.argv[2])));`;
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function checkedExpected(expected) {
  assert.match(expected.project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(
    expected.run_id ?? "",
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  for (const name of ["container_id", "client_id", "model_id"])
    assert.match(expected[name] ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(
    new Set([expected.container_id, expected.client_id, expected.model_id])
      .size,
    3,
  );
  assert.match(expected.image_id ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    expected.image_ref,
    `antnest/agent-acp-service:cost-${expected.run_id}`,
  );
  assert(Number.isFinite(Date.parse(expected.started_at)));
}
function identity(row, role, expected) {
  assert.equal(
    row.Id,
    role === "acp" ? expected.container_id : expected[role + "_id"],
  );
  assert.equal(row.Image, expected.image_id);
  assert.equal(row.Config?.Image, expected.image_ref);
  assert.equal(
    row.Config.Labels["com.docker.compose.project"],
    expected.project,
  );
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    role === "acp" ? "agent-acp-service" : "cost-" + role,
  );
  if (role === "acp")
    assert.equal(
      row.Config.Labels["io.antnest.deployment-admission"],
      expected.project,
    );
  else
    assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], expected.run_id);
  for (const key of ["Paused", "Dead", "OOMKilled"])
    assert.equal(row.State?.[key], false);
  assert.equal(row.State.Error, "");
  assert.equal(row.State.ExitCode, 0);
}
function running(row) {
  assert.equal(row.State.Running, true);
  assert.equal(row.State.Status, "running");
  assert.equal(row.State.Restarting, false);
}
function healthy(row) {
  running(row);
  assert.equal(row.State.Health?.Status, "healthy");
}

export async function restartCostACP({
  expected,
  directory,
  docker,
  signal,
  timeout = 900000,
  restartTimeout = 90000,
  wait = delay,
}) {
  checkedExpected(expected);
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000);
  assert(
    Number.isSafeInteger(restartTimeout) &&
      restartTimeout > 0 &&
      restartTimeout <= 90000,
  );
  const deadline = Date.now() + timeout;
  signal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeout),
  ]);
  signal.throwIfAborted();
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  // This directory is an exclusive attempt marker, including failed attempts.
  // Retrying an ambiguous Docker operation must never cause a second restart.
  directory = join(directory, "restart");
  await mkdir(directory, { mode: 0o700 });
  const events = [],
    clock_id = randomUUID();
  const save = (name, value) =>
    writeEvidenceFile(directory, name, encode(value));
  const record = (kind, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sequence = events.length + 1;
    const file = `${String(sequence).padStart(4, "0")}-${kind}.private.raw`;
    writeEvidenceFile(directory, file, bytes);
    events.push({
      sequence,
      monotonic_ms: performance.now(),
      kind,
      file,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    save("events.private.json", events);
  };
  let operationSignal = signal,
    operationDeadline = deadline;
  const call = async (kind, args, long = false) => {
    operationSignal.throwIfAborted();
    const timeoutMS = operationDeadline - Date.now();
    assert(timeoutMS > 0, "Cost restart deadline expired");
    let raw;
    try {
      raw = await docker(args, long, { signal: operationSignal, timeoutMS });
    } catch (error) {
      if (operationSignal.aborted && error !== operationSignal.reason)
        throw new AggregateError(
          [operationSignal.reason, error],
          "Cost Docker operation cancelled",
          { cause: error },
        );
      throw error;
    }
    assert.equal(typeof raw, "string");
    // dockerClient trims its decoded stdout. Preserve that complete returned
    // text with one LF; do not call this original CLI stdout/stderr bytes.
    record(kind, raw + "\n");
    operationSignal.throwIfAborted();
    return raw;
  };
  const inspect = async (role, kind) => {
    const id = role === "acp" ? expected.container_id : expected[role + "_id"];
    const rows = JSON.parse(await call(kind, ["inspect", id]));
    assert(Array.isArray(rows) && rows.length === 1);
    identity(rows[0], role, expected);
    return rows[0];
  };
  const model = async (path, method) => {
    const envelope = JSON.parse(
      await call("model-probe", [
        "exec",
        expected.model_id,
        "node",
        "--input-type=module",
        "-e",
        modelCommand,
        path,
        method,
      ]),
    );
    assert.equal(typeof envelope.body_base64, "string");
    const bytes = Buffer.from(envelope.body_base64, "base64");
    assert.equal(bytes.toString("base64"), envelope.body_base64);
    record("model-response", bytes);
    assert.equal(envelope.status, 200);
    assert.equal(envelope.complete, true);
    assert.equal(envelope.error_type, null);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const status = async () => {
    running(await inspect("client", "client"));
    running(await inspect("model", "model"));
    const result = await model("/status", "GET");
    assert.deepEqual(result.errors, []);
    assert(Array.isArray(result.requests));
    assert(
      ["running", "restart"].includes(result.checkpoint),
      "unexpected or stale Cost restart checkpoint",
    );
    return result;
  };
  try {
    record("expected", encode(expected));
    const ids = (
      await call("acp-selection", [
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${expected.project}`,
        "--filter",
        "label=com.docker.compose.service=agent-acp-service",
      ])
    )
      .split(/\s+/u)
      .filter(Boolean);
    assert.deepEqual(ids, [expected.container_id]);
    while ((await status()).checkpoint !== "restart")
      await wait(1000, undefined, { signal: operationSignal });
    operationDeadline = Math.min(deadline, Date.now() + restartTimeout);
    operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, operationDeadline - Date.now())),
    ]);
    const before = await inspect("acp", "acp-before");
    healthy(before);
    assert.equal(
      before.State.StartedAt,
      expected.started_at,
      "ACP restarted before the requested checkpoint",
    );
    const command = ["restart", "--timeout", "10", expected.container_id];
    record("restart-intent", encode({ command }));
    assert.equal(
      await call("restart-result", command, true),
      expected.container_id,
    );
    let after;
    for (;;) {
      after = await inspect("acp", "acp-after");
      if (after.State.Health?.Status === "healthy") break;
      await wait(1000, undefined, { signal: operationSignal });
    }
    healthy(after);
    assert(
      Date.parse(after.State.StartedAt) > Date.parse(before.State.StartedAt),
      "ACP did not actually restart",
    );
    assert.equal((await status()).checkpoint, "restart");
    operationSignal.throwIfAborted();
    record("ack-intent", encode({ path: "/restarted", method: "POST" }));
    assert.deepEqual(await model("/restarted", "POST"), {
      checkpoint: "restarted",
    });
    operationSignal.throwIfAborted();
    const receipt = {
      version: 1,
      status: "verified",
      project: expected.project,
      run_id: expected.run_id,
      actual_restarts: 1,
      container_id: expected.container_id,
      image_id: expected.image_id,
      image_ref: expected.image_ref,
      before_started_at: before.State.StartedAt,
      after_started_at: after.State.StartedAt,
      clock_id,
      process_pid: process.pid,
      events: events.length,
      docker_output: "complete trimmed decoded stdout with one appended LF",
      events_sha256: hash(Buffer.from(encode(events))),
    };
    save("receipt.json", receipt);
    return receipt;
  } catch (error) {
    try {
      save("failure.private.json", {
        status: "failed",
        clock_id,
        process_pid: process.pid,
        ...summarizeFailure(error),
        events: events.length,
      });
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        "Cost restart and evidence recording failed",
        { cause: recordingError },
      );
    }
    throw error;
  }
}
