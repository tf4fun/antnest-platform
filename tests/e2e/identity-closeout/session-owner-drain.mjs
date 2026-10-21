import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { durablePath } from "../../support/storage.mjs";
import {
  inspectOwnerDrain,
  inspectLoadOwnerRestoration,
} from "../edge-gateway/resolve-cache-owner-drain.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const traceID = /^[a-f0-9]{32}$/u;
const containerID = /^[a-f0-9]{64}$/u;

function configuration(options) {
  const {
    directory = "/checkpoints",
    project = process.env.COMPOSE_PROJECT_NAME,
    runID = process.env.ANTNEST_E2E_RUN_ID,
    signal,
    timeoutMs = 600000,
  } = options;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", uuid);
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000,
  );
  return {
    directory: durablePath(directory),
    project,
    runID,
    signal,
    timeoutMs,
  };
}

async function absent(directory, names) {
  for (const name of names) {
    try {
      await lstat(join(directory, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Session owner checkpoint already exists");
  }
}

async function publish(directory, name, value) {
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
    await link(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function waitJSON(options, name, timeoutMs = options.timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const path = join(options.directory, name),
        stat = await lstat(path);
      assert(
        stat.isFile() && stat.size <= 524288,
        "invalid Session owner checkpoint",
      );
      const timeout = Math.ceil(deadline - performance.now());
      assert(timeout > 0, "Session owner checkpoint read deadline elapsed");
      const signal = AbortSignal.timeout(timeout);
      const value = JSON.parse(
        await readFile(path, {
          encoding: "utf8",
          signal: options.signal
            ? AbortSignal.any([options.signal, signal])
            : signal,
        }),
      );
      options.signal?.throwIfAborted();
      assert(
        performance.now() < deadline,
        "Session owner checkpoint arrived after deadline",
      );
      return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (name === "owner-drained") {
        try {
          await lstat(join(options.directory, "owner-restored"));
          throw new Error("Session owner drain ended before acknowledgement");
        } catch (failure) {
          if (failure.code !== "ENOENT") throw failure;
        }
      }
      await delay(25, undefined, { signal: options.signal });
    }
  }
  throw new Error(`Session owner checkpoint ${name} timed out`);
}

function inspectRequest(request, options) {
  assert.deepEqual(Object.keys(request).sort(), [
    "agent_id",
    "identity_container_id",
    "identity_started_at",
    "kind",
    "nonce",
    "project",
    "public_trace_ids",
    "run_id",
    "version",
  ]);
  assert.equal(request.version, 1);
  assert.equal(request.kind, "session-owner-drain");
  assert.equal(request.project, options.project);
  assert.equal(request.run_id, options.runID);
  assert.match(request.nonce ?? "", uuid);
  assert(typeof request.agent_id === "string" && request.agent_id.length > 0);
  assert.match(request.identity_container_id ?? "", containerID);
  assert(
    typeof request.identity_started_at === "string" &&
      Number.isFinite(Date.parse(request.identity_started_at)),
  );
  assert(
    Array.isArray(request.public_trace_ids) &&
      request.public_trace_ids.length === 8,
  );
  // These eight positions accompany the independently checked closures. Trace
  // format and uniqueness are auxiliary and cannot prevent stop/restoration.
}

function inspectBoundDrain(lifecycle, request) {
  assert.equal(lifecycle.project, request.project);
  assert.equal(lifecycle.agent_id, request.agent_id);
  inspectOwnerDrain(lifecycle);
  for (const key of ["baseline", "before", "after"]) {
    assert.equal(
      lifecycle[key]["identity-service"].id,
      request.identity_container_id,
      "Session owner drain changed Identity generation",
    );
    assert.equal(
      lifecycle[key]["identity-service"].started_at,
      request.identity_started_at,
      "Session owner drain changed Identity process",
    );
  }
}

// The browser's remote close and the explicit SDK join must already be proven.
// This later window terminates retained UI owners; it cannot cause or prove any
// of the eight browser authorization closures that precede it.
export async function withSessionOwnerDrain(input, collect, options = {}) {
  options = configuration(options);
  options.signal?.throwIfAborted();
  assert.equal(
    input.clients.size,
    0,
    "Session protocol clients must be joined before owner drain",
  );
  assert.equal(
    input.observers.size,
    0,
    "Session browser observers must be joined before owner drain",
  );
  assert.equal(input.modelRequests, 8);
  assert.equal(input.closures.length, 8);
  const frozenAt = performance.now();
  for (const closure of input.closures) {
    assert.equal(closure.transport, "http-sse");
    assert.equal(closure.localClose, false);
    assert.equal(closure.protocolClientClosedLocally, true);
    assert([1, 2].includes(closure.protocolVersion));
    for (const value of [closure.closure.at, closure.denial.completedMono])
      assert(Number.isFinite(value) && value <= frozenAt);
  }
  for (const version of [1, 2])
    assert.deepEqual(
      input.closures
        .filter((row) => row.protocolVersion === version)
        .map((row) => row.reason)
        .sort(),
      ["expired", "revoked", "revoked", "unavailable"],
    );
  const identity = input.identityTransitions.at(-1)?.deployment;
  assert.equal(identity?.step, 3);
  assert.equal(identity.after.token_ttl, "12h");
  assert.equal(identity.after.running, true);
  const request = {
    version: 1,
    kind: "session-owner-drain",
    project: options.project,
    run_id: options.runID,
    nonce: randomUUID(),
    agent_id: input.agentId,
    identity_container_id: identity.after.container_id,
    identity_started_at: identity.after.started_at,
    public_trace_ids: input.closures.map((row) =>
      typeof row.traceID === "string" && traceID.test(row.traceID)
        ? row.traceID
        : null,
    ),
  };
  inspectRequest(request, options);
  await absent(options.directory, [
    "request-owner-drain",
    "owner-drained",
    "owner-collected",
    "owner-restored",
  ]);
  await publish(options.directory, "request-owner-drain", request);
  const errors = [];
  let result, drained;
  try {
    const ack = await waitJSON(
      options,
      "owner-drained",
      Math.min(options.timeoutMs, 90000),
    );
    assert.deepEqual(
      ack.request,
      request,
      "foreign Session owner drain acknowledgement",
    );
    inspectBoundDrain(ack.lifecycle, request);
    drained = structuredClone(ack.lifecycle);
    result = await collect(ack.lifecycle);
    options.signal?.throwIfAborted();
  } catch (error) {
    errors.push(error);
  } finally {
    let notified = false;
    try {
      await publish(options.directory, "owner-collected", {
        request,
        status: errors.length ? "failed" : "completed",
      });
      notified = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      // Even a cancelled or rejected collector must join the host's bounded
      // restoration before releasing the verification process.
      const ack = await waitJSON(
        { ...options, signal: undefined },
        "owner-restored",
        notified
          ? Math.min(options.timeoutMs, 90000)
          : options.timeoutMs + 30000,
      );
      assert.deepEqual(
        ack.request,
        request,
        "foreign Session owner restoration acknowledgement",
      );
      assert.equal(ack.status, "restored", "Session owner restoration failed");
      assert.equal(ack.lifecycle.restored, true);
      inspectLoadOwnerRestoration(ack.lifecycle);
      if (drained)
        for (const key of Object.keys(drained))
          if (key !== "restored")
            assert.deepEqual(
              ack.lifecycle[key],
              drained[key],
              "owner drain receipt changed during collection",
            );
    } catch (error) {
      errors.push(error);
    }
  }
  if (options.signal?.aborted && !errors.includes(options.signal.reason))
    errors.push(options.signal.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Session owner trace window failed");
  return result;
}

// The coordinator supplies the actual Docker lifecycle. No caller-supplied
// boolean, container exit code alone, or checkpoint time is a protocol join.
export async function serveSessionOwnerDrain({ createLifecycle, ...options }) {
  options = configuration(options);
  const request = await waitJSON(
    options,
    "request-owner-drain",
    Math.min(options.timeoutMs, 90000),
  );
  inspectRequest(request, options);
  await absent(options.directory, ["owner-drained", "owner-restored"]);
  let lifecycle, failure, collectionStatus;
  try {
    const owner = await createLifecycle(request);
    assert.equal(
      owner.baseline["identity-service"].id,
      request.identity_container_id,
    );
    await owner.collect(async (receipt) => {
      lifecycle = receipt;
      inspectBoundDrain(receipt, request);
      await publish(options.directory, "owner-drained", { request, lifecycle });
      const done = await waitJSON(options, "owner-collected");
      assert.deepEqual(
        done.request,
        request,
        "foreign Session collection completion",
      );
      assert(["completed", "failed"].includes(done.status));
      collectionStatus = done.status;
    });
    assert.equal(lifecycle.restored, true);
    inspectLoadOwnerRestoration(lifecycle);
  } catch (error) {
    failure = error;
  }
  await publish(options.directory, "owner-restored", {
    request,
    status: failure ? "failed" : "restored",
    lifecycle,
    collection_status: collectionStatus,
  });
  if (failure) throw failure;
  return { request, lifecycle, collection_status: collectionStatus };
}
