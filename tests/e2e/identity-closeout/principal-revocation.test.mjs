import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { observePrincipalRevocation } from "./principal-revocation.mjs";
import { GatewayClient } from "./support.mjs";

const principal = {
  user_id: "user",
  organization_id: "org",
  membership_id: "member",
  organization_slug: "stage3",
  organization_name: "Stage 3",
  system_role: "user",
  organization_role: "member",
  active: true,
};
const session = () => ({
  principal: structuredClone(principal),
  expires_at: "2026-10-12T15:00:00Z",
  idle_expires_at: "2026-10-12T14:00:00Z",
  activity_interval_ms: 30000,
});

function fixture(statuses = [200, 200, 401]) {
  let time = 100,
    calls = 0;
  const seen = [],
    recorded = [];
  const client = {
    cookie: "original-cookie",
    async request(path, options) {
      assert.equal(path, "/api/session");
      assert.equal(options.headers.Cookie, "original-cookie");
      assert(
        [200, 401, 503].every((status) => options.status.includes(status)),
      );
      const status = statuses[calls++];
      const result = {
        status,
        traceID: calls.toString(16).padStart(32, "0"),
        headers: new Headers({ "cache-control": "no-store" }),
        body: status === 401 ? { code: "unauthenticated" } : session(),
      };
      seen.push(result);
      return result;
    },
  };
  const options = {
    client,
    principal,
    committedMS: 100,
    ttlMS: 1000,
    name: "fixture",
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    record: (item) => recorded.push(structuredClone(item)),
  };
  return {
    options,
    seen,
    recorded,
    advance: (value) => {
      time = value;
    },
  };
}

test("warm revocation binds the original Principal and Cookie until actual 401", async () => {
  const f = fixture();
  const result = await observePrincipalRevocation(f.options);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.observations.map((item) => item.status),
    [200, 200, 401],
  );
  assert.deepEqual(
    result.observations.map((item) => item.startedMS),
    [100, 200, 300],
  );
  assert.equal(f.recorded.length, 3);
  assert.equal(result.observations[0].principal.user_id, principal.user_id);
});

for (const [name, change] of [
  [
    "foreign Principal",
    (response) => {
      response.body.principal.user_id = "foreign";
    },
  ],
  [
    "changed permission",
    (response) => {
      response.body.principal.organization_role = "admin";
    },
  ],
  [
    "invalid DTO",
    (response) => {
      delete response.body.expires_at;
    },
  ],
  [
    "Cookie mutation",
    (response) => response.headers.append("set-cookie", "secret=changed"),
  ],
  [
    "cacheable response",
    (response) => response.headers.set("cache-control", "public"),
  ],
  [
    "missing Trace",
    (response) => {
      response.traceID = undefined;
    },
  ],
  [
    "unrelated status",
    (response) => {
      response.status = 503;
    },
  ],
])
  test(`bounded revocation preserves then rejects ${name}`, async () => {
    const f = fixture();
    const original = f.options.client.request;
    f.options.client.request = async (...args) => {
      const result = await original(...args);
      change(result);
      return result;
    };
    await assert.rejects(observePrincipalRevocation(f.options));
    assert.equal(f.seen.length, 1);
    assert.equal(
      f.recorded.length,
      1,
      "failed observation must survive validation",
    );
  });

test("duplicate Trace identity cannot masquerade as a new revocation observation", async () => {
  const f = fixture();
  const original = f.options.client.request;
  f.options.client.request = async (...args) => ({
    ...(await original(...args)),
    traceID: "a".repeat(32),
  });
  await assert.rejects(observePrincipalRevocation(f.options));
  assert.equal(f.seen.length, 2);
  assert.equal(f.recorded.length, 2);
});

test("revocation deadline is absolute, including zero TTL and the exact boundary", async () => {
  for (const ttlMS of [0, 100]) {
    const f = fixture([200, 200, 200]);
    await assert.rejects(observePrincipalRevocation({ ...f.options, ttlMS }));
    assert.equal(f.seen.length, ttlMS === 0 ? 1 : 2);
  }
  const f = fixture([401]);
  assert.equal(
    (await observePrincipalRevocation({ ...f.options, ttlMS: 0 })).complete,
    true,
  );
});

test("401 must carry the actual unauthenticated denial", async () => {
  const f = fixture([401]);
  const original = f.options.client.request;
  f.options.client.request = async (...args) => ({
    ...(await original(...args)),
    body: { code: "unavailable" },
  });
  await assert.rejects(observePrincipalRevocation(f.options));
});

test("cancellation and transport failures are never retried or admitted", async () => {
  const f = fixture();
  const controller = new AbortController();
  const original = f.options.client.request;
  f.options.client.request = async (...args) => {
    const result = await original(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(
    observePrincipalRevocation({ ...f.options, signal: controller.signal }),
  );
  assert.equal(f.seen.length, 1);
  const failure = new Error("transport unavailable");
  f.options.client.request = async () => {
    throw failure;
  };
  await assert.rejects(
    observePrincipalRevocation(f.options),
    (error) => error === failure,
  );
});

test("warm legacy workspace bootstrap retains its actual Principal projection", async () => {
  const f = fixture();
  const expected = {
    user_id: principal.user_id,
    organization_id: principal.organization_id,
    organization_slug: principal.organization_slug,
    organization_name: principal.organization_name,
    administrator: false,
  };
  let calls = 0;
  f.options.client.request = async (path, options) => {
    assert.equal(path, "/api/app/bootstrap");
    assert.equal(options.headers.Cookie, "original-cookie");
    const status = ++calls === 1 ? 200 : 401;
    return {
      status,
      traceID: calls.toString(16).padStart(32, "0"),
      headers: new Headers({ "cache-control": "no-store" }),
      body:
        status === 200
          ? { principal: expected, agents: [] }
          : { code: "unauthenticated" },
    };
  };
  const options = {
    ...f.options,
    path: "/api/app/bootstrap",
    principal: expected,
  };
  assert.equal((await observePrincipalRevocation(options)).complete, true);
  calls = 0;
  await assert.rejects(
    observePrincipalRevocation({
      ...options,
      principal: { ...expected, administrator: true },
    }),
  );
});

test("malformed upstream values cannot escape in public assertion errors", async () => {
  const canary = "PRIVATE-REVOCATION-CANARY";
  for (const kind of ["code", "principal", "cookie", "header", "trace"]) {
    const f = fixture([kind === "code" ? 401 : 200]);
    const original = f.options.client.request;
    f.options.client.request = async (...args) => {
      const response = await original(...args);
      if (kind === "code") response.body.code = canary;
      if (kind === "principal") response.body.principal.user_id = canary;
      if (kind === "cookie") f.options.client.cookie = canary;
      if (kind === "header") response.headers.set("cache-control", canary);
      if (kind === "trace") response.traceID = canary;
      return response;
    };
    await assert.rejects(observePrincipalRevocation(f.options), (error) => {
      assert(!inspect(error).includes(canary));
      return true;
    });
  }
});

test("cancellation between core completion and adapter continuation is not success", async () => {
  const f = fixture([401]);
  const controller = new AbortController();
  let reads = 0;
  const now = () => {
    if (++reads === 2)
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
    return 100;
  };
  await assert.rejects(
    observePrincipalRevocation({
      ...f.options,
      now,
      signal: controller.signal,
    }),
  );
  assert.equal(f.recorded.length, 1);
});

test("the real Gateway client records an unexpected HTTP status before refusing it", async (t) => {
  const f = fixture();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "upstream_unavailable" },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "x-antnest-trace-id": "a".repeat(32),
        },
      },
    ),
  );
  const client = new GatewayClient("https://gateway.invalid");
  client.cookies.set("__Host-antnest_session", "synthetic-token");
  await assert.rejects(observePrincipalRevocation({ ...f.options, client }));
  assert.equal(f.recorded.length, 1);
  assert.equal(f.recorded[0].status, 503);
  assert.equal(f.recorded[0].traceID, "a".repeat(32));
});
