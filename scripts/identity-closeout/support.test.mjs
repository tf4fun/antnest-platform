import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { inspect } from "node:util";
import { databaseRequest, fields } from "../observability/trace-fixtures.mjs";
import {
  GatewayClient,
  inspectIdentityTrace,
  verifyIdentityTraces,
  assertNoStore,
  assertCookiesCleared,
} from "./support.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP helper retains and clears cookies and forwards CSRF", async (t) => {
  let call = 0;
  const base = await fixture(t, (request, response) => {
    call++;
    if (call === 1) {
      response.setHeader("Set-Cookie", [
        "antnest_session=secret; Path=/; HttpOnly; SameSite=Lax",
        "antnest_csrf=csrf; Path=/; SameSite=Lax",
      ]);
      response.end("{}");
      return;
    }
    assert.equal(
      request.headers.cookie,
      "antnest_session=secret; antnest_csrf=csrf",
    );
    assert.equal(request.headers["x-antnest-csrf-token"], "csrf");
    response.setHeader("Set-Cookie", [
      "antnest_session=; Path=/; Max-Age=0",
      "antnest_csrf=; Path=/; Max-Age=0",
    ]);
    response.writeHead(204).end();
  });
  const client = new GatewayClient(base);
  await client.request("/api/session/login", { body: {} });
  const result = await client.request("/api/session", {
    method: "DELETE",
    status: 204,
  });
  assert.equal(result.body, null);
  assert.equal(client.cookie, "");
  assert.equal(client.requests, 2);
});

test("HTTP status failures never echo sensitive response bodies", async (t) => {
  const base = await fixture(t, (_, response) =>
    response.writeHead(500).end("private-credential"),
  );
  await assert.rejects(
    new GatewayClient(base).request("/api/session"),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert(!error.message.includes("private-credential"));
      return true;
    },
  );
});

test("redirect responses preserve cookies without printing callback query secrets", async (t) => {
  const base = await fixture(t, (_, response) => {
    response.setHeader("Location", "/");
    response.setHeader(
      "Set-Cookie",
      "antnest_session=secret; HttpOnly; Path=/",
    );
    response.writeHead(303).end("<html>Redirect</html>");
  });
  const client = new GatewayClient(base);
  const response = await client.request(
    "/protocol/oidc/callback?code=private-code",
    { status: 303, responseType: "text" },
  );
  assert.equal(response.body, "<html>Redirect</html>");
  assert(client.cookies.has("antnest_session"));
  await assert.rejects(
    client.request("/protocol/oidc/callback?code=private-code"),
    (error) => {
      assert(!inspect(error).includes("private-code"));
      return true;
    },
  );
});

function traceFixture() {
  return {
    traceID: "a".repeat(32),
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [
      {
        spanID: "1",
        traceID: "a".repeat(32),
        processID: "edge",
        operationName: "HTTP POST",
        tags: fields({ "span.kind": "client", "http.request.method": "POST" }),
        references: [],
      },
      ...databaseRequest(
        "a".repeat(32),
        "2",
        "1",
        "identity",
        "/rpc/identity/local-login",
        "POST",
        "local_login",
      ),
    ],
  };
}

test("failed logout assertion never prints the retained credential", () => {
  assertCookiesCleared("");
  assert.throws(
    () => assertCookiesCleared("antnest_session=private-credential"),
    (error) => {
      assert.match(error.message, /Logout/);
      assert(!inspect(error).includes("private-credential"));
      return true;
    },
  );
});

test("cache directives tolerate duplicate no-store, not missing or conflicting policy", () => {
  for (const value of ["no-store", "no-store, no-store"])
    assertNoStore(new Headers({ "cache-control": value }));
  for (const value of ["", "public", "no-store, public"])
    assert.throws(() => assertNoStore(new Headers({ "cache-control": value })));
});

test("malformed success bodies never leak through JSON parser errors", async (t) => {
  const base = await fixture(t, (_, response) =>
    response.end("private-credential"),
  );
  await assert.rejects(
    new GatewayClient(base).request("/api/session"),
    (error) => {
      assert.match(error.message, /invalid JSON response/);
      assert(!error.message.includes("private-credential"));
      return true;
    },
  );
});

const expectation = {
  method: "POST",
  route: "/rpc/identity/local-login",
  rpcMethod: "local_login",
  console: false,
};
test("trace evidence requires a DB child of the exact Identity SERVER", () => {
  const result = inspectIdentityTrace(traceFixture(), expectation, []);
  assert.equal(result.spans, 3);
  assert.equal(result.gateway_ancestry, true);
});

test("Identity expectations sharing a trace use one delayed query", async () => {
  const events = [];
  const item = { ...expectation, traceID: "a".repeat(32) };
  const results = await verifyIdentityTraces(
    "http://jaeger",
    [item, item],
    [],
    {
      wait: async (ms) => {
        events.push(ms);
      },
      request: async (url) => {
        events.push(url);
        return Response.json({ data: [traceFixture()] });
      },
    },
  );
  assert.equal(results.length, 2);
  assert.deepEqual(events, [6000, `http://jaeger/api/traces/${item.traceID}`]);
});

test("service names without causal parents do not pass", () => {
  const trace = traceFixture();
  trace.spans[1].references = [];
  assert.throws(() => inspectIdentityTrace(trace, expectation, []));
});

test("wrong RPC route, missing Console and exported secrets do not pass", () => {
  assert.throws(
    () =>
      inspectIdentityTrace(
        traceFixture(),
        { ...expectation, route: "/rpc/identity/wrong" },
        [],
      ),
    /SERVER/,
  );
  assert.throws(
    () =>
      inspectIdentityTrace(
        traceFixture(),
        { ...expectation, console: true },
        [],
      ),
    /Console/,
  );
  const trace = traceFixture();
  trace.spans[2].tags = [{ key: "bad", value: "test-secret-canary" }];
  assert.throws(
    () => inspectIdentityTrace(trace, expectation, ["test-secret-canary"]),
    /secret/,
  );
});

test("cross-trace references cannot manufacture Gateway ancestry", () => {
  const trace = traceFixture();
  trace.spans[1].references[0].traceID = "b".repeat(32);
  assert.throws(() => inspectIdentityTrace(trace, expectation, []));
});

for (const [body, secrets, expected] of [
  ["secret7", ["secret7"], "Jaeger returned invalid JSON"],
  ["private-invalid-response", [], "Jaeger returned invalid JSON"],
])
  test(`trace response errors are safe: ${expected}`, async (t) => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "fetch", async () => {
      now = 46000;
      return new Response(body);
    });
    await assert.rejects(
      verifyIdentityTraces(
        "http://fixture",
        [{ ...expectation, traceID: "a".repeat(32) }],
        secrets,
        { wait: async () => {} },
      ),
      (error) => {
        assert.equal(error.message, expected);
        assert(!inspect(error).includes(body));
        return true;
      },
    );
  });

for (const target of ["Gateway", "Jaeger"])
  for (const phase of ["fetch", "body"])
    test(`${target} ${phase} errors exclude nested transport causes`, async (t) => {
      let now = 0;
      t.mock.method(Date, "now", () => now);
      const fail = () => {
        now = 46000;
        throw new Error("request failed", {
          cause: new Error("private-transport-credential"),
        });
      };
      t.mock.method(globalThis, "fetch", async () => {
        if (phase === "fetch") fail();
        return { status: 200, text: async () => fail() };
      });
      const request =
        target === "Gateway"
          ? new GatewayClient("http://fixture").request("/api/session")
          : verifyIdentityTraces(
              "http://fixture",
              [{ ...expectation, traceID: "a".repeat(32) }],
              [],
              { wait: async () => {} },
            );
      await assert.rejects(request, (error) => {
        assert.match(error.message, /request failed/);
        assert(!inspect(error).includes("private-transport-credential"));
        assert.equal(error.cause, undefined);
        return true;
      });
    });

const oidcRequests = [
  { method: "POST", url: "https://idp.test/token" },
  { method: "GET", url: "https://idp.test/jwks" },
  { method: "GET", url: "https://idp.test/userinfo" },
];
function oidcTraceFixture() {
  const trace = traceFixture();
  for (const [index, request] of oidcRequests.entries())
    trace.spans.push({
      traceID: trace.traceID,
      spanID: `client-${index}`,
      processID: "identity",
      operationName: `HTTP ${request.method}`,
      duration: 10,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: "2" },
      ],
      tags: [
        { key: "span.kind", value: "client" },
        { key: "http.request.method", value: request.method },
        { key: "url.full", value: request.url },
        { key: "http.response.status_code", value: 200 },
      ],
    });
  return trace;
}
test("OIDC trace includes exact outbound request ancestry and compact identities", () => {
  const result = inspectIdentityTrace(
    oidcTraceFixture(),
    { ...expectation, oidcRequests },
    [],
  );
  assert.deepEqual(result.oidc_requests, [
    { method: "POST", path: "/token", span_id: "client-0" },
    { method: "GET", path: "/jwks", span_id: "client-1" },
    { method: "GET", path: "/userinfo", span_id: "client-2" },
  ]);
});
test("server ownership is independent of its instrumentation display name", () => {
  const trace = oidcTraceFixture();
  trace.spans[1].operationName = "POST /protocol/oidc/callback";
  assert.equal(
    inspectIdentityTrace(trace, { ...expectation, oidcRequests }, [])
      .oidc_requests.length,
    3,
  );
});
for (const owner of ["outbound", "persistence"])
  test(`a differently named nested server cannot own ${owner}`, () => {
    const trace = oidcTraceFixture();
    trace.spans.push({
      ...trace.spans[1],
      spanID: "nested-request",
      operationName: "POST /protocol/oidc/callback",
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: "2" },
      ],
    });
    trace.spans[owner === "outbound" ? 3 : 2].references[0].spanID =
      "nested-request";
    assert.throws(() =>
      inspectIdentityTrace(trace, { ...expectation, oidcRequests }, []),
    );
  });
for (const [name, mutate] of [
  [
    "missing Identity server span",
    (trace) => {
      trace.spans[1].tags = [];
    },
  ],
  [
    "Identity client span substituting for server",
    (trace) => {
      trace.spans[1].tags[0].value = "client";
    },
  ],
  [
    "nested foreign Identity request owning outbound call",
    (trace) => {
      trace.spans.push({
        ...trace.spans[1],
        spanID: "nested-request",
        references: [
          { refType: "CHILD_OF", traceID: trace.traceID, spanID: "2" },
        ],
      });
      trace.spans[3].references[0].spanID = "nested-request";
    },
  ],
  [
    "nested foreign Identity request owning persistence",
    (trace) => {
      trace.spans.push({
        ...trace.spans[1],
        spanID: "nested-request",
        references: [
          { refType: "CHILD_OF", traceID: trace.traceID, spanID: "2" },
        ],
      });
      trace.spans[2].references[0].spanID = "nested-request";
    },
  ],
  ["missing UserInfo", (trace) => trace.spans.pop()],
  [
    "disconnected request",
    (trace) => {
      trace.spans[3].references = [];
    },
  ],
  [
    "foreign-trace parent",
    (trace) => {
      trace.spans[3].references[0].traceID = "b".repeat(32);
    },
  ],
  [
    "foreign-trace span",
    (trace) => {
      trace.spans[3].traceID = "b".repeat(32);
    },
  ],
  [
    "wrong request method",
    (trace) => {
      trace.spans[3].tags[1].value = "GET";
    },
  ],
  [
    "wrong endpoint",
    (trace) => {
      trace.spans[3].tags[2].value = "https://other.test/token";
    },
  ],
  [
    "server span masquerading as client",
    (trace) => {
      trace.spans[3].tags[0].value = "server";
    },
  ],
  [
    "failed token exchange",
    (trace) => {
      trace.spans[3].tags[3].value = 500;
    },
  ],
  [
    "errored request",
    (trace) => {
      trace.spans[3].tags.push({ key: "error", value: true });
    },
  ],
  [
    "unfinished request",
    (trace) => {
      trace.spans[3].duration = 0;
    },
  ],
  [
    "duplicate request",
    (trace) => {
      trace.spans.push({ ...trace.spans[3], spanID: "duplicate" });
    },
  ],
  [
    "another Identity request under the same Gateway",
    (trace) => {
      trace.spans.push({ ...trace.spans[1], spanID: "another-request" });
      trace.spans[3].references[0].spanID = "another-request";
    },
  ],
])
  test(`OIDC trace rejects ${name}`, () => {
    const trace = oidcTraceFixture();
    mutate(trace);
    assert.throws(() =>
      inspectIdentityTrace(trace, { ...expectation, oidcRequests }, []),
    );
  });
