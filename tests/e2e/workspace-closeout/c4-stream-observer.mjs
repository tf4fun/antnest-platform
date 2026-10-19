import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";

const now = () => ({ at: performance.now(), observed_at_ms: Date.now() });
const tracePattern = /^(?!0{32}$)[a-f0-9]{32}$/u;
const transportKind = (failure) =>
  failure === null
    ? "remote-end"
    : failure?.errorText === "net::ERR_INCOMPLETE_CHUNKED_ENCODING"
      ? "transport-end"
      : "transport-failure";

// Observe the page's actual EventSource. This recorder does not open a stream,
// modify browser APIs, read the response body or close any browser resource.
export function observeC4PageStreams(page, { gateway, agentId, signal }) {
  const origin = new URL(gateway).origin;
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/events`;
  const rows = new Map(),
    tasks = new Set(),
    errors = [],
    points = new WeakMap();
  let disposed = false,
    closing,
    triggered = false;

  const schedule = (work) => {
    const task = Promise.resolve().then(work);
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      (error) => {
        errors.push(error);
        tasks.delete(task);
      },
    );
  };
  async function joined() {
    while (tasks.size) await Promise.allSettled([...tasks]);
    const failures = [...errors];
    if (failures.length && signal?.aborted && !failures.includes(signal.reason))
      failures.push(signal.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "C4 page observation failed");
  }
  const finish = (row, kind, extra = {}) => {
    row.closure ??= Object.freeze({ kind, ...now(), ...extra });
  };
  const requested = (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      url.pathname !== path ||
      request.method() !== "GET" ||
      request.resourceType() !== "eventsource"
    )
      return;
    if (request.frame() !== page.mainFrame()) return;
    const mark = now();
    rows.set(request, {
      request,
      url,
      sessionId: url.searchParams.get("sessionId"),
      evidence: {
        origin: url.origin,
        path: url.pathname + url.search,
        started_at: mark.at,
        started_at_ms: mark.observed_at_ms,
      },
    });
  };
  const responded = (response) => {
    const row = rows.get(response.request());
    if (!row) return;
    const mark = now();
    row.evidence.status = response.status();
    row.evidence.headers_at = mark.at;
    row.evidence.headers_at_ms = mark.observed_at_ms;
    schedule(async () => {
      const headers = await row.request.allHeaders();
      row.cookie = headers.cookie ?? "";
    });
    schedule(async () => {
      const headers = await response.headersArray();
      const values = (name) =>
        headers
          .filter((header) => header.name.toLowerCase() === name)
          .map((header) => header.value);
      const single = (name) => {
        const found = values(name);
        return found.length === 1 ? found[0] : null;
      };
      row.evidence.trace_id = single("x-antnest-trace-id");
      row.evidence.server_date = single("date");
      row.evidence.content_type = single("content-type");
      row.evidence.set_cookie_count = values("set-cookie").length;
      row.headersReady = true;
    });
  };
  const finished = (request) => {
    const row = rows.get(request);
    if (row)
      finish(row, transportKind(request.failure()), {
        failure: request.failure(),
      });
  };
  const failed = (request) => {
    const row = rows.get(request);
    if (row)
      finish(row, transportKind(request.failure()), {
        failure: request.failure(),
      });
  };
  const local = (kind) => {
    for (const row of rows.values()) if (!row.closure) finish(row, kind);
  };
  const pageClosed = () => local("local-page-close");
  const navigated = (frame) => {
    if (frame === page.mainFrame()) local("local-navigation");
  };
  const handlers = {
    request: requested,
    response: responded,
    requestfinished: finished,
    requestfailed: failed,
    close: pageClosed,
    framenavigated: navigated,
  };
  for (const [name, handler] of Object.entries(handlers))
    page.on(name, handler);

  const original = (point) => {
    const entry = points.get(point);
    assert(entry, "original C4 page checkpoint required");
    return entry;
  };
  return {
    get records() {
      return [...rows.values()].map((row) => ({
        ...row.evidence,
        ...(row.closure
          ? { closure: { ...row.closure, trace_id: row.evidence.trace_id } }
          : {}),
      }));
    },
    async checkpoint({ sessionId, cookies, timeoutMs = 15000 }) {
      signal?.throwIfAborted();
      assert(
        !disposed && !triggered,
        "C4 page observer disposed or already triggered",
      );
      assert(typeof sessionId === "string" && sessionId.length > 0);
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
      const authority = gatewaySessionCookies(cookies);
      assert(
        authority.accessToken && authority.csrf,
        "complete original browser authority required",
      );
      const deadline = performance.now() + timeoutMs;
      let row;
      for (;;) {
        await joined();
        signal?.throwIfAborted();
        assert(!disposed, "C4 page observer disposed before trigger");
        const matching = [...rows.values()].filter(
          (value) => value.sessionId === sessionId,
        );
        const live = matching.filter((value) => !value.closure);
        assert(live.length <= 1, "ambiguous live C4 page streams");
        row = live[0];
        if (row?.headersReady && row.cookie !== undefined) break;
        assert(
          !matching.length || live.length > 0,
          "C4 page stream ended before its trigger",
        );
        assert(
          performance.now() < deadline,
          "C4 page stream is not live before its trigger",
        );
        await delay(10, undefined, { signal });
      }
      assert.equal(row.url.searchParams.getAll("sessionId").length, 1);
      assert.equal(row.evidence.status, 200, "C4 page SSE admission failed");
      assert.match(row.evidence.content_type ?? "", /^text\/event-stream\b/u);
      assert.match(row.evidence.trace_id ?? "", tracePattern);
      const date = Date.parse(row.evidence.server_date);
      assert(
        Number.isFinite(date) &&
          new Date(date).toUTCString() === row.evidence.server_date,
        "original C4 SSE Date required",
      );
      assert.equal(
        row.evidence.set_cookie_count,
        0,
        "C4 page SSE must not rotate browser authority",
      );
      const sent = gatewaySessionCookies(row.cookie);
      assert(
        Object.keys(authority).every(
          (field) => sent[field] === authority[field],
        ),
        "C4 page stream changed browser authority",
      );
      assert(
        !row.closure && !page.isClosed(),
        "C4 page stream ended before its trigger",
      );
      const credentialScope = randomUUID();
      const stream = Object.freeze({
        ...row.evidence,
        credential_scope: credentialScope,
      });
      const point = Object.freeze({
        ...now(),
        agentId,
        sessionId,
        reason: "revoked",
        stream,
      });
      points.set(point, { row, cookie: row.cookie });
      triggered = true;
      return point;
    },
    originalCookie(point) {
      return original(point).cookie;
    },
    async waitForRemoteEnd(point, { timeoutMs = 30000 } = {}) {
      const entry = original(point),
        { row } = entry;
      signal?.throwIfAborted();
      if (entry.result) return entry.result;
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
      for (;;) {
        await joined();
        signal?.throwIfAborted();
        assert(!disposed, "C4 page observer disposed before remote EOF");
        if (row.closure) break;
        assert(
          performance.now() < point.at + timeoutMs,
          "C4 page remote EOF deadline exceeded",
        );
        await delay(10, undefined, { signal });
      }
      assert(
        ["remote-end", "transport-end"].includes(row.closure.kind),
        "C4 requires an original remote close before local cleanup or unrelated transport failure",
      );
      assert(
        row.closure.at >= point.at && row.closure.at <= point.at + timeoutMs,
        "C4 remote EOF outside trigger window",
      );
      assert(
        row.closure.observed_at_ms >= point.observed_at_ms &&
          row.closure.observed_at_ms <= point.observed_at_ms + timeoutMs,
        "C4 remote EOF outside wall-clock trigger window",
      );
      assert.equal(row.evidence.trace_id, point.stream.trace_id);
      const closure = Object.freeze({
        ...row.closure,
        trace_id: row.evidence.trace_id,
      });
      entry.result = Object.freeze({
        transport: "http-sse",
        pageOwned: true,
        agentId,
        sessionId: point.sessionId,
        traceID: point.stream.trace_id,
        credentialScope: point.stream.credential_scope,
        reason: "revoked",
        startedAt: point.observed_at_ms,
        closedAt: closure.observed_at_ms,
        checkpoint: point,
        closure,
        localClose: false,
        authorizationCauseVerified: false,
      });
      return entry.result;
    },
    closeAndWait() {
      return (closing ??= (async () => {
        disposed = true;
        local("observer-disposed");
        for (const [name, handler] of Object.entries(handlers))
          page.off(name, handler);
        await joined();
      })());
    },
  };
}
