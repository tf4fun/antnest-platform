import assert from "node:assert/strict";

// The real Gateway consumes an authenticated Identity wire double here.
// Durable binding/ACK transactions are admitted by the Identity and integration suites.
export async function externalIdentityChecks({
  request,
  login,
  password,
  url,
  origin,
  signal,
}) {
  let checks = 0;
  const owner = await login(password);
  const other = await login(password);
  const call = (path, options = {}) =>
    request(path, { session: owner, ...options });
  const path = "/api/session/external-identities";
  const before = (await call("/api/session")).value;
  const first = (await call(`${path}?limit=1`)).value;
  assert.equal(first.bindings.length, 1);
  assert.equal(first.notices.length, 1);
  assert.equal(first.next_after_id, "binding-1");
  assert.equal(first.next_notice_after_id, "notice-1");
  const second = (
    await call(
      `${path}?limit=1&after_id=${first.next_after_id}&notice_after_id=${first.next_notice_after_id}`,
    )
  ).value;
  assert.equal(second.bindings[0].id, "binding-2");
  assert.equal(second.bindings[0].organization_id, "other-organization");
  assert.equal(second.bindings[0].provider_enabled, false);
  assert.equal(second.bindings[0].subject, "  opaque 界 😀 \t");
  assert.equal(second.notices[0].membership_id, "historical-membership");
  assert.equal(second.notices[0].binding_id, "old-binding");
  const independent = (await call(`${path}?limit=1&after_id=binding-3`)).value;
  assert.deepEqual(independent.bindings, []);
  assert.equal(independent.next_after_id, undefined);
  assert.equal(independent.notices[0].id, "notice-1");
  assert.equal(independent.next_notice_after_id, "notice-1");
  const all = (await call(`${path}?limit=100`)).value;
  assert.equal(all.bindings.length, 3);
  assert.equal(all.notices.length, 3);
  assert.equal(all.next_after_id, undefined);
  assert.equal(all.next_notice_after_id, undefined);
  assert(all.bindings[2].revoked_at);
  checks += 4;

  await call(`${path}?limit=1&scope=organization`, { status: 400 });
  await call(`${path}?limit=01`, { status: 400 });
  for (const body of [
    { allow_lockout: null },
    { scope: "organization" },
    { actor_principal_id: "forged" },
  ])
    await call(`${path}/binding-1`, { method: "DELETE", body, status: 400 });
  for (const body of [
    { notice_ids: [] },
    { notice_ids: ["notice-1", "notice-1"] },
    { notice_ids: ["notice-1"], actor_principal_id: "forged" },
  ])
    await call(`${path}/notices/acknowledge`, {
      method: "POST",
      body,
      status: 400,
    });
  for (const headers of [
    { "X-Antnest-CSRF-Token": "forged" },
    { Origin: "https://foreign.example" },
  ])
    await call(`${path}/notices/acknowledge`, {
      method: "POST",
      body: { notice_ids: ["notice-1"] },
      status: 403,
      headers,
    });
  assert.equal((await call(`${path}?limit=100`)).value.notices.length, 3);
  checks++;

  const acknowledge = (ids, status = 200) =>
    call(`${path}/notices/acknowledge`, {
      method: "POST",
      body: { notice_ids: ids },
      status,
    });
  assert.deepEqual((await acknowledge(["notice-1"])).value, {
    acknowledged_count: 1,
  });
  assert.deepEqual((await acknowledge(["notice-1"])).value, {
    acknowledged_count: 0,
  });
  assert.equal(
    (await acknowledge(["notice-2", "missing-notice"], 404)).value.code,
    "not_found",
  );
  assert.deepEqual(
    (await call(`${path}?limit=100`)).value.notices.map((notice) => notice.id),
    ["notice-2", "notice-3"],
  );
  checks += 3;

  const unbind = (id, body = {}, status = 200) =>
    call(`${path}/${id}`, { method: "DELETE", body, status });
  assert.equal(
    (await unbind("missing-binding", {}, 404)).value.code,
    "not_found",
  );
  assert.deepEqual((await unbind("binding-2")).value, {
    revoked_count: 0,
    current_revoked: false,
  });
  assert.deepEqual((await unbind("binding-2")).value, {
    revoked_count: 0,
    current_revoked: false,
  });
  assert.equal(
    (await unbind("binding-1", {}, 409)).value.code,
    "external_identity_last_method",
  );
  const after = (await call("/api/session")).value;
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.idle_expires_at, before.idle_expires_at);
  checks += 4;

  const stop = new AbortController();
  const streamSignal = AbortSignal.any([
    signal,
    stop.signal,
    AbortSignal.timeout(5000),
  ]);
  const started = performance.now();
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
    assert.deepEqual(
      (await unbind("binding-1", { allow_lockout: true })).value,
      {
        revoked_count: 2,
        current_revoked: true,
      },
    );
    try {
      while (!(await reader.read()).done) {
        // Remote feed cancellation, before ordinary live polling or CCT expiry.
      }
    } catch (error) {
      assert(!streamSignal.aborted);
      assert(error instanceof TypeError && error.message === "terminated");
    }
    assert(
      performance.now() - started < 3000,
      "unbind did not retire silent SSE",
    );
    checks++;
  } finally {
    stop.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  await call("/api/session", { status: 401 });
  await call("/api/session", { session: other, status: 401 });
  return checks;
}
