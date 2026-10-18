import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { serviceClient } from "../../support/service-grants.mjs";
const url = new URL("./private-authority.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "owner" };
const token = "original-private-session",
  context = "original-private-context";
const denied = {
  code: "unauthenticated",
  message: "Authentication failed",
  retryable: false,
};
const contains = (error, original) =>
  error === original ||
  (error?.errors ?? []).some((item) => contains(item, original));

async function fixture(
  t,
  { status = 200, body, preserve, service, signal } = {},
) {
  assert.equal(typeof implementation.createWorkspaceAuthority, "function");
  const requests = [],
    saved = [],
    secrets = [];
  const actual =
    body ?? (status === 200 ? { caller_context: context, principal } : denied);
  const raw = JSON.stringify(actual) + "\n";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response
        .writeHead(status, {
          "content-type": "application/json",
          "x-antnest-trace-id": "a".repeat(32),
        })
        .end(raw);
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const identityEndpoint = "http://127.0.0.1:" + server.address().port;
  const scope = implementation.createWorkspaceAuthority({
    service:
      service ??
      serviceClient({ identityEndpoint, readCredential: () => "G".repeat(43) }),
    identityEndpoint,
    agentId: "agent",
    browser: { accessToken: token },
    principal,
    signal,
    secrets,
    preserve: preserve ?? ((value) => saved.push(structuredClone(value))),
  });
  t.after(async () => {
    await scope.closeAndWait().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { scope, requests, saved, secrets, raw };
}
const expected = (after = 0) => ({
  agentID: "agent",
  principal,
  session_digest: createHash("sha256").update(token).digest("hex"),
  after,
});

test("Workspace authority preserves the original HTTP response and per-operation scope", async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.service.workspaceContext(token, "agent");
  assert.deepEqual(issued, { context, principal });
  await f.scope.closeAndWait();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, {
    access_token: token,
    profile: "workspace",
    agent_id: "agent",
  });
  assert.equal(f.requests[0].headers.cookie, undefined);
  const [row] = f.scope.snapshot();
  assert.equal(row.status, 200);
  assert.equal(row.raw_body_base64, Buffer.from(f.raw).toString("base64"));
  assert.equal(row.body_bytes, Buffer.byteLength(f.raw));
  assert.equal(row.response_trace_id, "a".repeat(32));
  assert.equal(row.session_digest, expected().session_digest);
  assert.deepEqual(f.saved.at(-1), [row]);
  assert(f.secrets.includes(token) && f.secrets.includes(context));
  row.principal.user_id = "mutated";
  assert.equal(f.scope.snapshot()[0].principal.user_id, "owner");
  await assert.rejects(f.scope.service.workspaceContext(token, "agent"));
});

test("Workspace new admission proves original 401 unauthenticated rather than a generic thrown Error", async (t) => {
  const f = await fixture(t, { status: 401 });
  const after = Date.now();
  await assert.rejects(
    f.scope.service.workspaceContext(token, "agent"),
    /Workspace Identity Resolve rejected/u,
  );
  const [row] = f.scope.snapshot();
  implementation.assertWorkspaceResolveDenied(row, expected(after));
  await f.scope.closeAndWait();
  assert.deepEqual(f.saved.at(-1), [row]);
  assert.equal(f.requests.length, 1);
});

for (const [name, status, body] of [
  [
    "workload denial",
    403,
    {
      code: "caller_not_allowed",
      message: "Caller is not allowed",
      retryable: false,
    },
  ],
  [
    "unavailable dependency",
    503,
    { code: "unavailable", message: "Unavailable", retryable: true },
  ],
  ["wrong 401 code", 401, { ...denied, code: "caller_context_invalid" }],
  ["retryable denial", 401, { ...denied, retryable: true }],
  ["success response", 200, { caller_context: context, principal }],
]) {
  test("Workspace revocation refuses " + name, async (t) => {
    const f = await fixture(t, { status, body });
    await f.scope.service.workspaceContext(token, "agent").catch(() => {});
    assert.throws(() =>
      implementation.assertWorkspaceResolveDenied(
        f.scope.snapshot()[0],
        expected(),
      ),
    );
  });
}

for (const [name, mutate] of [
  [
    "foreign Agent",
    (r) => {
      r.agentId = "other";
    },
  ],
  [
    "foreign login",
    (r) => {
      r.session_digest = "b".repeat(64);
    },
  ],
  [
    "foreign Principal",
    (r) => {
      r.principal.user_id = "other";
    },
  ],
  [
    "missing response Trace",
    (r) => {
      r.response_trace_id = null;
    },
  ],
  [
    "changed body size",
    (r) => {
      r.body_bytes++;
    },
  ],
  [
    "request predates revocation",
    (r) => {
      r.request_started_at = 0;
    },
  ],
  [
    "unfinished body",
    (r) => {
      delete r.response_completed_at;
    },
  ],
]) {
  test("Workspace denial receipt rejects " + name, async (t) => {
    const f = await fixture(t, { status: 401 }),
      after = Date.now();
    await f.scope.service.workspaceContext(token, "agent").catch(() => {});
    const row = f.scope.snapshot()[0];
    mutate(row);
    assert.throws(() =>
      implementation.assertWorkspaceResolveDenied(row, expected(after)),
    );
  });
}

test("Workspace authority refuses foreign scope before sending and preserves one original issuance", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.scope.service.workspaceContext("other-token", "agent"),
  );
  await assert.rejects(f.scope.service.workspaceContext(token, "other-agent"));
  assert.equal(f.requests.length, 0);
  await f.scope.service.workspaceContext(token, "agent");
  await assert.rejects(f.scope.service.workspaceContext(token, "agent"));
  assert.equal(f.requests.length, 1);
});

test("Workspace authority retains both original transport and archive failures and joins them", async (t) => {
  const original = new Error("original private network failure");
  const archive = new Error("original private archive failure");
  const f = await fixture(t, {
    service: {
      send: async () => {
        throw original;
      },
    },
    preserve: () => {
      throw archive;
    },
  });
  await assert.rejects(
    f.scope.service.workspaceContext(token, "agent"),
    (error) => contains(error, original) && contains(error, archive),
  );
  await assert.rejects(
    f.scope.closeAndWait(),
    (error) => contains(error, original) && contains(error, archive),
  );
  const row = f.scope.snapshot()[0];
  assert.equal(row.status, undefined);
  assert.throws(() =>
    implementation.assertWorkspaceResolveDenied(row, expected()),
  );
});

test("Workspace authority diagnostics do not expose the original login token", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.scope.service.workspaceContext("foreign", "agent"),
    (error) => {
      assert(
        !inspect(error).includes(token),
        "original login leaked into diagnostic",
      );
      return true;
    },
  );
});

test("Workspace authority diagnostics do not expose invalid response contents", async (t) => {
  const canary = "secret-cct";
  const f = await fixture(t, {
    service: { send: async () => new Response(canary, { status: 200 }) },
  });
  await assert.rejects(
    f.scope.service.workspaceContext(token, "agent"),
    (error) => {
      assert(
        !inspect(error).includes(canary),
        "response contents leaked into diagnostic",
      );
      return true;
    },
  );
  assert.equal(
    Buffer.from(f.scope.snapshot()[0].raw_body_base64, "base64").toString(),
    canary,
  );
});

for (const key of ["organization_id", "user_id"]) {
  test(
    "Workspace authority diagnostics do not expose a foreign Principal " + key,
    async (t) => {
      const f = await fixture(t, {
        body: {
          caller_context: context,
          principal: { ...principal, [key]: context },
        },
      });
      await assert.rejects(
        f.scope.service.workspaceContext(token, "agent"),
        (error) => {
          assert(
            !inspect(error).includes(context),
            "foreign Principal response leaked into diagnostic",
          );
          return true;
        },
      );
    },
  );
}

test("Workspace denial diagnostics do not expose a contradictory response body", async (t) => {
  const f = await fixture(t, {
    status: 401,
    body: { ...denied, message: context },
  });
  await f.scope.service.workspaceContext(token, "agent").catch(() => {});
  assert.throws(
    () =>
      implementation.assertWorkspaceResolveDenied(
        f.scope.snapshot()[0],
        expected(),
      ),
    (error) => {
      assert(
        !inspect(error).includes(context),
        "contradictory denial body leaked into diagnostic",
      );
      return true;
    },
  );
});

test("Workspace authority retains per-call cancellation during its final archive join", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const abort = new AbortController(),
    reason = new Error("original late authority cancellation");
  let archives = 0;
  const f = await fixture(t, {
    preserve: async () => {
      if (++archives === 2) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await f.scope.service.workspaceContext(token, "agent", {
    signal: abort.signal,
  });
  const closing = f.scope.closeAndWait();
  await entered.promise;
  abort.abort(reason);
  release.resolve();
  await assert.rejects(closing, (error) => contains(error, reason));
});

test("Workspace authority retains the actual response read error without fabricating a denial", async (t) => {
  const original = new Error("original HTTP response read failure");
  const f = await fixture(t, {
    service: {
      send: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(original);
            },
          }),
          { status: 401 },
        ),
    },
  });
  await assert.rejects(
    f.scope.service.workspaceContext(token, "agent"),
    (error) => contains(error, original),
  );
  await assert.rejects(f.scope.closeAndWait(), (error) =>
    contains(error, original),
  );
  assert.throws(() =>
    implementation.assertWorkspaceResolveDenied(
      f.scope.snapshot()[0],
      expected(),
    ),
  );
});
