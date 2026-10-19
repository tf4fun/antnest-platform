import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { assertUnchanged } from "../identity-closeout/agent-access-evidence.mjs";

export async function snapshotC4Execution(fixture, model) {
  const page = await fixture.json(
    `/api/admin/execution-audits?agent_id=${encodeURIComponent(fixture.agentID)}&limit=100`,
  );
  assert(
    page.next_cursor === null && Array.isArray(page.items),
    "complete C4 Run inventory required",
  );
  const all = [],
    ids = new Set();
  for (const row of page.items) {
    assert(
      typeof row.run_id === "string" && row.run_id && !ids.has(row.run_id),
      "unique C4 Run inventory required",
    );
    assert(
      row.agent_id === fixture.agentID,
      "foreign Agent in C4 Run inventory",
    );
    ids.add(row.run_id);
    const path = `/api/admin/execution-audits/${encodeURIComponent(row.run_id)}`;
    const run = await fixture.json(path),
      events = await fixture.json(`${path}/events?limit=100`);
    assert(
      run.run_id === row.run_id && run.agent_id === fixture.agentID,
      "C4 audit detail belongs to another Run",
    );
    assert(
      events.next_cursor === null &&
        events.stream === "execution" &&
        Array.isArray(events.items),
      "complete C4 event inventory required",
    );
    all.push({ run, events });
  }
  const status = await model();
  assert(
    Array.isArray(status.requests) &&
      Array.isArray(status.pending) &&
      Array.isArray(status.errors),
    "complete C4 model inventory required",
  );
  assert(
    status.pending.length === 0 && status.errors.length === 0,
    "C4 model must be quiescent without errors",
  );
  return structuredClone({
    audits: { page, all },
    model: {
      requests: status.requests,
      pending: status.pending,
      errors: status.errors,
    },
  });
}

export function assertC4NoNewExecution(before, after) {
  for (const value of [before, after])
    assert(
      value &&
        Array.isArray(value.audits?.page?.items) &&
        Array.isArray(value.audits.all) &&
        Array.isArray(value.model?.requests) &&
        Array.isArray(value.model.pending) &&
        Array.isArray(value.model.errors),
      "complete C4 before/after execution inventories required",
    );
  assertUnchanged(before, after);
}

const probed = new WeakSet();

export async function rejectC4Prompt({
  context,
  gateway,
  observer,
  point,
  selectedView,
  signal,
  evidence,
}) {
  signal?.throwIfAborted();
  const closure = await observer.waitForRemoteEnd(point);
  assert(
    new URL(gateway).origin === point.stream.origin,
    "C4 denial target differs from the original page Gateway origin",
  );
  const cookie = observer.originalCookie(point),
    authority = gatewaySessionCookies(cookie);
  assert(
    !probed.has(point),
    "one C4 denial probe per original page closure required",
  );
  assert(
    authority.accessToken && authority.csrf,
    "original C4 page authority required",
  );
  assert(
    selectedView?.agentId === point.agentId &&
      selectedView.sessionId === point.sessionId,
    "C4 denial view belongs to another Agent or Session",
  );
  assert(
    typeof selectedView.historyToken === "string" &&
      selectedView.historyToken.length > 0,
    "original C4 history token required",
  );
  assert(
    Number.isSafeInteger(selectedView.appendVersion) &&
      selectedView.appendVersion >= 0,
    "original C4 append version required",
  );
  signal?.throwIfAborted();
  const intentId = randomUUID();
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(point.agentId)}/sessions/${encodeURIComponent(point.sessionId)}/prompts`;
  const requestBody = {
    intentId,
    expectedAppendVersion: selectedView.appendVersion,
    prompt: [{ type: "text", text: "denied-must-not-run" }],
  };
  const headers = {
    "If-Match": selectedView.historyToken,
    "Idempotency-Key": intentId,
  };
  Object.assign(evidence, {
    method: "POST",
    path,
    intentId,
    credentialScope: closure.credentialScope,
    request: structuredClone({ headers, body: requestBody }),
    startedMono: performance.now(),
    startedAt: Date.now(),
    requestTimeoutMs: 5000,
  });
  probed.add(point);
  try {
    const response = await gatewayBrowserRequest(
      context,
      new URL(path, gateway).href,
      {
        method: "POST",
        timeout: 5000,
        failOnStatusCode: false,
        headers: {
          ...headers,
          Cookie: cookie,
          "X-Antnest-CSRF-Token": authority.csrf,
          Origin: gatewayOrigin(gateway),
        },
        data: requestBody,
      },
    );
    const received = new Headers(
      (await response.headersArray()).map(({ name, value }) => [name, value]),
    );
    const directives = new Set(
      (received.get("cache-control") ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim()),
    );
    Object.assign(evidence, {
      status: response.status(),
      traceID: received.get("x-antnest-trace-id"),
      serverDate: received.get("date"),
      setCookieCount: received.getSetCookie().length,
      noStore: directives.size === 1 && directives.has("no-store"),
    });
    evidence.rawBody = await response.text();
    evidence.completedMono = performance.now();
    evidence.completedAt = Date.now();
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted && error !== signal.reason)
      throw new AggregateError(
        [error, signal.reason],
        "C4 denial request failed during interruption",
      );
    throw error;
  }
  assert(
    [401, 403].includes(evidence.status),
    "C4 revoked Prompt must be denied",
  );
  assert(
    evidence.noStore && evidence.setCookieCount === 0,
    "C4 denial must not cache or rotate authority",
  );
  assert(
    /^(?!0{32}$)[a-f0-9]{32}$/u.test(evidence.traceID ?? ""),
    "original C4 denial Trace required",
  );
  const date = Date.parse(evidence.serverDate);
  assert(
    Number.isFinite(date) &&
      new Date(date).toUTCString() === evidence.serverDate,
    "original C4 denial Date required",
  );
  try {
    evidence.body = JSON.parse(evidence.rawBody);
  } catch {
    throw new Error("C4 denial response must contain valid JSON");
  }
  assertC4DenialBody(evidence.body, evidence.status);
  evidence.code = evidence.body.code;
  return evidence;
}

export function assertC4DenialBody(body, status) {
  assert([401, 403].includes(status), "C4 revoked Prompt must be denied");
  assert(
    body && typeof body === "object" && !Array.isArray(body),
    "C4 denial response must be an object",
  );
  if (status === 403) {
    assert(
      typeof body.requestId === "string" && body.requestId.length > 0,
      "C4 denied Agent request ID required",
    );
    assert(
      Object.keys(body).length === 5 &&
        body.code === "access_denied" &&
        body.message === "Agent access denied" &&
        body.retryable === false &&
        body.recovery === "none",
      "C4 Agent denial differs from its contract",
    );
  } else {
    assert(
      Object.keys(body).length === 2 &&
        body.code === "unauthenticated" &&
        body.message === "Session is invalid or expired",
      "C4 identity denial differs from its contract",
    );
  }
}

export function c4OffboardingExpected({
  before,
  after,
  traceID,
  agentId,
  ownerId,
}) {
  for (const page of [before, after])
    assert(
      Array.isArray(page?.events) && page.events.length < 100,
      "complete C4 lifecycle event inventory required",
    );
  const old = new Set(before.events.map((event) => event.event_id));
  const added = after.events.filter((event) => !old.has(event.event_id));
  const select = (type) => {
    const matches = added.filter((event) => event.event_type === type);
    assert(matches.length === 1, "one original C4 offboarding event required");
    const event = matches[0];
    assert(
      event.agent_id === agentId && event.trace_id === traceID,
      "C4 offboarding event belongs to another Agent or mutation",
    );
    return structuredClone(event);
  };
  const owner = select("agent_owner_revoked"),
    disabled = select("agent_disabled");
  assert(
    typeof disabled.operation_request_id === "string" &&
      disabled.operation_request_id.length > 0,
    "C4 Disable operation required",
  );
  return {
    sourceID: traceID,
    traceID,
    agentID: agentId,
    requestID: disabled.operation_request_id,
    settlementOutcome: "settled",
    ownerRevocation: {
      event: owner,
      ownerUserID: ownerId,
      organizationID: "",
      reason: "user_deactivated",
    },
    disabledEvent: disabled,
  };
}
