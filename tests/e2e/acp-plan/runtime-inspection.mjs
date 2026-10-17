import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
function configuration(env) {
  const project = env.COMPOSE_PROJECT_NAME,
    run_id = env.ANTNEST_E2E_RUN_ID;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(run_id ?? "", uuid);
  const runtime_image = `antnest/antnest-runtime:plan-${run_id}`;
  assert.equal(
    env.TEST_RUNTIME_IMAGE ?? env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    runtime_image,
  );
  return { project, run_id, runtime_image };
}
function inspectRequest(request, env) {
  const expected = configuration(env);
  assert.deepEqual(Object.keys(request).sort(), [
    "agent_ids",
    "nonce",
    "project",
    "run_id",
    "runtime_image",
    "version",
  ]);
  assert.equal(request.version, 1);
  for (const key of Object.keys(expected))
    assert.equal(request[key], expected[key]);
  assert.match(request.nonce ?? "", uuid);
  assert(
    Array.isArray(request.agent_ids) &&
      request.agent_ids.length === 2 &&
      new Set(request.agent_ids).size === 2 &&
      request.agent_ids.every((id) => typeof id === "string" && id.length > 0),
  );
}
function inspectReceipt(receipt, request) {
  assert.deepEqual(Object.keys(receipt).sort(), [
    "raw_sha256",
    "request",
    "runtimes",
    "status",
  ]);
  assert.equal(receipt.status, "verified");
  assert.deepEqual(
    receipt.request,
    request,
    "Runtime receipt belongs to another request",
  );
  assert.match(receipt.raw_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert(Array.isArray(receipt.runtimes) && receipt.runtimes.length === 2);
  assert.deepEqual(
    receipt.runtimes.map((row) => row.agent_id),
    request.agent_ids,
  );
  assert.equal(
    new Set(receipt.runtimes.map((row) => row.container_id)).size,
    2,
  );
  assert.equal(new Set(receipt.runtimes.map((row) => row.image_id)).size, 1);
  for (const row of receipt.runtimes) {
    assert.equal(row.project, request.project);
    assert.equal(row.image_ref, request.runtime_image);
    assert.match(row.image_id ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.match(row.container_id ?? "", /^[a-f0-9]{64}$/u);
    assert(Number.isSafeInteger(row.generation) && row.generation > 0);
  }
  return receipt;
}
function prepare(directory) {
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
// Publish a complete message without overwriting a prior run/receipt. The
// synchronous atomic publication is the commit point after cancellation checks.
function publish(directory, name, value) {
  const temporary = `pending-${randomUUID()}.json`;
  try {
    writeEvidenceFile(directory, temporary, JSON.stringify(value) + "\n");
    linkSync(join(directory, temporary), join(directory, name));
  } finally {
    rmSync(join(directory, temporary), { force: true });
  }
}
async function optionalMessage(directory, name) {
  try {
    return JSON.parse(await readFile(join(directory, name), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function bounded(signal, timeout) {
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000);
  return AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeout),
  ]);
}
export async function requestPlanRuntimeInspection(
  agents,
  {
    env = process.env,
    directory = env.ANTNEST_PLAN_RUNTIME_CHECKPOINT_DIR,
    signal,
    wait = delay,
    timeout = 120000,
  } = {},
) {
  signal = bounded(signal, timeout);
  signal.throwIfAborted();
  const request = {
    version: 1,
    ...configuration(env),
    nonce: randomUUID(),
    agent_ids: [...agents],
  };
  inspectRequest(request, env);
  directory = prepare(directory);
  publish(directory, "runtime-request.json", request);
  for (;;) {
    signal.throwIfAborted();
    const receipt = await optionalMessage(directory, "runtime-receipt.json");
    signal.throwIfAborted();
    if (receipt) return inspectReceipt(receipt, request);
    await wait(100, undefined, { signal });
  }
}
export async function servePlanRuntimeInspection({
  env = process.env,
  directory,
  inspect,
  signal,
  wait = delay,
  waiting = async () => {},
  timeout = 900000,
}) {
  signal = bounded(signal, timeout);
  signal.throwIfAborted();
  configuration(env);
  directory = prepare(directory);
  for (;;) {
    signal.throwIfAborted();
    const request = await optionalMessage(directory, "runtime-request.json");
    signal.throwIfAborted();
    if (request) {
      inspectRequest(request, env);
      const proof = await inspect(request, signal);
      signal.throwIfAborted();
      const receipt = inspectReceipt(
        { status: "verified", request, ...proof },
        request,
      );
      publish(directory, "runtime-receipt.json", receipt);
      return receipt;
    }
    await waiting();
    signal.throwIfAborted();
    await wait(1000, undefined, { signal });
  }
}
