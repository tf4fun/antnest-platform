import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { callerContext } from "./auth-fixture.mjs";

export async function verifyOIDCLinking({ request, state, fixture }) {
  let checks = 0;
  let expectDependencyCall = false;
  const expectedContextDigests = [];
  const admin = callerContext(fixture, { sys_role: "admin" });
  const orgAdmin = callerContext(fixture);
  const configuration = "/api/admin/provisioning/oidc-providers";
  const tokens = "/api/admin/provisioning/scim-tokens";
  const chooser = "/api/admin/directory/identity-providers";
  const path = (member) =>
    `/api/admin/directory/memberships/${member}/external-identities`;
  const safe = async (url, options = {}) => {
    const result = await request(url, { context: orgAdmin, ...options });
    if (expectDependencyCall)
      expectedContextDigests.push(
        createHash("sha256")
          .update(options.context ?? orgAdmin)
          .digest("hex"),
      );
    assert.equal(result.response.headers.get("set-cookie"), null);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    for (const value of [
      "private-oidc-secret-canary",
      "private-scim-hash-canary",
      "private-upstream-error-canary",
      "private-notice-canary",
    ])
      assert(!result.text.includes(value), `private field leaked: ${value}`);
    return JSON.parse(result.text);
  };
  let sequence = 0;
  const write = (body, method = "POST") => ({
    method,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `console-oidc-command-${++sequence}`,
    },
  });
  const base = {
    name: "workforce",
    issuer: "https://idp.example.test",
    client_id: "client",
    client_secret: "synthetic-secret",
    scopes: ["openid", "email"],
    enabled: false,
  };
  const beforeInvalid = (await state()).calls;
  await safe(configuration, { status: 403 });
  for (const policy of [
    { link_policy: "none" },
    { acknowledge_link_policy_review: false },
    { link_policy: "none", link_domains: null, authoritative: false },
    { link_policy: "none", link_domains: [], authoritative: null },
    {
      link_policy: "verified_email_in_domains",
      link_domains: ["K.example"],
      authoritative: false,
    },
    {
      link_policy: "verified_email_in_domains",
      link_domains: ["EXAMPLE.COM", "example.com"],
      authoritative: false,
    },
  ])
    await safe(configuration, {
      ...write({ ...base, ...policy }),
      context: admin,
      status: 400,
    });
  for (const oidc_provider_id of [null, "", "bad/id"])
    await safe(tokens, {
      ...write({ name: "Directory", scopes: ["scim:read"], oidc_provider_id }),
      status: 400,
    });
  for (const expires_in_days of [null, 0, 366, 1.5, "90", true])
    await safe(tokens, {
      ...write({ name: "Directory", scopes: ["scim:read"], expires_in_days }),
      status: 400,
    });
  for (const metadata of [
    { issued_by: "forged" },
    { expires_at: "2099-01-01T00:00:00Z" },
    { issuer_review_required: false },
  ])
    await safe(tokens, {
      ...write({ name: "Directory", scopes: ["scim:read"], ...metadata }),
      status: 400,
    });
  for (const query of [
    "",
    "?limit=01",
    "?limit=1&scope=self",
    "?limit=1&organization_id=forged",
    "?limit=1&after_id=",
    "?limit=1&limit=2",
  ])
    await safe(chooser + query, { status: 400 });
  for (const body of [
    { provider_id: "provider-1", subject: "", restore_revoked: false },
    { provider_id: "provider-1", subject: "valid", scope: "self" },
    { provider_id: "provider-1", subject: "valid", restore_revoked: null },
    { provider_id: "provider-1", subject: "valid", organization_id: "forged" },
  ])
    await safe(path("target-member"), { ...write(body), status: 400 });
  await safe(path("target-member") + "/binding-1", {
    ...write({ allow_lockout: null }, "DELETE"),
    status: 400,
  });
  await safe(chooser + "?limit=1", {
    context: callerContext(fixture, { org_role: "member" }),
    status: 403,
  });
  const memberContext = callerContext(fixture, { org_role: "member" });
  await safe(tokens, { context: memberContext, status: 403 });
  await safe(tokens, {
    ...write({ name: "Directory", scopes: ["scim:read"], expires_in_days: 1 }),
    context: memberContext,
    status: 403,
  });
  assert.equal(
    (await state()).calls,
    beforeInvalid,
    "invalid policy, scope and pairing must cause zero dependency effects",
  );
  checks++;

  expectDependencyCall = true;
  const initial = await safe(configuration, { context: admin });
  assert.equal(initial.providers[0].link_policy_review_required, true);
  assert.equal(initial.providers[0].id, undefined);
  assert.equal(initial.providers[0].organization_id, undefined);
  let updated = await safe(configuration, { ...write(base), context: admin });
  assert.equal(updated.provider.link_policy, "verified_email");
  assert.equal(updated.provider.link_policy_review_required, true);
  updated = await safe(configuration + "/workforce/enabled", {
    ...write({ enabled: false }),
    context: admin,
  });
  assert.equal(updated.provider.link_policy_review_required, true);
  updated = await safe(configuration, {
    ...write({
      ...base,
      link_policy: "none",
      link_domains: [],
      authoritative: false,
      acknowledge_link_policy_review: false,
    }),
    context: admin,
  });
  assert.equal(updated.provider.authoritative, false);
  assert.equal(updated.provider.link_policy_review_required, true);
  updated = await safe(configuration, {
    ...write({
      ...base,
      link_policy: "verified_email_in_domains",
      link_domains: ["\uFEFF Example.COM \uFEFF"],
      authoritative: true,
      acknowledge_link_policy_review: true,
    }),
    context: admin,
  });
  assert.deepEqual(updated.provider.link_domains, ["example.com"]);
  assert.equal(updated.provider.link_policy_review_required, false);
  checks++;
  const first = await safe(chooser + "?limit=1", {
    headers: {
      "X-Antnest-Organization-ID": "forged",
      Cookie: "browser=private",
      Authorization: "Bearer private-browser",
    },
  });
  assert.equal(first.providers[0].id, "provider-1");
  assert.equal(first.providers[0].enabled, false);
  assert.deepEqual(
    Object.keys(first.providers[0]).sort(),
    [
      "id",
      "name",
      "display_name",
      "enabled",
      "link_policy",
      "link_domains",
      "authoritative",
      "link_policy_review_required",
    ].sort(),
  );
  assert.equal(first.next_after_id, "provider-1");
  const second = await safe(
    chooser + "?limit=1&after_id=" + first.next_after_id,
  );
  assert.deepEqual(
    second.providers.map((row) => row.id),
    ["provider-2"],
  );
  const legacyInventory = (await safe(tokens)).tokens;
  assert.deepEqual(legacyInventory, [
    {
      id: "legacy-token",
      name: "Legacy directory",
      scopes: ["scim:read"],
      created_at: "2026-10-11T00:00:00Z",
      expires_at: "2027-01-09T00:00:00.000Z",
      issued_by: null,
      issuer_review_required: true,
      oidc_provider_id: null,
    },
  ]);
  const expectedTokens = new Map(legacyInventory.map((row) => [row.id, row]));
  for (const pairing of [undefined, "provider-1"]) {
    const result = await safe(
      tokens,
      write({
        name: "Directory",
        scopes: ["scim:read", "scim:write"],
        ...(pairing ? { oidc_provider_id: pairing } : {}),
      }),
    );
    assert.equal(result.token.oidc_provider_id, pairing ?? null);
    assert.equal(result.token.expires_at, "2027-01-09T00:00:00.000Z");
    assert.equal(result.token.issued_by, "user-admin");
    assert.equal(result.token.issuer_review_required, false);
    assert.equal(result.credential, "one-time-synthetic-credential");
    expectedTokens.set(result.token.id, structuredClone(result.token));
  }
  assert.deepEqual(
    (await safe(tokens)).tokens.map((row) => row.oidc_provider_id),
    [null, null, "provider-1"],
  );
  for (const expires_in_days of [1, 365]) {
    const result = await safe(
      tokens,
      write({
        name: "Bounded directory",
        scopes: ["scim:read"],
        expires_in_days,
      }),
    );
    assert.equal(
      Date.parse(result.token.expires_at) - Date.parse(result.token.created_at),
      expires_in_days * 86400000,
    );
    assert.equal(result.token.issued_by, "user-admin");
    assert.equal(result.token.issuer_review_required, false);
    expectedTokens.set(result.token.id, structuredClone(result.token));
  }
  const tokenInventory = (await safe(tokens)).tokens;
  assert.deepEqual(
    tokenInventory.map((row) => row.id).sort(),
    [...expectedTokens.keys()].sort(),
  );
  for (const token of tokenInventory) {
    assert.deepEqual(token, expectedTokens.get(token.id));
    assert.equal(Object.hasOwn(token, "credential"), false);
    assert.equal(Object.hasOwn(token, "token_hash"), false);
  }
  assert.deepEqual(
    (await state()).externalIdentities
      .filter((call) => call.operation === "issue-scim-token")
      .map((call) => call.expires_in_days),
    [undefined, undefined, 1, 365],
  );
  checks++;
  const bindings = await safe(path("target-member") + "?limit=1");
  assert.equal(bindings.bindings[0].subject, "  <opaque> é 😀  ");
  assert.equal(bindings.bindings[0].organization_id, "org-1");
  assert.equal(bindings.bindings[0].membership_id, "target-member");
  assert.equal(bindings.notices, undefined);
  const next = await safe(
    path("target-member") + "?limit=1&after_id=" + bindings.next_after_id,
  );
  assert.deepEqual(
    next.bindings.map((row) => row.id),
    ["binding-2"],
  );
  const org2 = callerContext(fixture, { org: "org-2", mbr: "member-2" });
  assert.equal(
    (await safe(path("target-member-2") + "?limit=1", { context: org2 }))
      .bindings[0].organization_id,
    "org-2",
  );
  await safe(path("target-member") + "?limit=1", {
    context: org2,
    status: 404,
  });
  for (const [member, status] of [
    ["wrong-org", 502],
    ["private-field", 502],
    ["invalid-subject", 502],
    ["unavailable", 503],
    ["missing", 404],
  ])
    await safe(path(member) + "?limit=1", { status });
  const subject = "  <img src=x> é 😀  ";
  const input = { provider_id: "provider-1", subject, restore_revoked: false };
  assert.equal(
    (await safe(path("target-member"), write(input))).binding.subject,
    subject,
  );
  await safe(path("target-member"), {
    ...write({ ...input, provider_id: "conflict" }),
    status: 409,
    code: "external_identity_conflict",
  });
  await safe(path("target-member"), {
    ...write({ ...input, provider_id: "restore" }),
    status: 409,
    code: "external_identity_restore_required",
  });
  assert.equal(
    (
      await safe(
        path("target-member"),
        write({ ...input, provider_id: "restore", restore_revoked: true }),
      )
    ).binding.provider_id,
    "restore",
  );
  const beforeUnavailable = (await state()).externalIdentities.length;
  await safe(path("target-member"), {
    ...write({ ...input, provider_id: "unavailable" }),
    status: 503,
  });
  assert.equal(
    (await state()).externalIdentities.length,
    beforeUnavailable + 1,
    "BFF must not retry a failed mutation",
  );
  await safe(path("target-member") + "/last-method", {
    ...write({ allow_lockout: false }, "DELETE"),
    status: 409,
    code: "external_identity_last_method",
  });
  assert.deepEqual(
    await safe(
      path("target-member") + "/last-method",
      write({ allow_lockout: true }, "DELETE"),
    ),
    { revoked_count: 1, current_revoked: false },
  );
  assert.deepEqual(
    await safe(
      path("member-1") + "/binding-1",
      write({ allow_lockout: true }, "DELETE"),
    ),
    { revoked_count: 1, current_revoked: true },
  );
  checks++;
  const calls = (await state()).externalIdentities;
  assert.deepEqual(
    calls.map((call) => call.contextDigest),
    expectedContextDigests,
    "every original signed CCT must reach Identity unchanged in request order",
  );
  for (const call of calls) {
    assert.equal(call.actor_principal_id, "user-admin");
    if (call.operation.includes("external-identit"))
      assert.equal(call.organization_id, undefined);
  }
  const omittedPolicy = calls.find(
    (call) => call.operation === "upsert-oidc-provider",
  );
  for (const field of [
    "link_policy",
    "link_domains",
    "authoritative",
    "acknowledge_link_policy_review",
  ])
    assert.equal(Object.hasOwn(omittedPolicy, field), false);
  assert.equal(
    Object.hasOwn(
      calls.find((call) => call.operation === "issue-scim-token"),
      "oidc_provider_id",
    ),
    false,
  );
  checks++;
  return checks;
}
