import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, message) =>
  assert(condition, "Invalid Stage3 Logout business evidence: " + message);
const record = (value, message) => {
  check(isRecord(value), message);
  return value;
};
const identifier = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/\s/u.test(value);
const finite = (value) => Number.isFinite(value) && value >= 0;

function httpDate(value) {
  check(typeof value === "string", "original HTTP Date missing");
  const parsed = Date.parse(value);
  check(
    Number.isFinite(parsed) && new Date(parsed).toUTCString() === value,
    "invalid original HTTP Date",
  );
}

function httpObservation(value) {
  record(value, "original HTTP response missing");
  for (const key of [
    "startedAt",
    "completedAt",
    "startedMono",
    "completedMono",
  ])
    check(finite(value[key]), "original HTTP observation time missing");
  check(
    value.startedAt <= value.completedAt &&
      value.startedMono <= value.completedMono,
    "HTTP response preceded its original dispatch",
  );
  httpDate(value.serverDate);
}

function sdkInventory(expected, point) {
  check(
    Array.isArray(point.sdkRequests) && point.sdkRequests.length === 2,
    "original initialize and Session creation inventory missing",
  );
  check(
    point.sdkRequests.every(
      (row) => isRecord(row) && identifier(row.requestId),
    ),
    "original SDK request identity missing",
  );
  check(
    point.sdkRequests[0].method === "initialize" &&
      point.sdkRequests[1].method === "session/new" &&
      point.sdkRequests[0].requestId !== point.sdkRequests[1].requestId,
    "original SDK request inventory changed",
  );
  check(
    isDeepStrictEqual(expected.sdkRequests, point.sdkRequests),
    "silent observation sent or changed an SDK request",
  );
  check(
    Number.isSafeInteger(point.browserRequests) && point.browserRequests >= 0,
    "original browser request count missing",
  );
}

function streamObservation(stream, point, expected) {
  check(
    stream.path ===
      `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/events?sessionId=${encodeURIComponent(expected.sessionId)}`,
    "original SSE scope changed",
  );
  check(stream.status === 200, "original SSE did not succeed");
  check(stream.set_cookie_count === 0, "original SSE changed browser Cookies");
  check(
    stream.credential_scope === expected.credentialScope,
    "original SSE Cookie scope changed",
  );
  for (const key of ["started_at", "started_at_ms", "headers_at"])
    check(finite(stream[key]), "original SSE observation time missing");
  check(
    stream.started_at <= stream.headers_at &&
      stream.headers_at <= point.at &&
      stream.started_at_ms <= point.observed_at_ms,
    "original SSE admission outside checkpoint",
  );
  httpDate(stream.server_date);
  check(
    Array.isArray(stream.frames) &&
      stream.frames.length > 0 &&
      stream.frames.some(
        (frame) => typeof frame?.raw === "string" && frame.raw.length > 0,
      ),
    "original SSE bytes missing",
  );
  let previous = stream.headers_at;
  for (const frame of stream.frames) {
    record(frame, "original SSE byte receipt missing");
    check(
      finite(frame.at) &&
        frame.at >= previous &&
        frame.at <= point.at &&
        typeof frame.raw === "string",
      "invalid original SSE byte receipt",
    );
    previous = frame.at;
  }
  check(
    Array.isArray(stream.events) && stream.events.length > 0,
    "original scoped SSE events missing",
  );
  previous = stream.headers_at;
  let scopedView = false;
  for (const event of stream.events) {
    record(event, "original SSE event receipt missing");
    check(
      finite(event.at) && event.at >= previous && event.at <= point.at,
      "SSE event outside original checkpoint",
    );
    previous = event.at;
    const raw = record(event.raw, "original SSE event body missing");
    check(raw.agentId === expected.agentId, "foreign observed Agent");
    check(
      ["snapshot", "reset", "delta"].includes(raw.type) &&
        ["view", "ignore"].includes(event.action),
      "original SSE observation was not live",
    );
    if (raw.type === "delta") {
      check(
        raw.sessionId === expected.sessionId,
        "foreign observed delta Session",
      );
      continue;
    }
    const view = record(raw.view, "original scoped Agent View missing");
    const selected = record(
      view.selectedView,
      "original selected Session missing",
    );
    check(
      view.agentId === expected.agentId &&
        view.selectedSessionId === expected.sessionId &&
        selected.agentId === expected.agentId &&
        selected.sessionId === expected.sessionId,
      "foreign observed Agent or Session",
    );
    if (event.action === "view") scopedView = true;
  }
  check(scopedView, "original SSE never established its scoped View");
}

// Validate original browser HTTP and observer receipts independently of any
// auxiliary collection. No claim about a feed, private owner or SQL commit is
// manufactured from these observations.
export function inspectStage3LogoutBusiness(expected) {
  record(expected, "original Logout observation missing");
  check(!Object.hasOwn(expected, "pageOwned"), "different browser observer");
  check(
    expected.transport === "http-sse",
    "original browser transport missing",
  );
  check(
    [1, 2].includes(expected.protocolVersion),
    "unsupported protocol version",
  );
  check(
    identifier(expected.agentId) && identifier(expected.sessionId),
    "original Agent or Session missing",
  );
  check(
    typeof expected.credentialScope === "string" &&
      uuid.test(expected.credentialScope),
    "original Cookie scope missing",
  );
  check(expected.reason === "revoked", "different authority-loss reason");
  check(expected.silent === true, "observation was not silent");
  check(
    expected.localClose === false,
    "local close cannot prove remote closure",
  );
  check(
    expected.protocolClientClosedLocally === true,
    "actual protocol client cleanup did not join",
  );
  const point = record(expected.checkpoint, "original checkpoint missing");
  const closure = record(expected.closure, "original remote closure missing");
  const stream = record(point.stream, "original SSE response missing");
  check(
    point.agentId === expected.agentId &&
      point.sessionId === expected.sessionId &&
      point.reason === expected.reason,
    "checkpoint belongs to another scope or fault",
  );
  for (const value of [
    point.at,
    point.observed_at_ms,
    point.expiresAt,
    point.idleExpiresAt,
    closure.at,
    closure.observed_at_ms,
  ])
    check(finite(value), "original observer time missing");
  check(
    point.expiresAt > 0 && point.idleExpiresAt > 0,
    "original Session lifetime missing",
  );
  check(
    ["remote-end", "transport-end"].includes(closure.kind),
    "local cancellation or error cannot prove remote closure",
  );
  check(
    closure.at >= point.at &&
      closure.at <= point.at + 30_000 &&
      closure.observed_at_ms >= point.observed_at_ms &&
      closure.observed_at_ms <= point.observed_at_ms + 30_000,
    "remote closure outside the original 30-second bound",
  );
  check(
    expected.startedAt === point.observed_at_ms &&
      expected.closedAt === closure.observed_at_ms,
    "original observer wall-clock identity changed",
  );
  const issuance = record(point.issuance, "original login observation missing");
  check(
    finite(issuance.startedMono) &&
      finite(issuance.completedMono) &&
      issuance.startedMono <= issuance.completedMono &&
      issuance.completedMono <= stream.started_at,
    "original login followed SSE admission",
  );
  streamObservation(stream, point, expected);
  sdkInventory(expected, point);

  const principal = record(expected.principal, "original Principal missing");
  for (const key of ["organization_id", "user_id", "membership_id"])
    check(identifier(principal[key]), "original Principal identity missing");
  const cause = record(expected.cause, "original Logout HTTP response missing");
  httpObservation(cause);
  check(
    cause.kind === "logout" &&
      cause.method === "DELETE" &&
      cause.path === "/api/session" &&
      cause.status === 204,
    "actual Logout DELETE did not complete with 204",
  );
  check(
    cause.credentialScope === expected.credentialScope &&
      isDeepStrictEqual(cause.principal, principal),
    "Logout changed the original browser authority",
  );
  const denial = record(expected.denial, "original Prompt denial missing");
  httpObservation(denial);
  check(
    denial.method === "POST" &&
      denial.path ===
        `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/sessions/${encodeURIComponent(expected.sessionId)}/prompts` &&
      denial.status === 401 &&
      denial.code === "unauthenticated",
    "actual same-Session Prompt was not denied with 401",
  );
  check(
    denial.credentialScope === expected.credentialScope &&
      denial.noStore === true &&
      denial.setCookieCount === 0 &&
      typeof denial.intentId === "string" &&
      uuid.test(denial.intentId),
    "Prompt denial changed the original Cookie or request contract",
  );
  check(
    point.at <= cause.startedMono &&
      cause.startedMono <= closure.at &&
      cause.completedMono <= denial.startedMono &&
      closure.at <= denial.startedMono &&
      point.observed_at_ms <= cause.startedAt &&
      cause.startedAt <= closure.observed_at_ms &&
      cause.completedAt <= denial.startedAt &&
      closure.observed_at_ms <= denial.startedAt,
    "checkpoint, Logout, remote EOF and denial are out of order",
  );
  return {
    business: "passed",
    protocol_version: expected.protocolVersion,
    agent_id: expected.agentId,
    session_id: expected.sessionId,
    denial_status: 401,
  };
}
