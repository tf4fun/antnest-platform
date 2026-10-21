import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { inspect } from "node:util";
import { GatewayClient } from "./support.mjs";
import {
  reset,
  delta,
} from "../edge-gateway/resolve-cache-stream-fixtures.mjs";

const url = new URL("./bridge-session-observer.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t, override = {}) {
  const requests = [];
  const denialPending = Promise.withResolvers();
  const issuedBody = {
    principal: { organization_id: "org", user_id: "user" },
    expires_at: new Date(Date.now() + 120000).toISOString(),
    idle_expires_at: new Date(Date.now() + 120000).toISOString(),
  };
  let stream, observer, releaseDenial;
  const release = () => {
    const send = releaseDenial;
    releaseDenial = undefined;
    send?.();
  };
  const cookie = "antnest_session=original-session; antnest_csrf=original-csrf";
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const row = {
        path: request.url,
        method: request.method,
        cookie: request.headers.cookie,
        csrf: request.headers["x-antnest-csrf-token"],
        ifMatch: request.headers["if-match"],
        body: chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null,
      };
      requests.push(row);
      const boundary =
        request.url === "/api/session/login"
          ? "login"
          : request.method === "GET"
            ? "stream"
            : "denial";
      const traceID = Object.hasOwn(override.traces ?? {}, boundary)
        ? override.traces[boundary]
        : request.method === "GET" && Object.hasOwn(override, "streamTraceID")
          ? override.streamTraceID
          : request.method === "POST" &&
              Object.hasOwn(override, "denialTraceID")
            ? override.denialTraceID
            : (request.method === "GET" ? "a" : "b").repeat(32);
      if (traceID !== undefined && traceID !== null)
        response.setHeader("x-antnest-trace-id", traceID);
      response.setHeader("cache-control", "no-store");
      if (request.method === "POST" && request.url === "/api/session/login") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(issuedBody));
      } else if (
        request.method === "GET" &&
        request.url.endsWith("/events?sessionId=session-1")
      ) {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const initial = reset("session-1", 2);
        response.write(`event: reset\ndata: ${JSON.stringify(initial)}\n\n`);
      } else if (
        request.method === "DELETE" &&
        request.url === "/api/session"
      ) {
        response.setHeader("set-cookie", [
          "antnest_session=; Max-Age=0; Path=/",
          "antnest_csrf=; Max-Age=0; Path=/",
        ]);
        response.writeHead(204);
        response.end();
        if (override.accessRevoked) {
          const event = { ...delta(), type: "access_revoked" };
          stream.write(
            `event: access_revoked\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        stream.end();
      } else if (
        request.method === "POST" &&
        request.url.endsWith("/sessions/session-1/prompts")
      ) {
        const send = () => {
          response.setHeader("content-type", "application/json");
          if (override.cookie)
            response.setHeader(
              "set-cookie",
              "antnest_session=replaced; Path=/",
            );
          if (override.cache)
            response.setHeader("cache-control", override.cache);
          response.writeHead(override.status ?? 401);
          response.end(
            JSON.stringify(
              override.body ?? { code: override.code ?? "unauthenticated" },
            ),
          );
        };
        if (override.holdDenial) {
          releaseDenial = send;
          denialPending.resolve();
        } else send();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release();
    await observer?.closeAndWait().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const browser = new GatewayClient(
    `http://127.0.0.1:${server.address().port}`,
    { onStatusFailure: override.onStatusFailure },
  );
  browser.cookies = new Map([
    ["antnest_session", "original-session"],
    ["antnest_csrf", "original-csrf"],
  ]);
  const client = {
    requests: [
      { requestId: "1", method: "session/new", sessionId: "session-1" },
    ],
  };
  let issued = {
    ...issuedBody,
    observation: {
      startedMono: performance.now() - 10,
      completedMono: performance.now(),
      traceID: "c".repeat(32),
    },
  };
  if (override.actualLogin) {
    const startedMono = performance.now();
    const response = await browser.request("/api/session/login", { body: {} });
    issued = {
      ...response.body,
      observation: {
        startedMono,
        completedMono: performance.now(),
        traceID: response.traceID,
      },
    };
  }
  return {
    browser,
    client,
    issued,
    requests,
    cookie,
    denialPending: denialPending.promise,
    releaseDenial: release,
    endStream: () => stream.end(),
    async open({ signal, membershipRevocation, userRevocation } = {}) {
      assert.equal(typeof implementation.observeBrowserSession, "function");
      observer = await implementation.observeBrowserSession(browser, client, {
        agentId: "agent-1",
        sessionId: "session-1",
        issued,
        signal,
        membershipRevocation,
        userRevocation,
      });
      return observer;
    },
  };
}

const accessDenied = {
  code: "access_denied",
  message: "Agent access denied",
  retryable: false,
  recovery: "none",
  requestId: "request-1",
};
test("Membership-only observation accepts the exact downstream 403 with original credentials", async (t) => {
  const f = await fixture(t, { status: 403, body: accessDenied });
  const observer = await f.open({ membershipRevocation: true });
  const point = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  await observer.waitForClose(point);
  const result = await observer.rejectPrompt();
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, accessDenied);
  assert.equal(result.credentialScope, point.stream.credential_scope);
  assert.equal(observer.browser.requests, 1);
  assert(f.requests.every((r) => r.cookie === f.cookie));
  assert.equal(f.client.requests.length, 1);
});
for (const [name, override, membershipRevocation] of [
  ["other consumers retain 401", { status: 403, body: accessDenied }, false],
  [
    "Membership cannot accept 503",
    { status: 503, code: "identity_unavailable" },
    true,
  ],
  [
    "retryable denial",
    { status: 403, body: { ...accessDenied, retryable: true } },
    true,
  ],
  [
    "different code",
    { status: 403, body: { ...accessDenied, code: "forbidden" } },
    true,
  ],
  [
    "recovery instruction",
    { status: 403, body: { ...accessDenied, recovery: "retry" } },
    true,
  ],
  [
    "missing request ID",
    { status: 403, body: { ...accessDenied, requestId: undefined } },
    true,
  ],
])
  test("original denial probe rejects " + name, async (t) => {
    const f = await fixture(t, override);
    const observer = await f.open({ membershipRevocation });
    const point = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(point);
    await assert.rejects(() => observer.rejectPrompt());
    assert.equal(observer.browser.requests, 1);
  });

test("actual logout is separate from silent observation and the rejection keeps the original Cookie", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  const logout = await f.browser.request("/api/session", {
    method: "DELETE",
    status: 204,
  });
  assert.equal(logout.status, 204);
  assert.equal(f.browser.requests, 1);
  assert.equal(f.browser.cookie, "");
  const closure = await observer.waitForClose(checkpoint);
  assert.equal(closure.authorizationCauseVerified, false);
  assert.equal(observer.browser.requests, 0);
  assert.equal(observer.browser.cookie, f.cookie);
  const denial = await observer.rejectPrompt();
  assert.equal(denial.status, 401);
  assert.equal(denial.code, "unauthenticated");
  assert.equal(denial.credentialScope, closure.credentialScope);
  assert(denial.startedMono >= closure.closure.at);
  assert(denial.completedMono >= denial.startedMono);
  assert.equal(new Date(denial.serverDate).toUTCString(), denial.serverDate);
  assert.deepEqual(observer.principal, f.issued.principal);
  assert.deepEqual(checkpoint.issuance, f.issued.observation);
  assert.equal(observer.browser.requests, 1);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET", "DELETE", "POST"],
  );
  assert(f.requests.every((r) => r.cookie === f.cookie));
  const request = f.requests.at(-1);
  assert.equal(request.csrf, "original-csrf");
  assert.equal(request.ifMatch, "history");
  assert.equal(request.body.expectedAppendVersion, 1);
  assert.deepEqual(request.body.prompt, [
    { type: "text", text: "denied-must-not-run" },
  ]);
  assert.match(request.body.intentId, /^[a-f0-9-]{36}$/u);
  assert.equal(f.client.requests.length, 1);
  assert(
    !JSON.stringify({ checkpoint, closure, denial }).includes(
      "original-session",
    ),
  );
});

test("original Identity deadlines do not assume the observer's wall clock", async (t) => {
  const f = await fixture(t);
  f.issued.expires_at = new Date(Date.now() - 300000).toISOString();
  f.issued.idle_expires_at = f.issued.expires_at;
  const observer = await f.open();
  const point = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  assert.equal(
    (await observer.waitForClose(point)).authorizationCauseVerified,
    false,
  );
});

for (const recorderThrows of [false, true]) {
  test(`unexpected denial status reaches the original browser's failure recorder (recorder throws: ${recorderThrows})`, async (t) => {
    const failures = [];
    const f = await fixture(t, {
      status: 503,
      code: "identity_unavailable",
      onStatusFailure: async (failure) => {
        failures.push(failure);
        if (recorderThrows) throw new Error("private recorder failure");
      },
    });
    const observer = await f.open();
    const point = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(point);
    await assert.rejects(() => observer.rejectPrompt(), {
      code: "ERR_ASSERTION",
      actual: 503,
      expected: 401,
    });
    assert.deepEqual(failures, [
      {
        http_status: 503,
        expected_status: 401,
        trace_id: "b".repeat(32),
        response_code: "identity_unavailable",
      },
    ]);
    assert.equal(observer.browser.cookie, f.cookie);
    assert.equal(observer.browser.requests, 1);
  });
}

test("an actual denial cannot be probed before the remote close is observed", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  await assert.rejects(() => observer.rejectPrompt());
  assert.equal(f.requests.length, 1);
  assert.equal(observer.browser.requests, 0);
});

test("a revocation event may clear the displayed view without losing the original denial payload", async (t) => {
  const f = await fixture(t, { accessRevoked: true }),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  await observer.waitForClose(checkpoint);
  assert.equal(observer.stream.view, null);
  assert.equal((await observer.rejectPrompt()).status, 401);
  assert.equal(f.requests.at(-1).ifMatch, "history");
});

test("changed private Cookie authority is rejected without exposing it or sending a probe", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  await observer.waitForClose(checkpoint);
  observer.browser.cookies.set("antnest_session", "MUTATED-PRIVATE-CANARY");
  await assert.rejects(
    () => observer.rejectPrompt(),
    (error) => {
      assert(!String(error).includes("MUTATED-PRIVATE-CANARY"));
      assert(!String(error).includes("original-session"));
      return true;
    },
  );
  assert.equal(f.requests.length, 2);
});

for (const [label, override] of [
  ["unexpected status", { status: 200 }],
  ["wrong cause", { code: "workspace_unavailable" }],
  ["Cookie write", { cookie: true }],
  ["cacheable rejection", { cache: "private, max-age=60" }],
])
  test(`post-close rejection retains strict ${label} validation`, async (t) => {
    const f = await fixture(t, override),
      observer = await f.open();
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    await assert.rejects(() => observer.rejectPrompt());
    assert.equal(f.client.requests.length, 1);
  });

for (const [label, override] of [
  ["body code", { code: "PRIVATE-RESPONSE-CANARY" }],
  ["cache header", { cache: "PRIVATE-RESPONSE-CANARY" }],
])
  test(`invalid ${label} is rejected without exposing upstream content`, async (t) => {
    const f = await fixture(t, override),
      observer = await f.open();
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    await assert.rejects(
      () => observer.rejectPrompt(),
      (error) => {
        assert(
          !inspect(error, { depth: null })
            .toLowerCase()
            .includes("private-response-canary"),
        );
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(f.requests.at(-1).method, "POST");
  });

test(
  "cancellation while a denial is pending joins the actual request and preserves the abort reason",
  { timeout: 20000 },
  async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, { holdDenial: true }),
      observer = await f.open({ signal: controller.signal });
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    const pending = observer.rejectPrompt();
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await f.denialPending;
    const reason = new Error("caller cancelled the pending denial");
    controller.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the actual HTTP response must be joined");
    f.releaseDenial();
    await assert.rejects(pending, (error) => {
      assert.equal(error, reason);
      return true;
    });
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  },
);

for (const status of [401, 403])
  test(`global User observation keeps original authority for HTTP ${status}`, async (t) => {
    const f = await fixture(t, {
      status,
      ...(status === 403 ? { body: accessDenied } : {}),
    });
    const observer = await f.open({ userRevocation: true });
    const point = observer.checkpoint("revoked");
    f.endStream();
    const closed = await observer.waitForClose(point);
    assert.equal(closed.authorizationCauseVerified, false);
    const denial = await observer.rejectPrompt();
    assert.equal(denial.status, status);
    assert.equal(denial.credentialScope, point.stream.credential_scope);
    assert(f.requests.every((r) => r.cookie === f.cookie));
    assert.equal(f.requests.length, 2);
    assert.equal(f.browser.requests, 0);
    assert.equal(f.client.requests.length, 1);
  });
for (const options of [
  { userRevocation: true, membershipRevocation: true },
  { userRevocation: "true" },
  { membershipRevocation: "true" },
])
  test(`directory observation rejects ambiguous mode ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => f.open(options));
    assert.equal(f.requests.length, 0);
  });
test("global User observation cannot label an outage as revocation", async (t) => {
  const f = await fixture(t);
  const observer = await f.open({ userRevocation: true });
  assert.throws(() => observer.checkpoint("unavailable"));
});
test("global User observation rejects Identity unavailable as an authorization denial", async (t) => {
  const f = await fixture(t, { status: 503, code: "identity_unavailable" });
  const observer = await f.open({ userRevocation: true });
  const point = observer.checkpoint("revoked");
  f.endStream();
  await observer.waitForClose(point);
  await assert.rejects(() => observer.rejectPrompt());
});

const invalidTraceCanary = "PRIVATE-INVALID-TRACE-CANARY";
for (const [label, traceID] of [
  ["missing", undefined],
  ["invalid", invalidTraceCanary],
]) {
  test(`${label} login Trace ID does not block the original browser authority`, async (t) => {
    const f = await fixture(t);
    f.issued.observation.traceID = traceID;
    const observer = await f.open();
    const point = observer.checkpoint("revoked");
    assert.equal(point.issuance.traceID, undefined);
    assert.equal(point.issuance.traceDiagnostic, "missing_or_invalid_trace_id");
    assert.deepEqual(observer.principal, f.issued.principal);
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    const closure = await observer.waitForClose(point);
    const denial = await observer.rejectPrompt();
    assert.equal(closure.localClose, false);
    assert.equal(closure.silent, true);
    assert.equal(denial.status, 401);
    assert.equal(denial.code, "unauthenticated");
    assert.equal(denial.credentialScope, point.stream.credential_scope);
    assert(f.requests.every((row) => row.cookie === f.cookie));
    assert.equal(f.client.requests.length, 1);
    assert(
      !JSON.stringify({ point, closure, denial }).includes(invalidTraceCanary),
    );
    await observer.closeAndWait();
  });

  test(`${label} denial Trace ID retains the actual HTTP rejection contract`, async (t) => {
    const f = await fixture(t, { denialTraceID: traceID });
    const observer = await f.open();
    const point = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(point);
    const denial = await observer.rejectPrompt();
    assert.equal(denial.traceID, undefined);
    assert.equal(denial.traceDiagnostic, "missing_or_invalid_trace_id");
    assert.equal(denial.status, 401);
    assert.equal(denial.code, "unauthenticated");
    assert.equal(denial.noStore, true);
    assert.equal(denial.setCookieCount, 0);
    assert.equal(new Date(denial.serverDate).toUTCString(), denial.serverDate);
    assert.equal(denial.credentialScope, point.stream.credential_scope);
    assert.equal(observer.browser.cookie, f.cookie);
    assert(f.requests.every((row) => row.cookie === f.cookie));
    assert.equal(observer.browser.requests, 1);
    assert.equal(f.client.requests.length, 1);
    assert(!JSON.stringify(denial).includes(invalidTraceCanary));
    await observer.closeAndWait();
  });

  test(`${label} stream Trace ID does not replace or prevent the real remote EOF and join`, async (t) => {
    const f = await fixture(t, {
      streamTraceID: traceID,
      denialTraceID: traceID,
    });
    const observer = await f.open();
    const point = observer.checkpoint("revoked");
    assert.equal(point.stream.trace_id, undefined);
    assert.equal(point.stream.traceDiagnostic, "missing_or_invalid_trace_id");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    const closure = await observer.waitForClose(point);
    assert.equal(closure.traceID, undefined);
    assert.equal(closure.traceDiagnostic, "missing_or_invalid_trace_id");
    assert(["remote-end", "transport-end"].includes(closure.closure.kind));
    assert.equal(closure.localClose, false);
    assert.equal(closure.silent, true);
    assert.equal(closure.authorizationCauseVerified, false);
    assert.equal(closure.credentialScope, point.stream.credential_scope);
    assert.equal(observer.browser.requests, 0);
    const denial = await observer.rejectPrompt();
    assert.equal(denial.status, 401);
    assert.equal(denial.traceID, undefined);
    assert.equal(denial.traceDiagnostic, "missing_or_invalid_trace_id");
    assert.deepEqual(
      f.requests.map((row) => row.method),
      ["GET", "DELETE", "POST"],
    );
    assert.equal(f.client.requests.length, 1);
    assert(
      !JSON.stringify({ point, closure, denial }).includes(invalidTraceCanary),
    );
    await observer.closeAndWait();
  });
}

for (const [label, override] of [
  ["wrong authorization code", { code: "workspace_unavailable" }],
  ["a renewed Cookie", { cookie: true }],
])
  test(`a missing Trace ID cannot excuse ${label} in the real denial`, async (t) => {
    const f = await fixture(t, { ...override, denialTraceID: undefined });
    const observer = await f.open();
    const point = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(point);
    await assert.rejects(() => observer.rejectPrompt());
    assert.equal(f.requests.filter((row) => row.method === "POST").length, 1);
    assert.equal(f.client.requests.length, 1);
    await observer.closeAndWait();
  });

for (const [mode, trace] of [
  ["missing", null],
  ["malformed", invalidTraceCanary],
])
  for (const status of [401, 403])
    test(`business observation retains ${mode} login, SSE and denial Trace through actual HTTP ${status} and resource join`, async (t) => {
      const f = await fixture(t, {
        actualLogin: true,
        traces: { login: trace, stream: trace, denial: trace },
        status,
        ...(status === 403 ? { body: accessDenied } : {}),
      });
      const observer = await f.open({
        ...(status === 403
          ? { membershipRevocation: true }
          : { userRevocation: true }),
      });
      const point = observer.checkpoint("revoked");
      assert.equal(f.issued.observation.traceID, trace);
      assert.deepEqual(point.issuance, {
        ...f.issued.observation,
        traceID: undefined,
        traceDiagnostic: "missing_or_invalid_trace_id",
      });
      assert.equal(point.stream.trace_id, undefined);
      assert.equal(point.stream.traceDiagnostic, "missing_or_invalid_trace_id");
      assert.equal(observer.stream.evidence.trace_id, trace);
      assert.equal(point.stream.status, 200);
      assert.equal(
        point.stream.path,
        "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
      );
      assert.equal(point.stream.set_cookie_count, 0);
      await f.browser.request("/api/session", {
        method: "DELETE",
        status: 204,
      });
      const closed = await observer.waitForClose(point);
      assert.equal(closed.closure.kind, "remote-end");
      assert.equal(closed.traceID, undefined);
      assert.equal(closed.traceDiagnostic, "missing_or_invalid_trace_id");
      assert.equal(closed.closure.trace_id, undefined);
      assert.equal(
        closed.closure.traceDiagnostic,
        "missing_or_invalid_trace_id",
      );
      assert.equal(observer.stream.closure.trace_id, trace);
      assert.equal(closed.localClose, false);
      assert.equal(closed.silent, true);
      assert.equal(closed.authorizationCauseVerified, false);
      assert.equal(closed.credentialScope, point.stream.credential_scope);
      for (const key of ["at", "observed_at_ms"])
        assert(
          closed.closure[key] >= point[key] &&
            closed.closure[key] <= point[key] + 30000,
        );
      assert.equal(observer.browser.requests, 0);
      assert.deepEqual(f.client.requests, point.sdkRequests);
      const denial = await observer.rejectPrompt();
      assert.equal(denial.status, status);
      assert.equal(
        denial.code,
        status === 403 ? "access_denied" : "unauthenticated",
      );
      assert.equal(denial.traceID, undefined);
      assert.equal(denial.traceDiagnostic, "missing_or_invalid_trace_id");
      assert(
        !JSON.stringify({ point, closed, denial }).includes(invalidTraceCanary),
      );
      assert.equal(denial.credentialScope, point.stream.credential_scope);
      assert.equal(denial.noStore, true);
      assert.equal(denial.setCookieCount, 0);
      assert(denial.startedMono >= closed.closure.at);
      assert.equal(
        denial.path,
        "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts",
      );
      if (status === 403) assert.deepEqual(denial.body, accessDenied);
      assert.equal(observer.browser.cookie, f.cookie);
      assert.equal(observer.browser.requests, 1);
      assert(f.requests.every((row) => row.cookie === f.cookie));
      assert.deepEqual(
        f.requests.map((row) => row.path),
        [
          "/api/session/login",
          "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
          "/api/session",
          "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts",
        ],
      );
      assert.deepEqual(f.client.requests, point.sdkRequests);
      await observer.closeAndWait();
      assert(observer.stream.evidence.joined.at >= closed.closure.at);
      assert(
        observer.stream.evidence.joined.observed_at_ms >=
          closed.closure.observed_at_ms,
      );
      assert(
        Number.isSafeInteger(observer.stream.evidence.joined.observed_at_ms),
      );
      assert.equal(
        observer.stream.evidence.reader_cleanup.outcome,
        "cancelled",
      );
    });

test("business observation keeps the actual denial status, body, cache and Cookie checks hard", async (t) => {
  for (const override of [
    { status: 503, code: "identity_unavailable" },
    { status: 403, body: { ...accessDenied, retryable: true } },
    { status: 403, body: { ...accessDenied, recovery: "retry" } },
    { status: 403, body: { ...accessDenied, requestId: undefined } },
    { status: 403, body: accessDenied, cookie: true },
    { status: 403, body: accessDenied, cache: "private, max-age=60" },
  ]) {
    const f = await fixture(t, override);
    const observer = await f.open({
      membershipRevocation: true,
    });
    const point = observer.checkpoint("revoked");
    f.endStream();
    await observer.waitForClose(point);
    await assert.rejects(() => observer.rejectPrompt());
    assert.equal(f.requests.filter((row) => row.method === "POST").length, 1);
    assert.deepEqual(f.client.requests, point.sdkRequests);
    await observer.closeAndWait();
  }
});

test("business observation rejects changed private authority and local closure without dispatching a denial", async (t) => {
  const f = await fixture(t);
  const observer = await f.open({ userRevocation: true });
  const point = observer.checkpoint("revoked");
  await observer.closeAndWait();
  assert.equal(observer.stream.closure.kind, "local-close");
  await assert.rejects(() => observer.waitForClose(point));
  await assert.rejects(() => observer.rejectPrompt());
  assert.equal(f.requests.length, 1);
  assert.equal(observer.browser.requests, 0);

  const other = await fixture(t);
  const remote = await other.open({
    userRevocation: true,
  });
  const checkpoint = remote.checkpoint("revoked");
  other.endStream();
  await remote.waitForClose(checkpoint);
  remote.browser.cookies.set("antnest_session", "MUTATED-PRIVATE-CANARY");
  await assert.rejects(
    () => remote.rejectPrompt(),
    (error) => {
      assert(
        !inspect(error, { depth: null }).includes("MUTATED-PRIVATE-CANARY"),
      );
      assert(!inspect(error, { depth: null }).includes("original-session"));
      return true;
    },
  );
  assert.equal(other.requests.length, 1);
  await remote.closeAndWait();
});

test(
  "business observation cancellation joins the held denial and preserves its original abort",
  { timeout: 20000 },
  async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, { holdDenial: true });
    const observer = await f.open({
      signal: controller.signal,
    });
    const point = observer.checkpoint("revoked");
    f.endStream();
    await observer.waitForClose(point);
    const pending = observer.rejectPrompt();
    let settled = false;
    const joined = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await f.denialPending;
      const reason = new Error("business observation cancelled");
      controller.abort(reason);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      f.releaseDenial();
      await assert.rejects(pending, (error) => {
        assert.equal(error, reason);
        return true;
      });
      assert.equal(f.requests.filter((row) => row.method === "POST").length, 1);
    } finally {
      f.releaseDenial();
      await joined;
      await observer.closeAndWait();
    }
  },
);
