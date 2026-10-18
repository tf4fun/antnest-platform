import assert from "node:assert/strict";

const traceID = /^[a-f0-9]{32}$/u;
const changeID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const kinds = new Set(["skill_created", "skill_updated"]);
const closeReasons = new Set([
  "identity_unavailable",
  "session_rejected",
  "caller_context_expired",
  "connection_closed",
  "relay_capacity",
]);

export async function collectLearningFailureEvidence(error, captures) {
  const errors = [error];
  for (const capture of captures) {
    try {
      await capture();
    } catch (captureError) {
      errors.push(captureError);
    }
  }
  if (errors.length === 1) throw error;
  throw new AggregateError(
    errors,
    "Learning failure evidence could not be captured",
  );
}

function notice(value) {
  if (!kinds.has(value?.kind) || !changeID.test(value?.changeId ?? ""))
    return null;
  return { kind: value.kind, change_id: value.changeId };
}

// Keep protocol receipts, never prompts, chunks, cookies or free-form notices.
// This snapshot is taken before the client's local finally-close.
export async function learningClientFailure(
  client,
  { phase, startedAt, persistedNotice, now = Date.now },
) {
  let close = null;
  if (client.closeCode !== undefined) {
    const event = await client.waitForClose(1);
    close = {
      code: event.code,
      reason: closeReasons.has(event.reason) ? event.reason : "unrecognized",
      at: event.at,
      localClose: event.localClose,
    };
  }
  const persisted = notice(persistedNotice);
  const connectionTraceID =
    client.boundary === "private-acp"
      ? client.connectionTraceID
      : client.observedConnectionTraceID;
  return {
    status: "skill_learning_client_failed",
    phase,
    started_at: startedAt,
    observed_at: now(),
    connection_trace_id: traceID.test(connectionTraceID ?? "")
      ? connectionTraceID
      : null,
    close,
    update_count: client.updates.length,
    live_notices: client.updates.flatMap((entry) => {
      if (entry.update?.sessionUpdate !== "notice") return [];
      const value = notice(entry.update?._meta?.["antnest.dev/skill-learning"]);
      return value ? [value] : [];
    }),
    persisted_notice: persisted
      ? { ...persisted, at: persistedNotice.at }
      : null,
  };
}

// One logical learning run can reconnect. Capture the innermost failing
// connection before its cleanup, and let outer scopes retain that same error.
export function learningFailureBoundary(emit) {
  let captured = false;
  return async (client, state, run) => {
    const errors = [];
    let result;
    try {
      result = await run();
    } catch (error) {
      errors.push(error);
      if (!captured) {
        captured = true;
        try {
          await emit(await learningClientFailure(client, state()));
        } catch (captureError) {
          errors.push(captureError);
        }
      }
    }
    try {
      await client.closeAndWait();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(
        errors,
        "Learning work, evidence or cleanup failed",
      );
    return result;
  };
}

// Read the failed connection's raw detail without claiming topology or business
// admission. Query failures remain explicit and do not replace the test failure.
export async function captureLearningFailureTraces({
  logs,
  jaeger,
  save,
  signal = AbortSignal.timeout(10000),
  fetchImpl = fetch,
}) {
  const ids = new Set();
  let records = 0,
    unobserved = 0;
  for (const line of logs.split("\n")) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.status !== "skill_learning_client_failed") continue;
    records++;
    if (traceID.test(value.connection_trace_id ?? ""))
      ids.add(value.connection_trace_id);
    else unobserved++;
  }
  assert(ids.size <= 32, "too many failed learning connections");
  const result = {
    diagnostic_only: true,
    discovery_status: ids.size
      ? "observed_trace"
      : records
        ? "no_observed_trace"
        : "no_record",
    record_count: records,
    unobserved_trace_count: unobserved,
    captures: [],
  };
  for (const id of ids) {
    const item = { trace_id: id, status: "unavailable" };
    let response,
      stage = "query";
    try {
      signal.throwIfAborted();
      response = await fetchImpl(new URL(`/api/traces/${id}`, jaeger), {
        signal,
      });
      item.http_status = response.status;
      stage = "response";
      assert(response.ok, "trace query failed");
      stage = "decode";
      const raw = await response.json();
      stage = "archive";
      await save(`stream-failure-${id}.json`, raw);
      stage = "validation";
      assert(
        raw.errors == null ||
          (Array.isArray(raw.errors) && raw.errors.length === 0),
      );
      assert(Array.isArray(raw.data) && raw.data.length === 1);
      assert.equal(raw.data[0].traceID, id);
      item.status = "captured";
    } catch {
      // The original exception belongs to the owning test. A failed diagnostic
      // query is an evidence gap, not a replacement business outcome.
      item.failure_stage = stage;
    } finally {
      if (response?.body && !response.bodyUsed) {
        try {
          await response.body.cancel();
        } catch {
          item.status = "unavailable";
          item.failure_stage ??= "cleanup";
          item.body_cleanup_failed = true;
        }
      }
    }
    result.captures.push(item);
  }
  await save("stream-failure-index.json", result);
  return result;
}
