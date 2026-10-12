import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { exerciseLocalAdminLogin as runLogin } from "./exercise-local-admin-login.mjs";
import { fakeClient } from "./local-admin-client-fixture.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";

// These original cases own HTTP/Cookie/cleanup behavior. Dedicated wiring
// tests below the same directory exercise both real trace collectors.
async function exerciseLocalAdminLogin(options) {
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-login-http-"),
  );
  try {
    return await runLogin({
      resolveEvidenceDirectory: directory,
      collectResolution: async () => ({}),
      ...options,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const secureCookies of [true, false])
  test(`login exercise revokes and replays the original ${secureCookies ? "Secure" : "insecure"} session`, async () => {
    const client = fakeClient({ secureCookies });
    const result = await exerciseLocalAdminLogin({
      client,
      secureCookies,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    });
    assert(result.cleanup_revoked);
    assert.equal(client.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(client.calls.filter((c) => c.method === "DELETE").length, 1);
    assert.equal(client.calls.filter((c) => c.method === "GET").length, 2);
    assert.equal(client.cookie, "");
  });

test("Secure admission rejects legacy names and still cleans the original token", async () => {
  const client = fakeClient({ cookiePrefix: "" });
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    }),
    /missing session cookie/u,
  );
  assert(client.revoked);
});

for (const mutateSession of ["clear", "replace"])
  test(`unexpected ${mutateSession} Cookie still cleans original token`, async () => {
    const client = fakeClient({ mutateSession });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
      }),
    );
    assert(client.revoked);
    assert.equal(client.cookie, "");
  });

test("clearing Cookie without token revocation cannot report success", async () => {
  const client = fakeClient({ keepToken: true });
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    }),
    /old token still resolves/u,
  );
});

test("trace failure still revokes the original session", async () => {
  const client = fakeClient();
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => {
        throw new Error("trace unavailable");
      },
    }),
    /trace unavailable/u,
  );
  assert(client.revoked);
});

for (const stage of ["login", "session"])
  for (const [name, mutate] of [
    [
      "missing idle deadline",
      (body) => {
        delete body.idle_expires_at;
      },
    ],
    [
      "invalid absolute deadline",
      (body) => {
        body.expires_at = "invalid";
      },
    ],
    [
      "expired idle deadline",
      (body) => {
        body.idle_expires_at = new Date(Date.now() - 1).toISOString();
      },
    ],
    [
      "idle beyond absolute",
      (body) => {
        body.idle_expires_at = new Date(
          Date.parse(body.expires_at) + 1,
        ).toISOString();
      },
    ],
    [
      "zero interval",
      (body) => {
        body.activity_interval_ms = 0;
      },
    ],
    [
      "oversized interval",
      (body) => {
        body.activity_interval_ms = 30001;
      },
    ],
    [
      "fractional interval",
      (body) => {
        body.activity_interval_ms = 1.5;
      },
    ],
    [
      "unexpected credential",
      (body) => {
        body.access_token = "must-not-be-public";
      },
    ],
  ])
    test(`${stage} admission rejects ${name} and revokes its original session`, async () => {
      const client = fakeClient({
        mutateMetadata(body, current) {
          if (current === stage) mutate(body);
        },
      });
      await assert.rejects(
        exerciseLocalAdminLogin({
          client,
          settings: {},
          jaeger: "http://jaeger",
          collect: async () => ({}),
        }),
      );
      assert(client.revoked);
    });

for (const field of ["expires_at", "idle_expires_at"])
  test(`ordinary restoration cannot extend ${field}`, async () => {
    const client = fakeClient({
      mutateMetadata(body, stage) {
        if (stage === "session")
          body[field] = new Date(Date.parse(body[field]) + 1000).toISOString();
      },
    });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
        collect: async () => ({}),
      }),
    );
    assert(client.revoked);
  });

for (const value of [
  "2099-01-01",
  "2099-01-01T00:00:00",
  "2099-02-31T00:00:00Z",
])
  test(`both responses must reject malformed date-time ${value}`, async () => {
    const client = fakeClient({
      mutateMetadata(body) {
        body.expires_at = value;
        body.idle_expires_at = value;
      },
    });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
        collect: async () => ({}),
      }),
    );
    assert(client.revoked);
  });

for (const field of ["access_token", "token_id"])
  test(`matching principals cannot expose nested ${field}`, async () => {
    const client = fakeClient({
      mutateMetadata(body) {
        body.principal[field] = "nested-credential-canary";
      },
    });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
        collect: async () => ({}),
      }),
      (error) => {
        assert(!String(error).includes("nested-credential-canary"));
        return true;
      },
    );
    assert(client.revoked);
  });

test("expiry during trace collection still requires explicit logout clearing and replay denial", async () => {
  const client = fakeClient({ logoutStatus: 401 });
  const result = await exerciseLocalAdminLogin({
    client,
    settings: {},
    jaeger: "http://jaeger",
    collect: async () => ({}),
  });
  assert(result.cleanup_revoked);
  assert.equal(client.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.equal(client.calls.filter((c) => c.method === "GET").length, 2);
  assert.equal(client.cookie, "");
});

for (const logoutStatus of [403, 503])
  test(`logout ${logoutStatus} cannot report successful cleanup`, async () => {
    const client = fakeClient({ logoutStatus });
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
        collect: async () => ({}),
      }),
      /unexpected logout status/u,
    );
  });

test("unexpected expired-logout code never leaks through the exported helper", async () => {
  const canary = "private-logout-code-canary";
  const client = fakeClient({ logoutStatus: 401, logoutCode: canary });
  await assert.rejects(
    exerciseLocalAdminLogin({
      client,
      settings: {},
      jaeger: "http://jaeger",
      collect: async () => ({}),
    }),
    (error) => {
      assert(
        !inspect(error).includes(canary),
        "logout failure retained a private response value",
      );
      return true;
    },
  );
  assert.equal(client.cookie, "");
});
