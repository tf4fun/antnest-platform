import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { gatewaySessionCookies } from "../../../support/gateway-session-cookies.mjs";
import { externalIdentityChecks } from "./external-identities.mjs";
import { passwordAdmissionChecks } from "./password-admission.mjs";

// Exercise the real Gateway against the authenticated Identity wire double.
// Producer transactions and real browser generations have separate admissions.
export async function browserSessionChecks({
  url,
  origin,
  fixture,
  signal,
  initial,
  readPasswordEvidence,
  recordEvidence,
}) {
  let checks = 0;
  function jar(headers) {
    const values = headers.getSetCookie();
    const { csrf, sessionName } = gatewaySessionCookies(values);
    assert.equal(sessionName, "__Host-antnest_session");
    assert(csrf);
    assert.equal(values.length, 2);
    checks++;
    return {
      cookie: values.map((value) => value.split(";")[0]).join("; "),
      csrf,
    };
  }
  async function request(
    path,
    {
      session = initial,
      method = "GET",
      body,
      status = 200,
      cookies = false,
      headers = {},
    } = {},
  ) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(session
          ? { Cookie: session.cookie, "X-Antnest-CSRF-Token": session.csrf }
          : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Antnest-Caller-Context"), null);
    assert.equal(response.headers.get("Antnest-Service-Authorization"), null);
    assert.equal(
      response.headers.getSetCookie().length > 0,
      cookies,
      `${path} Cookie boundary`,
    );
    const value = status === 204 ? null : await response.json();
    const serialized = JSON.stringify(value);
    for (const name of [
      "access_token",
      "token_id",
      "session_id",
      "caller_context",
    ])
      assert(!serialized.includes(`"${name}"`), `${path} exposed ${name}`);
    assert(!serialized.includes(fixture.access));
    checks++;
    return { response, value };
  }
  async function login(
    password = fixture.password,
    hint = "Gateway session fixture",
  ) {
    const { response, value } = await request("/api/session/login", {
      session: null,
      method: "POST",
      cookies: true,
      headers: { "User-Agent": hint },
      body: {
        organization_slug: "auth-test",
        email: "admin@example.test",
        password,
      },
    });
    const session = jar(response.headers);
    for (const cookie of response.headers.getSetCookie()) {
      const expiry = cookie.match(/; Expires=([^;]+)/)?.[1];
      assert.equal(
        Date.parse(expiry),
        Math.floor(Date.parse(value.expires_at) / 1000) * 1000,
      );
    }
    checks++;
    return { ...session, metadata: value };
  }

  const first = (await request("/api/session")).value;
  assert.equal(first.expires_at, initial.metadata.expires_at);
  assert.equal(first.idle_expires_at, initial.metadata.idle_expires_at);
  assert.equal(first.activity_interval_ms, 30000);
  const account = (await request("/api/session/account")).value.account;
  assert.deepEqual(Object.keys(account).sort(), [
    "display_name",
    "email",
    "local_password_available",
    "membership_id",
    "organization_id",
    "source",
    "user_id",
  ]);
  assert.equal(account.local_password_available, true);
  assert.equal(account.user_id, first.principal.user_id);
  const original = (await request("/api/session/sessions?limit=100")).value
    .sessions;
  assert.equal(original.length, 1);
  assert.equal(original[0].current, true);
  assert.equal(original[0].user_agent_hint, initial.hint);
  assert(original[0].id.startsWith("public-"));
  checks++;

  await request("/api/session/sessions?limit=100&scope=organization", {
    status: 400,
  });
  await request("/api/session/sessions?limit=100&limit=100", { status: 400 });
  await request("/api/session/activity", {
    method: "POST",
    body: {},
    status: 403,
    headers: { "X-Antnest-CSRF-Token": "forged" },
  });
  await request("/api/session/activity", {
    method: "POST",
    body: { actor_principal_id: "forged" },
    status: 400,
  });
  const touched = (
    await request("/api/session/activity", { method: "POST", body: {} })
  ).value;
  assert.equal(touched.expires_at, first.expires_at);
  assert(
    Date.parse(touched.idle_expires_at) > Date.parse(first.idle_expires_at),
  );
  const afterTouch = (await request("/api/session")).value;
  assert.equal(afterTouch.idle_expires_at, touched.idle_expires_at);
  const afterReads = (await request("/api/session/sessions?limit=100")).value
    .sessions[0];
  assert.equal(afterReads.idle_expires_at, touched.idle_expires_at);
  checks++;

  const other = await login();
  const page = (await request("/api/session/sessions?limit=1")).value;
  assert.equal(page.sessions.length, 1);
  assert(page.next_after_id);
  const next = (
    await request(
      `/api/session/sessions?limit=1&after_id=${encodeURIComponent(page.next_after_id)}`,
    )
  ).value;
  assert.equal(next.sessions.length, 1);
  assert.notEqual(page.sessions[0].id, next.sessions[0].id);
  assert.equal(
    [page.sessions[0], next.sessions[0]].filter((session) => session.current)
      .length,
    1,
  );
  checks++;

  const streamStop = new AbortController();
  const streamStarted = performance.now();
  const streamSignal = AbortSignal.any([
    signal,
    streamStop.signal,
    AbortSignal.timeout(5000),
  ]);
  const stream = await fetch(`${url}/api/admin/agents/agent-1/events/watch`, {
    headers: {
      Origin: origin,
      Cookie: other.cookie,
      Accept: "text/event-stream",
    },
    signal: streamSignal,
  });
  const reader = stream.body.getReader();
  try {
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.getSetCookie().length, 0);
    assert.equal((await reader.read()).done, false);
    const revoked = (
      await request("/api/session/sessions/revoke", {
        method: "POST",
        body: { mode: "others" },
      })
    ).value;
    assert.deepEqual(revoked, { revoked_count: 1, current_revoked: false });
    try {
      while (!(await reader.read()).done) {
        /* Wait for remote closure. */
      }
    } catch (error) {
      // An interrupted reverse proxy may end the HTTP transport without its
      // final chunk. A local deadline/abort must still fail this assertion.
      assert(!streamSignal.aborted);
      assert(error instanceof TypeError && error.message === "terminated");
    }
    // Live polling starts at 10s and the fixture lease is 15s. Only the
    // process-owned private feed can satisfy this earlier close boundary.
    assert(
      performance.now() - streamStarted < 3000,
      "private revocation feed did not close the silent SSE promptly",
    );
    checks++;
  } finally {
    streamStop.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  await request("/api/session", { session: other, status: 401 });
  await request("/api/session");

  checks += await passwordAdmissionChecks({
    request,
    login,
    fixture,
    readEvidence: readPasswordEvidence,
    recordEvidence,
  });

  const wrong = (
    await request("/api/session/password", {
      method: "POST",
      status: 400,
      body: {
        current_password: "incorrect-current",
        new_password: "different-long-password",
      },
    })
  ).value;
  assert.equal(wrong.code, "invalid_current_password");
  const invalid = (
    await request("/api/session/password", {
      method: "POST",
      status: 400,
      body: { current_password: fixture.password, new_password: "short" },
    })
  ).value;
  assert.equal(invalid.code, "invalid_request");
  await request("/api/session");
  const third = await login();
  const newPassword = randomBytes(24).toString("base64url");
  const changed = await request("/api/session/password", {
    method: "POST",
    cookies: true,
    body: { current_password: fixture.password, new_password: newPassword },
  });
  const replacement = jar(changed.response.headers);
  assert.equal(changed.value.expires_at, first.expires_at);
  assert(
    replacement.cookie !== initial.cookie,
    "password rotation reused cookies",
  );
  assert(
    replacement.csrf !== initial.csrf,
    "password rotation reused CSRF delivery",
  );
  checks++;
  await request("/api/session", { status: 401 });
  await request("/api/session", { session: third, status: 401 });
  await request("/api/session", { session: replacement });
  await request("/api/session/activity", {
    session: replacement,
    method: "POST",
    body: {},
    status: 403,
    headers: { "X-Antnest-CSRF-Token": initial.csrf },
  });
  const rotated = (
    await request("/api/session/sessions?limit=100", { session: replacement })
  ).value.sessions;
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].current, true);
  assert.equal(rotated[0].user_agent_hint, initial.hint);
  const all = (
    await request("/api/session/sessions/revoke", {
      session: replacement,
      method: "POST",
      body: { mode: "all" },
    })
  ).value;
  assert.deepEqual(all, { revoked_count: 1, current_revoked: true });
  await request("/api/session", { session: replacement, status: 401 });
  await request("/api/session", {
    session: replacement,
    method: "DELETE",
    status: 401,
    cookies: true,
  });
  const final = await login(newPassword);
  await request("/api/session", {
    session: final,
    method: "DELETE",
    status: 204,
    cookies: true,
  });
  await request("/api/session", { session: final, status: 401 });
  await request("/api/session", {
    session: null,
    method: "DELETE",
    status: 204,
    cookies: true,
  });
  const externalChecks = await externalIdentityChecks({
    request,
    login,
    password: newPassword,
    url,
    origin,
    signal,
  });
  checks += externalChecks;
  return checks;
}
