import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { GatewayClient, assertNoStore } from "./support.mjs";
import {
  verifyIdentityEvidence as verifyIdentityTraces,
  identityEvidenceExitCode,
} from "./trace.mjs";
import { waitForExpiry, assertClearedSessionCookies } from "./expiry.mjs";

const [gateway, jaeger, phase, statePath] = process.argv.slice(2);
const browser = new GatewayClient(gateway);
const password = "stage3-admin-password";
async function login() {
  return browser.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password,
    },
  });
}
if (phase === "prepare") {
  const response = await login();
  await browser.request("/api/admin/account");
  await writeFile(
    statePath,
    JSON.stringify({
      cookie: browser.cookie,
      principal: response.body.principal,
    }),
    { mode: 0o600 },
  );
} else if (phase === "unavailable") {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  for (const path of [
    "/api/session",
    "/api/admin/account",
    "/api/app/bootstrap",
  ]) {
    const response = await browser.request(path, {
      headers: { Cookie: saved.cookie },
      status: 503,
    });
    assert.equal(response.body.code, "identity_unavailable");
    assert.equal(response.headers.getSetCookie().length, 0);
    assertNoStore(response.headers);
  }
  process.stdout.write(
    "Identity outage: protected access denied without cookie invalidation\n",
  );
} else if (phase === "expiry") {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  const recovered = await browser.request("/api/session", {
    headers: { Cookie: saved.cookie },
  });
  assert.equal(recovered.body.principal.user_id, saved.principal.user_id);
  const issued = await login();
  const cookie = browser.cookie;
  const csrf = browser.cookies.get("antnest_csrf");
  await browser.request("/api/admin/account");
  await waitForExpiry(issued.body.expires_at);
  let denied;
  for (const path of [
    "/api/session",
    "/api/app/bootstrap",
    "/api/admin/account",
  ]) {
    denied = await browser.request(path, {
      headers: { Cookie: cookie },
      status: 401,
    });
    assert.equal(denied.body.code, "unauthenticated");
    assertNoStore(denied.headers);
    assertClearedSessionCookies(denied.headers);
  }
  const rejectedPassword = await browser.request(
    "/api/admin/account/password",
    {
      headers: { Cookie: cookie, "X-Antnest-CSRF-Token": csrf },
      status: 401,
      body: {
        current_password: password,
        new_password: "must-not-become-password",
      },
    },
  );
  assert.equal(rejectedPassword.body.code, "unauthenticated");
  assertNoStore(rejectedPassword.headers);
  assertClearedSessionCookies(rejectedPassword.headers);
  const fresh = await login();
  assert.equal(fresh.body.principal.user_id, issued.body.principal.user_id);
  const secrets = [
    password,
    ...browser.cookies.values(),
    ...cookie.split("; ").map((part) => part.slice(part.indexOf("=") + 1)),
  ];
  await browser.request("/api/session", { method: "DELETE", status: 204 });
  const traces = await verifyIdentityTraces(
    jaeger,
    [
      {
        traceID: denied.traceID,
        method: "POST",
        route: "/rpc/identity/resolve-access-token",
        rpcMethod: "resolve_access_token",
      },
    ],
    secrets,
  );
  process.exitCode = identityEvidenceExitCode(traces);
  process.stdout.write(
    JSON.stringify({
      status: "business_passed",
      suite: "session-expiry",
      expires_at: issued.body.expires_at,
      traces,
    }) + "\n",
  );
} else {
  throw new Error("unknown expiry test phase");
}
