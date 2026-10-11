import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

export async function exerciseExternalIdentities({
  rpc,
  sql,
  quote,
  register,
  complete,
  restart,
  administrator,
  organizationAdminPassword,
  administer,
}) {
  const provider = await register("bindings");
  assert.equal(provider.link_policy, "none");
  assert.equal(provider.authoritative, false);
  const denied = { status: 403, code: "oidc_membership_required" };
  await complete("bindings", "admin", denied);
  const loginAdmin = () =>
    rpc("local-login", {
      request_id: randomUUID(),
      organization_slug: "auth-test",
      email: "stage3-admin@example.com",
      password: organizationAdminPassword,
    });
  let admin = await loginAdmin();
  assert.equal(admin.principal.system_role, "user");
  assert.equal(admin.principal.organization_role, "admin");
  const context = async (session, profile = "session") =>
    (
      await rpc("resolve-access-token", {
        access_token: session.access_token,
        profile,
      })
    ).caller_context;
  const organization = async (path, body, status = 200) =>
    rpc(
      path,
      {
        actor_principal_id: administrator.user.id,
        ...body,
      },
      { caller: "admin-console", cct: await context(admin, "console"), status },
    );
  const self = async (session, path, body, status = 200) =>
    rpc(
      path,
      {
        actor_principal_id: session.principal.user_id,
        ...body,
      },
      { caller: "edge-gateway", cct: await context(session), status },
    );
  const inventory = (session) =>
    self(session, "list-external-identities", { scope: "self", limit: 100 });
  const fingerprint = () =>
    sql(`SELECT md5(jsonb_build_object(
    'bindings',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM external_identities e),
    'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM external_identity_notices n),
    'tokens',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM api_tokens t),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e),
    'feed',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM session_revocations r),
    'offboarding',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM principal_revocations r)
  )::text)`);
  const bindBody = {
    request_id: randomUUID(),
    membership_id: administrator.membership.id,
    provider_id: provider.id,
    subject: "admin-subject",
  };
  const { binding } = await organization("bind-external-identity", bindBody);
  assert.equal(binding.method, "admin");
  assert.equal(binding.revoked_at, null);
  let before = await fingerprint();
  assert.deepEqual(
    (await organization("bind-external-identity", bindBody)).binding,
    binding,
  );
  assert.equal(
    await fingerprint(),
    before,
    "idempotent binding changed durable state",
  );
  const oidc = await complete("bindings", "admin", {
    userID: administrator.user.id,
  });
  before = await fingerprint();
  const page = await inventory(oidc);
  const oldNotice = page.notices.find((n) => n.binding_id === binding.id);
  assert(oldNotice && oldNotice.id !== binding.id);
  const orgPage = await organization("list-external-identities", {
    scope: "organization",
    membership_id: administrator.membership.id,
    limit: 100,
  });
  assert(!("notices" in orgPage));
  const chooser = await organization("list-external-identity-providers", {
    limit: 100,
  });
  const choice = chooser.providers.find((p) => p.id === provider.id);
  assert.equal(choice.link_policy, "none");
  assert.deepEqual(choice.link_domains, []);
  assert.equal(choice.authoritative, false);
  assert.equal(choice.link_policy_review_required, false);
  for (const response of [page, orgPage, chooser]) {
    for (const key of [
      "user_id",
      "issuer",
      "client_secret",
      "access_token",
      "session_id",
    ])
      assert(
        !JSON.stringify(response).includes(`"${key}"`),
        `private ${key} exposed`,
      );
  }
  assert.equal(
    await fingerprint(),
    before,
    "inventory or resolution touched private state",
  );
  const offboardingBefore = await sql(
    "SELECT count(*) FROM principal_revocations",
  );
  const activeBefore = JSON.parse(
    await sql(
      `SELECT jsonb_agg(id ORDER BY id) FROM api_tokens WHERE membership_id=${quote(administrator.membership.id)} AND kind='browser' AND revoked_at IS NULL`,
    ),
  );
  const unbindRequestID = randomUUID();
  const removed = await self(oidc, "unbind-external-identity", {
    request_id: unbindRequestID,
    scope: "self",
    binding_id: binding.id,
  });
  assert.equal(removed.current_revoked, true);
  assert.equal(removed.revoked_count, activeBefore.length);
  const feed = JSON.parse(
    await sql(`SELECT jsonb_agg(jsonb_build_object('token_id',token_id,'user_id',user_id,'organization_id',organization_id,'reason',reason) ORDER BY token_id)
    FROM session_revocations WHERE token_id IN (${activeBefore.map(quote).join(",")})`),
  );
  assert.deepEqual(
    feed,
    activeBefore.map((token_id) => ({
      token_id,
      user_id: administrator.user.id,
      organization_id: administrator.membership.organization_id,
      reason: "session_revoked",
    })),
  );
  const audit = JSON.parse(
    await sql(`SELECT jsonb_agg(jsonb_build_object('subject_id',subject_id,'actor_principal_id',actor_principal_id,'metadata',metadata))
    FROM identity_events WHERE event_type='external_identity.unbound' AND request_id=${quote(unbindRequestID)}`),
  );
  assert.deepEqual(audit, [
    {
      subject_id: binding.id,
      actor_principal_id: administrator.user.id,
      metadata: {
        provider_id: provider.id,
        membership_id: administrator.membership.id,
        scope: "self",
        allow_lockout: false,
        revoked_count: activeBefore.length,
      },
    },
  ]);
  assert.equal(
    await sql(
      `SELECT count(*) FROM api_tokens WHERE membership_id=${quote(administrator.membership.id)} AND revoked_at IS NULL`,
    ),
    "0",
  );
  assert.equal(
    await sql("SELECT count(*) FROM principal_revocations"),
    offboardingBefore,
  );
  await rpc(
    "resolve-access-token",
    { access_token: oidc.access_token, profile: "session" },
    { status: 401 },
  );
  await complete("bindings", "admin", denied);
  await register("bindings", {
    link_policy: "verified_email",
    link_domains: [],
    authoritative: true,
  });
  await complete("bindings", "admin", denied);
  admin = await loginAdmin();
  before = await fingerprint();
  const refused = await organization("bind-external-identity", bindBody, 409);
  assert.equal(refused.code, "external_identity_restore_required");
  assert.equal(
    await fingerprint(),
    before,
    "implicit restore changed durable state",
  );
  const restored = (
    await organization("bind-external-identity", {
      ...bindBody,
      restore_revoked: true,
    })
  ).binding;
  assert.equal(restored.id, binding.id);
  assert.equal(restored.created_at, binding.created_at);
  assert(Date.parse(restored.bound_at) > Date.parse(binding.bound_at));
  assert.equal(restored.revoked_at, null);
  const restoredSession = await complete("bindings", "admin", {
    userID: administrator.user.id,
  });
  const restoredPage = await inventory(restoredSession);
  const notices = restoredPage.notices.filter(
    (n) => n.binding_id === binding.id,
  );
  assert.equal(notices.length, 2);
  const newNotice = notices.find((n) => n.id !== oldNotice.id);
  before = await fingerprint();
  await self(
    restoredSession,
    "acknowledge-external-identity-notices",
    {
      request_id: randomUUID(),
      notice_ids: [oldNotice.id, "unknown-notice"],
    },
    404,
  );
  assert.equal(
    await fingerprint(),
    before,
    "mixed notice ACK partially committed",
  );
  for (const acknowledged_count of [1, 0]) {
    assert.deepEqual(
      await self(restoredSession, "acknowledge-external-identity-notices", {
        request_id: randomUUID(),
        notice_ids: [oldNotice.id],
      }),
      { acknowledged_count },
    );
  }
  await restart();
  const persisted = await inventory(restoredSession);
  assert.deepEqual(
    persisted.bindings.find((b) => b.id === binding.id),
    restored,
  );
  assert.deepEqual(
    persisted.notices.filter((n) => n.binding_id === binding.id),
    [newNotice],
  );

  // An isolated Membership has just this Provider; seed loss of the local
  // credential, then use only production controls and signed OIDC callbacks.
  const only = await administer("create-local-user", {
    email: "binding-only@example.test",
    display_name: "Binding only",
    role: "member",
    password: randomBytes(24).toString("base64url"),
  });
  const onlyBinding = (
    await organization("bind-external-identity", {
      request_id: randomUUID(),
      membership_id: only.membership.id,
      provider_id: provider.id,
      subject: "local-subject",
    })
  ).binding;
  await sql(
    `DELETE FROM local_credentials WHERE user_id=${quote(only.user.id)}`,
  );
  const onlySession = await complete("bindings", "local", {
    userID: only.user.id,
  });
  const unbind = {
    request_id: randomUUID(),
    scope: "organization",
    membership_id: only.membership.id,
    binding_id: onlyBinding.id,
  };
  before = await fingerprint();
  const last = await organization("unbind-external-identity", unbind, 409);
  assert.equal(last.code, "external_identity_last_method");
  assert.equal(
    await fingerprint(),
    before,
    "last-method denial changed durable state",
  );
  assert.deepEqual(
    await self(onlySession, "unbind-external-identity", {
      request_id: randomUUID(),
      scope: "self",
      binding_id: onlyBinding.id,
      allow_lockout: true,
    }),
    { revoked_count: 1, current_revoked: true },
  );
  await complete("bindings", "local", denied);
  assert.equal(
    await sql(
      `SELECT count(*) FROM external_identities WHERE id IN (${quote(binding.id)},${quote(onlyBinding.id)})`,
    ),
    "2",
  );
  return {
    complete: true,
    covered: [
      "ordinary OrgAdmin prebinding",
      "none rejects administrator email assertions",
      "exact subject independent of email",
      "atomic Membership session revocation without offboarding",
      "revoked subject blocks automatic relinking",
      "explicit restoration and fresh notice",
      "read-only self/organization inventories and chooser",
      "exact-ID ACK retries and restart persistence",
      "last-method guard and explicit self lockout",
    ],
    scope:
      "Identity-owned RPC, PostgreSQL and signed HTTPS IdP callbacks; browser consumers and paired SCIM remain pending",
  };
}
