import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import {
  GatewayClient,
  assertNoStore,
  assertCookiesCleared,
} from "../identity-closeout/support.mjs";
import { collectTrace } from "./collect.mjs";
import { inspectLocalAdminLogin } from "./local-admin-login.mjs";
import { durablePath } from "../../support/storage.mjs";

export async function exerciseLocalAdminLogin({
  client,
  settings,
  jaeger,
  secureCookies = false,
  collect = collectTrace,
}) {
  const startedAt = new Date().toISOString();
  const observations = [];
  let originalCookies;
  try {
    const login = await client.request("/api/session/login", {
      body: {
        organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
        email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
        password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
      },
    });
    originalCookies = new Map(client.cookies);
    assert.deepEqual(Object.keys(login.body).sort(), [
      "expires_at",
      "principal",
    ]);
    assert(
      login.body.principal.active &&
        login.body.principal.system_role === "admin",
      "active system admin required",
    );
    assert(Date.parse(login.body.expires_at) > Date.now(), "session expired");
    assertNoStore(login.headers);
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const name of ["antnest_session", "antnest_csrf"]) {
      const cookie = cookies.find((value) => value.startsWith(`${name}=`));
      assert(cookie && client.cookies.get(name), "missing session cookie");
      assert(
        /; Path=\/;/iu.test(cookie) && /; SameSite=Lax(?:;|$)/iu.test(cookie),
        "cookie scope mismatch",
      );
      assert.equal(
        /; HttpOnly(?:;|$)/iu.test(cookie),
        name === "antnest_session",
      );
      assert.equal(/; Secure(?:;|$)/iu.test(cookie), secureCookies);
    }
    const restored = await client.request("/api/session", {
      headers: { "X-Antnest-CSRF-Token": "" },
    });
    assert.deepEqual(Object.keys(restored.body), ["principal"]);
    assert(
      JSON.stringify(restored.body.principal) ===
        JSON.stringify(login.body.principal),
      "restored identity differs",
    );
    assert.equal(
      restored.headers.getSetCookie().length,
      0,
      "session read unexpectedly rotated cookies",
    );
    assertNoStore(restored.headers);
    for (const [stage, request] of [
      ["login", login],
      ["session", restored],
    ]) {
      assert.match(request.traceID ?? "", /^[a-f0-9]{32}$/u);
      observations.push(
        await collect(jaeger, request.traceID, (trace) =>
          inspectLocalAdminLogin(trace, stage),
        ),
      );
    }
  } finally {
    if (originalCookies?.has("antnest_session")) {
      client.cookies = new Map(originalCookies);
      const originalCookie = client.cookie;
      await client.request("/api/session", { method: "DELETE", status: 204 });
      assertCookiesCleared(client.cookie);
      await client.request("/api/session", {
        status: 401,
        headers: { Cookie: originalCookie },
      });
    }
  }
  return {
    scenario: "BF-AUTH-01",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    independent_cookie_session: true,
    restored_same_principal: true,
    cleanup_revoked: true,
    traces: observations.map((result) => ({
      ...result,
      url: `${jaeger.replace(/\/$/u, "")}/trace/${result.trace_id}`,
    })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      gateway: { type: "string", default: "http://127.0.0.1:8090" },
      jaeger: { type: "string", default: "http://127.0.0.1:16686" },
      "env-file": { type: "string", default: ".env" },
      "secure-cookies": { type: "boolean", default: false },
      "confirm-development": { type: "boolean", default: false },
    },
  });
  values["env-file"] = durablePath(values["env-file"]);
  assert(values["confirm-development"], "development confirmation required");
  const result = await exerciseLocalAdminLogin({
    client: new GatewayClient(values.gateway),
    settings: parseEnv(readFileSync(values["env-file"], "utf8")),
    jaeger: values.jaeger,
    secureCookies: values["secure-cookies"],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch(() => {
    // Never print error objects from credential-bearing verification.
    console.error(
      "BF-AUTH-01 verification failed; inspect the development instance without dumping credentials.",
    );
    process.exitCode = 1;
  });
}
