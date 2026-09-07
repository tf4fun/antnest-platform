import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { inspect } from "node:util";
import {
  GatewayClient,
  inspectIdentityTrace,
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
        processID: "edge",
        operationName: "HTTP POST",
        references: [],
      },
      {
        spanID: "2",
        processID: "identity",
        operationName: "HTTP POST",
        references: [
          { refType: "CHILD_OF", traceID: "a".repeat(32), spanID: "1" },
        ],
      },
      {
        spanID: "3",
        processID: "identity",
        operationName: "repository.issue_local_token",
        references: [
          { refType: "CHILD_OF", traceID: "a".repeat(32), spanID: "2" },
        ],
      },
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
  repository: "repository.issue_local_token",
  console: false,
};
test("trace evidence requires a repository child of the Gateway request", () => {
  const result = inspectIdentityTrace(traceFixture(), expectation, []);
  assert.equal(result.spans, 3);
  assert.equal(result.gateway_ancestry, true);
});

test("service names without causal parents do not pass", () => {
  const trace = traceFixture();
  trace.spans[1].references = [];
  assert.throws(() => inspectIdentityTrace(trace, expectation, []), /ancestry/);
});

test("wrong repository, missing Console and exported secrets do not pass", () => {
  assert.throws(
    () =>
      inspectIdentityTrace(
        traceFixture(),
        { ...expectation, repository: "repository.wrong" },
        [],
      ),
    /repository/,
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
  assert.throws(() => inspectIdentityTrace(trace, expectation, []), /ancestry/);
});
