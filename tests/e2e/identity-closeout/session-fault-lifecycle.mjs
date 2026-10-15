import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertNoStore } from "./support.mjs";
import { assertClearedSessionCookies } from "./expiry.mjs";
import { durablePath } from "../../support/storage.mjs";

const mark = () => ({ at: performance.now(), observed_at_ms: Date.now() });
const traceID = /^[a-f0-9]{32}$/u;

export async function closeSessionFaultResources({
  clients,
  observers,
  pool,
  telemetry,
}) {
  const settled = await Promise.allSettled(
    [...clients, ...observers].map((resource) =>
      Promise.resolve().then(() => resource.closeAndWait()),
    ),
  );
  // Transport and database spans must finish before the exporter shuts down.
  // Join every resource even when an earlier closer throws synchronously.
  for (const close of [() => pool.end(), () => telemetry.shutdown()])
    settled.push(
      ...(await Promise.allSettled([Promise.resolve().then(close)])),
    );
  const errors = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(errors, "Session resource cleanup failed");
}

export async function logoutSession(browser, observer, checkpoint, principal) {
  assert.equal(checkpoint.reason, "revoked");
  assert(
    browser.cookie && browser.cookie === observer.browser.cookie,
    "logout must use the original stream authority",
  );
  for (const name of ["organization_id", "user_id"])
    assert(typeof principal?.[name] === "string" && principal[name]);
  const started = mark();
  const response = await browser.request("/api/session", {
    method: "DELETE",
    status: 204,
  });
  const completed = mark();
  try {
    assert.equal(response.status, 204);
    assert.match(response.traceID ?? "", traceID);
    assertNoStore(response.headers);
    assertClearedSessionCookies(response.headers);
    assert.equal(browser.cookie, "");
  } catch {
    throw new Error("Logout response did not satisfy its contract");
  }
  return {
    kind: "logout",
    path: "/api/session",
    method: "DELETE",
    status: 204,
    traceID: response.traceID,
    credentialScope: checkpoint.stream.credential_scope,
    principal: structuredClone(principal),
    startedAt: started.observed_at_ms,
    completedAt: completed.observed_at_ms,
    startedMono: started.at,
    completedMono: completed.at,
    serverDate: response.headers.get("date"),
  };
}

// Only the observer can prove the remote browser close. The private SDK is
// explicitly closed afterwards, and its pending request is joined before the
// caller may release an already admitted model execution.
export async function finishSessionFault({
  observer,
  client,
  checkpoint,
  cause,
  pending,
  now = () => performance.now(),
  wait = delay,
  signal,
}) {
  const settlement =
    pending === undefined
      ? undefined
      : Promise.resolve(pending).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        );
  let result, failure;
  try {
    signal?.throwIfAborted();
    assert([1, 2].includes(client.version));
    for (const key of ["organization_id", "user_id"])
      assert(
        typeof observer.principal?.[key] === "string" &&
          observer.principal[key],
      );
    assert.equal(
      cause.kind,
      {
        revoked: "logout",
        unavailable: "identity-outage",
        expired: "absolute-expiry",
      }[checkpoint.reason],
    );
    if (checkpoint.reason === "revoked")
      assert.equal(cause.credentialScope, checkpoint.stream.credential_scope);
    if (checkpoint.reason === "expired")
      assert.equal(cause.expiresAt, checkpoint.expiresAt);
    if (checkpoint.reason === "unavailable")
      assert.equal(cause.transition.deployment.step, 1);
    const closed = await observer.waitForClose(checkpoint);
    assert.equal(closed.transport, "http-sse");
    assert.equal(closed.localClose, false);
    assert.equal(closed.authorizationCauseVerified, false);
    assert.equal(closed.credentialScope, checkpoint.stream.credential_scope);
    if (checkpoint.reason === "expired") {
      assert.equal(cause.transition?.deployment.step, 2);
      assert.equal(cause.transition.deployment.after.token_ttl, "5s");
      const acknowledged = cause.transition.observation.acknowledged.at;
      assert(Number.isFinite(acknowledged));
      assert(
        checkpoint.issuance.startedMono >= acknowledged &&
          checkpoint.issuance.completedMono <= checkpoint.stream.started_at,
      );
      // The original login precedes these headers. The actual 5s token TTL
      // plus the deployed 10s cache budget ends before this conservative 17s
      // client-monotonic bound. The shared RPC's 5s cap cannot renew that cache
      // budget: validUntil is anchored to its actual start, not its delivery.
      const deadline = checkpoint.stream.headers_at + 17000;
      const remaining = deadline - now();
      assert(Number.isFinite(remaining) && remaining <= 17000);
      if (remaining >= 0) await wait(remaining + 1, undefined, { signal });
      signal?.throwIfAborted();
      assert(
        now() > deadline,
        "HTTP denial preceded original authority/cache upper bound",
      );
    }
    const denial = await observer.rejectPrompt();
    assert.equal(denial.credentialScope, closed.credentialScope);
    assert.match(denial.traceID ?? "", traceID);
    result = {
      ...closed,
      protocolVersion: client.version,
      principal: structuredClone(observer.principal),
      cause,
      denial,
      protocolClientClosedLocally: true,
    };
  } catch (error) {
    failure = error;
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => client.closeAndWait()),
    Promise.resolve().then(() => observer.closeAndWait()),
  ]);
  if (settlement) cleanup.push(await settlement);
  if (failure) throw failure;
  const errors = cleanup
    .filter((item) => item.status === "rejected")
    .map((item) => item.reason);
  if (errors.length)
    throw new AggregateError(errors, "Session fault cleanup failed");
  return result;
}

export function checkedAcknowledgement(value, request, previous) {
  const { step, project, run_id: runID } = request;
  assert.deepEqual(
    value.request,
    request,
    "ACK does not belong to the current fault request",
  );
  assert.equal(value.version, 1);
  assert.equal(value.project, project);
  assert.equal(value.run_id, runID);
  assert.equal(value.step, step);
  assert.equal(value.image_ref, `antnest/identity-service:session-${runID}`);
  assert.match(value.image_id ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(value.authorization_cause_verified, false);
  for (const key of ["before_sha256", "after_sha256"])
    assert.match(value.raw?.[key] ?? "", /^[a-f0-9]{64}$/u);
  for (const row of [value.before, value.after])
    assert.match(row?.container_id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(value.before.token_ttl, step === 3 ? "5s" : "12h");
  assert.equal(value.after.token_ttl, step === 2 ? "5s" : "12h");
  assert.equal(value.before.running, step !== 2);
  assert.equal(value.after.running, step !== 1);
  if (step === 1)
    assert.equal(value.before.container_id, value.after.container_id);
  else assert.notEqual(value.before.container_id, value.after.container_id);
  const command = value.command_observation;
  assert.equal(command?.clock, "runner-wall");
  assert(
    Number.isSafeInteger(command.started_at_ms) && command.started_at_ms > 0,
  );
  assert(
    Number.isSafeInteger(command.returned_at_ms) &&
      command.returned_at_ms >= command.started_at_ms,
  );
  if (previous) {
    assert.equal(value.image_id, previous.deployment.image_id);
    assert.deepEqual(value.before, previous.deployment.after);
    assert(
      command.started_at_ms >=
        previous.deployment.command_observation.returned_at_ms,
    );
  }
  return value;
}

export async function requestIdentitySessionTransition(
  step,
  previous,
  {
    directory = "/checkpoints",
    project = process.env.COMPOSE_PROJECT_NAME,
    runID = process.env.ANTNEST_E2E_RUN_ID,
    signal,
    read = readFile,
    observe = mark,
  } = {},
) {
  signal?.throwIfAborted();
  assert([1, 2, 3].includes(step));
  assert.equal(previous?.deployment.step ?? 0, step - 1);
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  directory = durablePath(directory);
  const ackPath = durablePath(join(directory, `done-${step}`));
  let stale;
  try {
    stale = await lstat(ackPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert(!stale, "checkpoint ACK already exists before this fault request");
  const request = {
    version: 1,
    project,
    run_id: runID,
    step,
    nonce: randomUUID(),
  };
  const requested = observe();
  const temporary = join(directory, `.request-${step}-${request.nonce}`);
  try {
    await writeFile(temporary, JSON.stringify(request) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
    signal?.throwIfAborted();
    // A hard link publishes the complete marker atomically and refuses reuse.
    await link(temporary, join(directory, `request-${step}`));
  } finally {
    await rm(temporary, { force: true });
  }
  while (observe().at < requested.at + 90000) {
    signal?.throwIfAborted();
    let raw;
    try {
      const stat = await lstat(ackPath);
      assert(
        stat.isFile() && stat.size <= 16384,
        "invalid checkpoint ACK file",
      );
      const timeout = Math.ceil(requested.at + 90000 - observe().at);
      assert(timeout > 0, "checkpoint read deadline elapsed");
      const deadline = AbortSignal.timeout(timeout);
      raw = await read(ackPath, {
        encoding: "utf8",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(100, undefined, { signal });
      continue;
    }
    const deployment = checkedAcknowledgement(
      JSON.parse(raw),
      request,
      previous,
    );
    signal?.throwIfAborted();
    const acknowledged = observe();
    assert(
      acknowledged.at < requested.at + 90000,
      "checkpoint read completed after deadline",
    );
    return {
      deployment,
      observation: { clock: "session-client", requested, acknowledged },
    };
  }
  throw new Error(`Identity Session checkpoint ${step} timed out`);
}
