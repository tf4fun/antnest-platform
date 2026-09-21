import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { databaseRequest, fields } from "../observability/trace-fixtures.mjs";
import {
  verifyIdentityEvidence,
  identityEvidenceExitCode,
  correlateOIDCRequests,
} from "./trace.mjs";

test("OIDC endpoints bind actual received traceparent, method and path", () => {
  const expected = [
    {
      traceID: "a".repeat(32),
      oidcRequests: [{ method: "GET", url: "https://oidc-fixture:8443/jwks" }],
    },
  ];
  const received = [
    {
      method: "GET",
      url: "https://oidc-fixture:8443/jwks",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      status: 200,
    },
  ];
  assert.equal(
    correlateOIDCRequests(expected, received)[0].oidcRequests[0].spanID,
    "b".repeat(16),
  );
  for (const mutate of [
    (r) => (r[0].method = "POST"),
    (r) => (r[0].url = "https://oidc-fixture:8443/token"),
    (r) => (r[0].traceparent = `00-${"c".repeat(32)}-${"b".repeat(16)}-01`),
    (r) => (r[0].status = 500),
    (r) => r.push({ ...r[0] }),
  ]) {
    const rows = structuredClone(received);
    mutate(rows);
    assert.throws(() => correlateOIDCRequests(expected, rows));
  }
});

const traceID = "a".repeat(32);
const expected = {
  traceID,
  method: "POST",
  route: "/rpc/identity/local-login",
  rpcMethod: "local_login",
};
function trace() {
  return {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [
      {
        spanID: "1",
        traceID,
        processID: "edge",
        operationName: "HTTP POST",
        tags: fields({ "span.kind": "client", "http.request.method": "POST" }),
        references: [],
      },
      ...databaseRequest(
        traceID,
        "2",
        "1",
        "identity",
        expected.route,
        "POST",
        expected.rpcMethod,
      ),
    ],
  };
}
const options = { wait: async () => {}, attempts: 5 };
test("collector waits for actual SQL evidence even when partial spans are unchanged", async () => {
  let calls = 0;
  const result = await verifyIdentityEvidence(
    "http://fixture",
    [expected],
    [],
    {
      ...options,
      request: async () => {
        calls++;
        const value = trace();
        if (calls <= 2) value.spans.pop();
        return Response.json({ data: [value] });
      },
    },
  );
  assert.equal(calls, 5);
  assert.equal(result[0].database_spans, 1);
  assert.equal(identityEvidenceExitCode(result), 0);
});
test("warning and error evidence remains failed and the raw trace is unchanged", async () => {
  const value = trace();
  value.spans[1].warnings = ["clock skew adjustment disabled; example"];
  value.spans[1].tags.push(...fields({ error: true }));
  const result = await verifyIdentityEvidence(
    "http://fixture",
    [expected],
    [],
    { ...options, request: async () => Response.json({ data: [value] }) },
  );
  assert.equal(result[0].strict_trace, "failed");
  assert.equal(result[0].error_spans, 1);
  assert.equal(result[0].warning_count, 1);
  assert.equal(identityEvidenceExitCode(result), 2);
  assert.equal(value.spans[1].warnings.length, 1);
});
for (const [name, mutate] of [
  ["missing SQL", (t) => t.spans.pop()],
  [
    "foreign parent",
    (t) => (t.spans[2].references[0].traceID = "b".repeat(32)),
  ],
  [
    "private content",
    (t) => t.spans[1].tags.push(...fields({ secret: "private-canary" })),
  ],
])
  test(`collector rejects ${name}`, async () => {
    await assert.rejects(
      verifyIdentityEvidence("http://fixture", [expected], ["private-canary"], {
        ...options,
        request: async () => {
          const value = trace();
          mutate(value);
          return Response.json({ data: [value] });
        },
      }),
    );
  });
test("real HTTP collector distinguishes absent trace, backend failure and malformed private response", async (t) => {
  let mode = "absent",
    calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (mode === "absent" && calls === 1) return res.writeHead(404).end("{}");
    if (mode === "backend") return res.writeHead(500).end("private-canary");
    if (mode === "malformed") return res.end("private-canary");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [trace()] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (await verifyIdentityEvidence(base, [expected], [], options)).length,
    1,
  );
  assert.equal(calls, 4);
  for (const value of ["backend", "malformed"]) {
    mode = value;
    await assert.rejects(
      verifyIdentityEvidence(base, [expected], [], options),
      (error) => {
        assert(!String(error).includes("private-canary"));
        return true;
      },
    );
  }
});

test("an absent export sample resets convergence rather than joining disjoint observations", async () => {
  for (const absent of [
    () => new Response("{}", { status: 404 }),
    () => Response.json({ data: [] }),
  ]) {
    let calls = 0;
    const result = await verifyIdentityEvidence(
      "http://fixture",
      [expected],
      [],
      {
        wait: async () => {},
        attempts: 7,
        request: async () => {
          calls++;
          return calls === 3 ? absent() : Response.json({ data: [trace()] });
        },
      },
    );
    assert.equal(result.length, 1);
    assert.equal(calls, 6);
  }
});
