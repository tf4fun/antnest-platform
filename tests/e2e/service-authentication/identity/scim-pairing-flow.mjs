import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function exerciseSCIMPairing({
  rpc,
  sql,
  quote,
  register,
  complete,
  restart,
  administrator,
  organizationAdminPassword,
  administer,
  identityURL,
  serviceToken,
  signal,
}) {
  const a = await register("scim-pairing-a");
  const b = await register("scim-pairing-b");
  assert.equal(a.link_policy, "none");
  const admin = await rpc("local-login", {
    request_id: randomUUID(),
    organization_slug: "auth-test",
    email: "stage3-admin@example.com",
    password: organizationAdminPassword,
  });
  assert.equal(admin.principal.system_role, "user");
  assert.equal(admin.principal.organization_role, "admin");
  const organization = async (path, body, status = 200) => {
    const { caller_context } = await rpc("resolve-access-token", {
      access_token: admin.access_token,
      profile: "console",
    });
    return rpc(
      path,
      { actor_principal_id: administrator.user.id, ...body },
      {
        caller: "admin-console",
        cct: caller_context,
        status,
      },
    );
  };
  const organization_id = administrator.membership.organization_id;
  const issue = (fields = {}, status = 200) =>
    organization(
      "issue-scim-token",
      {
        request_id: randomUUID(),
        organization_id,
        name: "SCIM pairing acceptance",
        scopes: ["scim:read", "scim:write"],
        ...fields,
      },
      status,
    );
  const snapshot = () =>
    sql(`SELECT md5(jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM users r),
    'members',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM organization_memberships r),
    'scim_tokens',(SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('xmin',r.xmin::text) ORDER BY id) FROM scim_tokens r),
    'groups',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM groups r),
    'group_members',(SELECT jsonb_agg(to_jsonb(r) ORDER BY group_id,organization_membership_id) FROM group_memberships r),
    'bindings',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM external_identities r),
    'notices',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM external_identity_notices r),
    'sessions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM api_tokens r),
    'events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity_events r),
    'sessions_feed',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM session_revocations r),
    'principals_feed',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM principal_revocations r)
  )::text)`);
  for (const oidc_provider_id of [null, "", "https://provider.example", []]) {
    const before = await snapshot();
    await issue({ oidc_provider_id }, 400);
    assert.equal(
      await snapshot(),
      before,
      "invalid pairing issued token or audit",
    );
  }
  for (const fields of [
    ...[null, 0, -1, 366, 1.5, "90", true].map((expires_in_days) => ({
      expires_in_days,
    })),
    { expires_at: "2099-01-01T00:00:00Z" },
    { issued_by: administrator.user.id },
    { issuer_review_required: false },
  ]) {
    const before = await snapshot();
    await issue(fields, 400);
    assert.equal(
      await snapshot(),
      before,
      "invalid lifecycle fields changed state",
    );
  }
  const tokens = [
    await issue({ oidc_provider_id: a.id }),
    await issue({ oidc_provider_id: b.id, expires_in_days: 365 }),
    await issue({ expires_in_days: 1 }),
  ];
  const pairing = [a.id, b.id, null];
  const assertTokenLifecycle = async (result, days) => {
    const { token } = result;
    assert.equal(token.issued_by, administrator.user.id);
    assert.equal(token.issuer_review_required, false);
    assert.equal(typeof token.expires_at, "string");
    assert.equal(
      await sql(`SELECT created_at=${quote(token.created_at)}::timestamptz
        AND expires_at=${quote(token.expires_at)}::timestamptz
        AND expires_at-created_at=interval '${days} days'
        AND issued_by=${quote(administrator.user.id)} AND NOT issuer_review_required
        FROM scim_tokens WHERE id=${quote(token.id)}`),
      "t",
      "RPC lifecycle metadata must match persisted expiry and issuer",
    );
  };
  for (const [index, result] of tokens.entries()) {
    assert.equal(result.token.oidc_provider_id, pairing[index]);
    assert.equal(typeof result.credential, "string");
    assert(!("token_hash" in result.token));
    await assertTokenLifecycle(result, [90, 365, 1][index]);
  }
  const [tokenA, tokenB, legacy] = tokens;
  await restart();
  const listed = (await organization("list-scim-tokens", { organization_id }))
    .tokens;
  tokens.forEach((result, index) => {
    const metadata = listed.find((t) => t.id === result.token.id);
    assert.deepEqual(
      metadata,
      result.token,
      "restart changed public token metadata",
    );
    assert.equal(metadata.oidc_provider_id, pairing[index]);
    assert(!("credential" in metadata) && !("token_hash" in metadata));
  });
  let checks = 0;
  const request = async (
    token,
    method,
    path,
    body,
    status = 200,
    scimType,
    ifMatch,
  ) => {
    const before = status >= 400 ? await snapshot() : undefined;
    const response = await fetch(`${identityURL()}/scim/v2/${path}`, {
      method,
      signal,
      redirect: "error",
      headers: {
        "content-type": "application/scim+json",
        "Antnest-Service-Authorization": `Bearer ${serviceToken}`,
        Authorization: `Bearer ${token.credential}`,
        ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string" || Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body),
    });
    assert.equal(response.status, status, `SCIM ${method} ${path}`);
    const result = status === 204 ? undefined : await response.json();
    const resourceRoute = /^(Users|Groups)(?:\/[^/?]+)?(?:\?.*)?$/u.exec(path);
    const collectionRead =
      method === "GET" && !path.split("?")[0].includes("/");
    if (status < 400 && status !== 204 && resourceRoute && !collectionRead) {
      assert.equal(
        result.meta.resourceType,
        resourceRoute[1] === "Users" ? "User" : "Group",
      );
      assert.match(result.meta.version, /^W\/"(?:0|-?[1-9][0-9]*)"$/u);
      assert.equal(response.headers.get("etag"), result.meta.version);
    }
    if (status < 400 && resourceRoute && collectionRead) {
      assert(
        Array.isArray(result.Resources),
        "SCIM list must return a Resources array",
      );
      for (const row of result.Resources) {
        assert.equal(
          row.meta.resourceType,
          resourceRoute[1] === "Users" ? "User" : "Group",
        );
        assert.match(row.meta.version, /^W\/"(?:0|-?[1-9][0-9]*)"$/u);
      }
    }
    if (status >= 400) {
      assert.equal(result.status, String(status));
      if (scimType) assert.equal(result.scimType, scimType);
      assert.equal(
        await snapshot(),
        before,
        "rejected SCIM request changed business state",
      );
    }
    checks++;
    return result;
  };
  assert.equal(
    (await request(legacy, "GET", "ServiceProviderConfig")).etag.supported,
    true,
  );
  const expired = await issue({
    name: "Expired credential acceptance",
    expires_in_days: 1,
  });
  await assertTokenLifecycle(expired, 1);
  await sql(`UPDATE scim_tokens SET expires_at=created_at+interval '1 microsecond'
    WHERE id=${quote(expired.token.id)}`);
  await request(expired, "GET", "Users", undefined, 401);
  const assertStoredUserMetadata = async (token, created) => {
    const stored = await request(token, "GET", `Users/${created.id}`);
    for (const field of ["created", "lastModified"]) {
      assert.equal(typeof created.meta[field], "string");
      assert.equal(
        created.meta[field],
        stored.meta[field],
        `SCIM POST ${field} must match the persisted GET metadata`,
      );
    }
  };
  const user = (fields = {}) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "scim-paired@example.test",
    displayName: "SCIM paired",
    active: true,
    ...fields,
  });
  const patch = (...Operations) => ({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations,
  });
  for (const fields of [
    {},
    ...[null, "", 1, "\u0000", "\ud800", "界".repeat(256)].map(
      (externalId) => ({ externalId }),
    ),
  ])
    await request(tokenA, "POST", "Users", user(fields), 400, "invalidValue");
  const rawPrefix = JSON.stringify(user()).slice(0, -1);
  await request(
    tokenA,
    "POST",
    "Users",
    `${rawPrefix},"externalId":"bad","ExternalID":"scim-subject"}`,
    400,
    "invalidValue",
  );
  await request(
    tokenA,
    "POST",
    "Users",
    Buffer.concat([
      Buffer.from(`${rawPrefix},"externalId":"`),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
    400,
    "invalidValue",
  );
  let resource = await request(
    tokenA,
    "POST",
    "Users",
    user({ externalId: "scim-subject" }),
    201,
  );
  await assertStoredUserMetadata(tokenA, resource);
  const firstMember = resource.id;
  const userID = await sql(
    `SELECT user_id FROM organization_memberships WHERE id=${quote(resource.id)}`,
  );
  const binding = JSON.parse(
    await sql(
      `SELECT row_to_json(e) FROM external_identities e WHERE membership_id=${quote(resource.id)}`,
    ),
  );
  assert.equal(binding.method, "scim");
  assert.equal(binding.subject, "scim-subject");
  assert.equal(binding.provider_id, a.id);
  assert.equal(binding.revoked_at, null);
  assert.equal(
    await sql(
      `SELECT actor_scim_token_id FROM identity_events WHERE event_type='external_identity.bound' AND subject_id=${quote(binding.id)}`,
    ),
    tokenA.token.id,
  );
  const activation = () =>
    sql(`SELECT jsonb_build_object(
    'binding',(SELECT to_jsonb(e)-'membership_id'-'updated_at' FROM external_identities e WHERE id=${quote(binding.id)}),
    'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM external_identity_notices n WHERE binding_id=${quote(binding.id)}),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e WHERE event_type='external_identity.bound' AND subject_id=${quote(binding.id)})
  )::text`);
  const initialActivation = await activation();
  const initialNotices = JSON.parse(initialActivation).notices;
  assert.equal(initialNotices.length, 1);
  const [notice] = initialNotices;
  assert.equal(typeof notice.id, "string");
  assert.notEqual(notice.id, binding.id);
  for (const [key, value] of Object.entries({
    user_id: userID,
    binding_id: binding.id,
    provider_id: a.id,
    organization_id,
    membership_id: resource.id,
    subject: "scim-subject",
    method: "scim",
  }))
    assert.equal(notice[key], value);
  assert.equal(notice.acknowledged_at, null);
  const signedIn = await complete("scim-pairing-a", "scim", { userID });
  assert.equal(signedIn.principal.membership_id, resource.id);
  for (const token of [tokenA, tokenB, legacy]) {
    const replaced = await request(
      token,
      "PUT",
      `Users/${resource.id}`,
      user(),
    );
    assert.equal(replaced.externalId, "scim-subject");
    await request(
      token,
      "PATCH",
      `Users/${resource.id}`,
      patch({ op: "replace", path: "displayName", value: "Directory update" }),
    );
    for (const externalId of ["other", "", null, " scim-subject "])
      await request(
        token,
        "PUT",
        `Users/${resource.id}`,
        user({ externalId }),
        400,
        "invalidValue",
      );
    await request(
      token,
      "PATCH",
      `Users/${resource.id}`,
      patch(
        { op: "remove", path: "externalId" },
        { op: "add", path: "externalId", value: "scim-subject" },
      ),
      400,
      "invalidValue",
    );
    const page = await request(token, "GET", "Users");
    assert(page.Resources.some((r) => r.id === resource.id));
  }
  await request(
    tokenB,
    "PATCH",
    `Users/${resource.id}`,
    `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"remove","path":"externalId"}],"operations":[{"op":"replace","path":"displayName","value":"overwritten"}]}`,
    400,
    "invalidValue",
  );
  assert.equal(
    await activation(),
    initialActivation,
    "directory CRUD altered binding activation",
  );
  const group = await request(
    tokenB,
    "POST",
    "Groups",
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Shared directory group",
      members: [{ value: resource.id }],
    },
    201,
  );
  assert.equal(
    (await request(legacy, "GET", `Groups/${group.id}`)).members[0].value,
    resource.id,
  );
  await organization("bind-external-identity", {
    request_id: randomUUID(),
    membership_id: administrator.membership.id,
    provider_id: b.id,
    subject: "local-subject",
  });
  await request(
    tokenB,
    "POST",
    "Users",
    user({ externalId: "local-subject", userName: "no-steal@example.test" }),
    409,
    "uniqueness",
  );
  const opaque = " opaque/界/🙂 ";
  const opaqueResource = await request(
    tokenB,
    "POST",
    "Users",
    user({ externalId: opaque, userName: "opaque@example.test" }),
    201,
  );
  assert.equal(opaqueResource.externalId, opaque);
  // SQL output is trimmed by the Docker transport; check byte-exact storage in SQL.
  assert.equal(
    await sql(
      `SELECT subject=${quote(opaque)} FROM external_identities WHERE membership_id=${quote(opaqueResource.id)}`,
    ),
    "t",
  );
  const legacyResource = await request(
    legacy,
    "POST",
    "Users",
    user({ userName: "legacy-pairing@example.test" }),
    201,
  );
  await assertStoredUserMetadata(legacy, legacyResource);
  assert.equal(
    await sql(
      `SELECT scim_oidc_provider_id IS NULL FROM organization_memberships WHERE id=${quote(legacyResource.id)}`,
    ),
    "t",
  );
  assert.equal(
    await sql(
      `SELECT count(*) FROM external_identities WHERE membership_id=${quote(legacyResource.id)}`,
    ),
    "0",
  );
  await request(tokenA, "DELETE", `Users/${resource.id}`, undefined, 204);
  await rpc(
    "resolve-access-token",
    { access_token: signedIn.access_token, profile: "session" },
    { status: 401 },
  );
  assert.equal(
    await sql(
      `SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=${quote(signedIn.token_id)}`,
    ),
    "t",
  );
  assert.deepEqual(
    JSON.parse(
      await sql(`SELECT jsonb_agg(jsonb_build_object('token_id',token_id,'user_id',user_id,'organization_id',organization_id,'reason',reason))
    FROM session_revocations WHERE token_id=${quote(signedIn.token_id)}`),
    ),
    [
      {
        token_id: signedIn.token_id,
        user_id: userID,
        organization_id,
        reason: "membership_deleted",
      },
    ],
  );
  assert.equal(
    (await request(tokenB, "GET", `Groups/${group.id}`)).members.length,
    0,
  );
  assert.equal(
    await sql(
      `SELECT count(*) FROM principal_revocations WHERE user_id=${quote(userID)} AND reason='membership_deleted'`,
    ),
    "1",
  );
  for (const token of [tokenB, legacy])
    await request(
      token,
      "POST",
      "Users",
      user({ externalId: "scim-subject" }),
      409,
      "uniqueness",
    );
  resource = await request(
    tokenA,
    "POST",
    "Users",
    user({ externalId: "scim-subject" }),
    201,
  );
  await assertStoredUserMetadata(tokenA, resource);
  assert.notEqual(resource.id, firstMember);
  assert.equal(
    await sql(
      `SELECT user_id FROM organization_memberships WHERE id=${quote(resource.id)}`,
    ),
    userID,
  );
  assert.equal(
    await activation(),
    initialActivation,
    "reprovision changed activation, audit or notice",
  );
  assert.equal(
    await sql(
      `SELECT membership_id FROM external_identities WHERE id=${quote(binding.id)}`,
    ),
    resource.id,
  );
  const fresh = await complete("scim-pairing-a", "scim", { userID });
  assert.equal(fresh.principal.membership_id, resource.id);
  await organization("unbind-external-identity", {
    request_id: randomUUID(),
    scope: "organization",
    membership_id: resource.id,
    binding_id: binding.id,
    allow_lockout: true,
  });
  const revokedActivation = await activation();
  const revokedMember = resource.id;
  await request(legacy, "DELETE", `Users/${resource.id}`, undefined, 204);
  resource = await request(
    tokenA,
    "POST",
    "Users",
    user({ externalId: "scim-subject", userName: "oidc-scim@example.com" }),
    201,
  );
  await assertStoredUserMetadata(tokenA, resource);
  assert.notEqual(resource.id, revokedMember);
  assert.equal(
    await sql(
      `SELECT user_id FROM organization_memberships WHERE id=${quote(resource.id)}`,
    ),
    userID,
  );
  assert.equal(
    await sql(
      `SELECT membership_id FROM external_identities WHERE id=${quote(binding.id)}`,
    ),
    resource.id,
  );
  assert.equal(
    await activation(),
    revokedActivation,
    "SCIM reprovision restored explicit unbind",
  );
  await register("scim-pairing-a", {
    link_policy: "verified_email",
    link_domains: [],
    authoritative: false,
  });
  const denied = { status: 403, code: "oidc_membership_required" };
  await complete("scim-pairing-a", "scim", denied);
  await restart();
  assert.equal(await activation(), revokedActivation);
  assert.equal(
    (await request(tokenA, "GET", `Users/${resource.id}`)).externalId,
    "scim-subject",
  );
  await complete("scim-pairing-a", "scim", denied);

  // Exercise wire conditions against independent resources so the established
  // binding/reprovision assertions above retain their original lineage.
  const versionUser = await request(
    legacy,
    "POST",
    "Users",
    user({
      userName: "scim-versions@example.test",
      displayName: "Versioned user",
    }),
    201,
  );
  const groupBody = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: "Versioned group",
    members: [{ value: versionUser.id }],
  };
  const versionGroup = await request(legacy, "POST", "Groups", groupBody, 201);
  for (const [collection, created, body] of [
    ["Groups", versionGroup, groupBody],
    ["Users", versionUser, user({ userName: "scim-versions@example.test" })],
  ]) {
    const path = `${collection}/${created.id}`;
    assert.equal(
      (await request(legacy, "GET", path)).meta.version,
      created.meta.version,
    );
    const page = await request(legacy, "GET", collection);
    assert.equal(
      page.Resources.find((row) => row.id === created.id).meta.version,
      created.meta.version,
    );
    const replaced = await request(
      legacy,
      "PUT",
      path,
      { ...body, displayName: "Conditional replacement" },
      200,
      undefined,
      created.meta.version,
    );
    assert.notEqual(replaced.meta.version, created.meta.version);
    const change = patch({
      op: "replace",
      path: "displayName",
      value: "Conditional patch",
    });
    await request(
      legacy,
      "PATCH",
      path,
      change,
      412,
      "mutability",
      created.meta.version,
    );
    await request(
      legacy,
      "PUT",
      path,
      body,
      400,
      "invalidSyntax",
      'W/"unterminated',
    );
    const patched = await request(
      legacy,
      "PATCH",
      path,
      change,
      200,
      undefined,
      replaced.meta.version,
    );
    assert.equal(patched.displayName, "Conditional patch");
    assert.notEqual(patched.meta.version, replaced.meta.version);
    await request(
      legacy,
      "DELETE",
      path,
      undefined,
      412,
      "mutability",
      created.meta.version,
    );
    const unconditional = await request(legacy, "PUT", path, body);
    assert.notEqual(unconditional.meta.version, patched.meta.version);
    await request(
      legacy,
      "DELETE",
      path,
      undefined,
      204,
      undefined,
      unconditional.meta.version,
    );
    await request(legacy, "GET", path, undefined, 404);
  }

  const tokenRows = (ids) =>
    sql(`SELECT md5(jsonb_agg(
    to_jsonb(t)||jsonb_build_object('xmin',t.xmin::text) ORDER BY id)::text)
    FROM scim_tokens t WHERE id IN (${ids.map(quote).join(",")})`);
  const original = await tokenRows([tokenA.token.id]);
  const rotated = await issue({
    name: tokenA.token.name,
    scopes: tokenA.token.scopes,
    oidc_provider_id: tokenA.token.oidc_provider_id,
    expires_in_days: 7,
  });
  await assertTokenLifecycle(rotated, 7);
  assert.notEqual(rotated.token.id, tokenA.token.id);
  assert(
    rotated.credential !== tokenA.credential,
    "rotation must return a new credential",
  );
  for (const field of ["name", "scopes", "oidc_provider_id"])
    assert.deepEqual(
      rotated.token[field],
      tokenA.token[field],
      `rotation changed ${field}`,
    );
  assert.equal(
    await sql(`SELECT name=${quote(tokenA.token.name)}
    AND to_jsonb(scopes)=${quote(JSON.stringify(tokenA.token.scopes))}::jsonb
    AND oidc_provider_id=${quote(tokenA.token.oidc_provider_id)}
    FROM scim_tokens WHERE id=${quote(rotated.token.id)}`),
    "t",
    "rotation did not persist the original configuration",
  );
  assert.equal(
    await tokenRows([tokenA.token.id]),
    original,
    "rotation changed original token row",
  );
  await request(rotated, "GET", `Users/${resource.id}`);
  assert.equal(
    await tokenRows([tokenA.token.id]),
    original,
    "new credential use changed original token",
  );
  await request(tokenA, "GET", `Users/${resource.id}`);
  await organization("revoke-scim-token", { token_id: tokenA.token.id });
  await request(tokenA, "GET", "Users", undefined, 401);
  const adopted = await request(
    rotated,
    "PATCH",
    `Users/${resource.id}`,
    patch({
      op: "replace",
      path: "displayName",
      value: "Rotated credential adopted",
    }),
  );
  assert.equal(adopted.displayName, "Rotated credential adopted");

  // All remaining issuer credentials work before self-demotion. Its own
  // session is deliberately revoked, so restoration uses the bootstrap actor.
  const liveTokens = [tokenB, legacy, rotated];
  for (const token of liveTokens) {
    await request(token, "GET", "Users");
    assert.equal(
      await sql(`SELECT revoked_at IS NULL AND expires_at>now()
      FROM scim_tokens WHERE id=${quote(token.token.id)}`),
      "t",
    );
  }
  const membership = {
    organization_id,
    membership_id: administrator.membership.id,
    email: administrator.membership.email,
    display_name: administrator.membership.display_name,
    active: true,
  };
  await organization("update-membership", {
    request_id: randomUUID(),
    ...membership,
    role: "member",
  });
  for (const token of liveTokens) {
    await request(token, "GET", "Users", undefined, 401);
    assert.equal(
      await sql(`SELECT revoked_at IS NOT NULL FROM scim_tokens
      WHERE id=${quote(token.token.id)}`),
      "t",
    );
    assert.equal(
      await sql(`SELECT count(*) FROM identity_events
      WHERE subject_id=${quote(token.token.id)} AND event_type='scim_token.revoked'
      AND actor_principal_id=${quote(administrator.user.id)}
      AND metadata->>'reason'='issuer_authority_lost'`),
      "1",
    );
  }
  const revokedRows = await tokenRows(
    liveTokens.map((token) => token.token.id),
  );
  await administer("update-membership", { ...membership, role: "admin" });
  assert.equal(
    await sql(`SELECT role FROM organization_memberships
    WHERE id=${quote(administrator.membership.id)}`),
    "admin",
  );
  assert.equal(
    await tokenRows(liveTokens.map((token) => token.token.id)),
    revokedRows,
    "restoring issuer authority rewrote revoked credentials",
  );
  for (const token of liveTokens)
    await request(token, "GET", "Users", undefined, 401);
  await rpc(
    "resolve-access-token",
    { access_token: admin.access_token, profile: "console" },
    { status: 401 },
  );
  return {
    complete: true,
    checks,
    covered: [
      "immutable A/B/NULL token pairing across restart",
      "strict opaque subject and duplicate JSON refusal",
      "atomic SCIM binding/audit/notice",
      "same-organization directory CRUD through other pairings",
      "ownership collisions",
      "exact-lineage reprovision and deletion offboarding",
      "reprovision preserves activation and revoked tombstones",
      "bounded TTL and exact persisted issuer/expiry metadata",
      "expired credential refusal with unchanged usage and token xmin",
      "User/Group ETag, list versions and conditional mutation rollback",
      "same-pairing overlap rotation with explicit old-credential revocation",
      "issuer self-demotion revokes live credentials; restored authority does not revive them",
    ],
    scope:
      "Identity-owned SCIM HTTP, PostgreSQL and signed HTTPS IdP callbacks; browser consumers and cross-service acceptance remain pending",
  };
}
