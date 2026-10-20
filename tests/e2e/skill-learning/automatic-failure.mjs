import assert from "node:assert/strict";
import { responseFailure } from "../identity-closeout/request-failure.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";

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

// Observe existing browser responses synchronously. Never read a body, issue a
// request or change the business wait; retain only bounded diagnostic receipts.
export function observeLearningBrowserViews(
  page,
  { gateway, agentId, mode, now = Date.now },
) {
  const expected = new URL(
    `/api/app/workspace/v1/agents/${agentId}/view`,
    gateway,
  );
  let responses = 0,
    observationFailures = 0,
    first,
    firstFailure,
    last;
  const outcomes = {};
  const observe = (response) => {
    try {
      const url = new URL(response.url());
      if (
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        response.request().method() !== "GET"
      )
        return;
      const status = response.status();
      assert(Number.isInteger(status) && status >= 100 && status <= 599);
      const id = response.headers()["x-antnest-trace-id"];
      const receipt = {
        status: "skill_learning_view_response",
        mode,
        method: "GET",
        operation: "agent_view",
        agent_id: agentId,
        trace_id:
          typeof id === "string" && traceID.test(id) && !/^0+$/u.test(id)
            ? id
            : null,
        http_status: status,
        observed_at: now(),
      };
      responses++;
      outcomes[status] = (outcomes[status] ?? 0) + 1;
      first ??= receipt;
      if (status !== 200) firstFailure ??= receipt;
      last = receipt;
    } catch {
      observationFailures++;
    }
  };
  page.on("response", observe);
  return {
    stop() {
      page.off("response", observe);
      return structuredClone({
        diagnostic_only: true,
        response_count: responses,
        observation_failures: observationFailures,
        outcomes,
        samples: [...new Set([first, firstFailure, last])].filter(Boolean),
      });
    },
  };
}

function notice(value) {
  if (!kinds.has(value?.kind) || !changeID.test(value?.changeId ?? ""))
    return null;
  return { kind: value.kind, change_id: value.changeId };
}

export function learningViewReceipt(
  { status, traceID: id, text },
  { mode, agentId, sessionId, requestedAt, now = Date.now },
) {
  let availability;
  try {
    const value = JSON.parse(text)?.availability;
    availability =
      value === undefined
        ? "missing"
        : ["ready", "busy", "offline"].includes(value)
          ? value
          : "unrecognized";
  } catch {
    availability = "invalid_json";
  }
  return {
    status: "skill_learning_view_response",
    mode,
    method: "GET",
    operation: "agent_view",
    agent_id: agentId,
    session_id: sessionId,
    requested_at: requestedAt,
    observed_at: now(),
    ...responseFailure({ status, headers: { get: () => id } }, text, 200),
    availability,
  };
}

// Observe the existing poll only. Keep all outcome counts and at most four
// original samples; diagnostic Trace queries must not grow with poll count.
export function createLearningReadinessProbe(context) {
  const now = context.now ?? Date.now;
  let attempts = 0,
    responses = 0,
    requestFailures = 0,
    first,
    firstFailure,
    firstNotReady,
    last;
  const outcomes = {};
  return {
    async check(request) {
      const attempt = ++attempts,
        requestedAt = now();
      let receipt, failure;
      try {
        const view = await request((response) => {
          receipt = learningViewReceipt(response, {
            ...context,
            requestedAt,
            now,
          });
        });
        return view.body.availability === "ready";
      } catch (error) {
        failure = summarizeFailure(error);
        requestFailures++;
        return false;
      } finally {
        if (receipt) responses++;
        const sample = {
          attempt,
          ...(receipt ?? {
            status: failure
              ? "skill_learning_readiness_request_failed"
              : "skill_learning_readiness_response_unobserved",
            mode: context.mode,
            method: "GET",
            operation: "agent_view",
            agent_id: context.agentId,
            requested_at: requestedAt,
            observed_at: now(),
          }),
          ...(failure ? { request_failure: failure } : {}),
        };
        const outcome = receipt
          ? receipt.http_status === 200
            ? receipt.availability
            : "http_failure"
          : failure
            ? "transport_failure"
            : "unobserved_response";
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        first ??= sample;
        if (failure) firstFailure ??= sample;
        if (receipt?.http_status === 200 && receipt.availability !== "ready")
          firstNotReady ??= sample;
        last = sample;
      }
    },
    snapshot() {
      return structuredClone({
        diagnostic_only: true,
        attempts,
        response_count: responses,
        request_failures: requestFailures,
        outcomes,
        samples: [...new Set([first, firstFailure, firstNotReady, last])]
          .filter(Boolean)
          .sort((a, b) => a.attempt - b.attempt),
      });
    },
  };
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
  searchImpl = searchJaegerTraces,
}) {
  const ids = new Map();
  let records = 0,
    unobserved = 0,
    views = 0;
  for (const line of logs.split("\n")) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const view = value?.status === "skill_learning_view_response";
    if (!view && value?.status !== "skill_learning_client_failed") continue;
    records++;
    if (view) views++;
    const id = view ? value.trace_id : value.connection_trace_id;
    if (traceID.test(id ?? "") && !/^0+$/u.test(id)) {
      if (!ids.has(id)) ids.set(id, new Set());
      ids
        .get(id)
        .add(
          view
            ? value.http_status === 200
              ? "view_success"
              : "view_failure"
            : "private_connection",
        );
    } else unobserved++;
  }
  assert(ids.size <= 32, "too many learning diagnostic traces");
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
  for (const [id, sources] of ids) {
    const item = {
      trace_id: id,
      sources: [...sources],
      status: "unavailable",
    };
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
  if (views) {
    // Close spans are independent roots and carry no Agent scope attribute.
    // Preserve candidates for exact initialization Link/process review; a
    // service/operation search alone must never claim owner attribution.
    result.close_search = {
      status: "unavailable",
      ownership: "unattributed",
    };
    let stage = "query";
    try {
      const candidates = await searchImpl(
        jaeger,
        new URLSearchParams({
          service: "agent-ui",
          operation: "agent_ui.acp.close",
          lookback: "1h",
          limit: "100",
        }),
        { signal, fetchImpl },
      );
      stage = "archive";
      await save("view-close-candidates.json", candidates);
      result.close_search.status = candidates.length ? "captured" : "empty";
      result.close_search.count = candidates.length;
    } catch {
      result.close_search.failure_stage = stage;
    }
  }
  await save("stream-failure-index.json", result);
  return result;
}
