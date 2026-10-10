import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export async function exerciseBrowserSessions({ rpc, adminPassword }) {
  const baseline = await rpc("list-session-revocations", {
    after_sequence: 0,
    limit: 500,
  });
  const administrator = await rpc("local-login", {
    request_id: randomUUID(),
    organization_slug: "auth-test",
    email: "admin@example.test",
    password: adminPassword,
  });
  const adminContext = await rpc("resolve-access-token", {
    access_token: administrator.access_token,
    profile: "console",
  });
  const originalPassword = randomBytes(24).toString("base64url");
  const newPassword = randomBytes(24).toString("base64url");
  const email = `browser-${randomUUID()}@example.test`;
  const created = await rpc(
    "create-local-user",
    {
      request_id: randomUUID(),
      actor_principal_id: administrator.principal.user_id,
      organization_id: administrator.principal.organization_id,
      email,
      display_name: "Browser session fixture",
      password: originalPassword,
      role: "member",
    },
    { caller: "admin-console", cct: adminContext.caller_context },
  );
  const login = (password, status = 200) =>
    rpc(
      "local-login",
      {
        request_id: randomUUID(),
        organization_slug: "auth-test",
        email,
        password,
        user_agent_hint: "Identity Docker browser <script>",
      },
      { status },
    );
  const first = await login(originalPassword);
  const other = await login(originalPassword);
  assert(
    first.access_token &&
      other.access_token &&
      first.access_token !== other.access_token,
    "logins must issue independent credentials",
  );
  assert.equal(first.principal.user_id, created.user.id);
  assert.equal(first.activity_interval_ms, 30000);
  assert(Date.parse(first.idle_expires_at) < Date.parse(first.expires_at));
  const resolved = await rpc("resolve-access-token", {
    access_token: first.access_token,
    profile: "session",
  });
  const claims = JSON.parse(
    Buffer.from(resolved.caller_context.split(".")[1], "base64url"),
  );
  assert.deepEqual(claims.aud, ["identity-service"]);
  const actor = {
    actor_principal_id: first.principal.user_id,
    user_id: first.principal.user_id,
  };
  const account = {
    actor_principal_id: first.principal.user_id,
    organization_id: first.principal.organization_id,
  };
  const list = { ...actor, scope: "self", limit: 100 };
  const options = { cct: resolved.caller_context };
  const inventory = await rpc("list-user-sessions", list, options);
  assert.equal(inventory.sessions.length, 2);
  assert.equal(
    inventory.sessions.filter((session) => session.current).length,
    1,
  );
  const publicJSON = JSON.stringify(inventory);
  for (const secret of [
    first.access_token,
    other.access_token,
    first.token_id,
    other.token_id,
    createHash("sha256").update(first.access_token).digest("hex"),
  ]) {
    assert(
      !publicJSON.includes(secret),
      "public inventory exposed private authority",
    );
  }
  const before = inventory.sessions.find((session) => session.current);
  const currentAccount = await rpc("get-current-account", account, options);
  assert.equal(currentAccount.account.local_password_available, true);
  assert.equal(currentAccount.account.organization_slug, "auth-test");
  const untouched = await rpc("list-user-sessions", list, options);
  assert.equal(
    untouched.sessions.find((session) => session.current).last_active_at,
    before.last_active_at,
  );
  const activity = await rpc(
    "touch-browser-session",
    { actor_principal_id: first.principal.user_id },
    options,
  );
  assert.equal(activity.expires_at, first.expires_at);
  const touched = await rpc("list-user-sessions", list, options);
  assert.equal(
    touched.sessions.find((session) => session.current).idle_expires_at,
    activity.idle_expires_at,
  );
  assert.equal(
    touched.sessions.find((session) => !session.current).last_active_at,
    inventory.sessions.find((session) => !session.current).last_active_at,
  );
  const revoke = {
    ...actor,
    request_id: randomUUID(),
    scope: "self",
    mode: "others",
  };
  assert.deepEqual(await rpc("revoke-user-sessions", revoke, options), {
    revoked_count: 1,
    current_revoked: false,
  });
  const password = {
    ...actor,
    request_id: randomUUID(),
    current_password: originalPassword,
    new_password: newPassword,
  };
  const wrong = await rpc(
    "change-local-password",
    { ...password, current_password: "wrong current password" },
    { ...options, status: 400 },
  );
  assert.equal(wrong.code, "invalid_argument");
  await rpc("change-local-password", password, {
    ...options,
    caller: "admin-console",
    status: 403,
  });
  const rotated = await rpc("change-local-password", password, options);
  assert(
    rotated.access_token && rotated.access_token !== first.access_token,
    "password must rotate the browser credential",
  );
  assert.equal(rotated.expires_at, first.expires_at);
  await rpc("get-current-account", account, { ...options, status: 401 });
  await rpc("change-local-password", password, { ...options, status: 401 });
  await login(originalPassword, 401);
  await login(newPassword);
  const replacement = await rpc("resolve-access-token", {
    access_token: rotated.access_token,
    profile: "session",
  });
  const replacementOptions = { cct: replacement.caller_context };
  const remaining = await rpc("list-user-sessions", list, replacementOptions);
  assert.equal(remaining.sessions.length, 2);
  assert(
    remaining.sessions.every(
      (session) =>
        session.user_agent_hint === "Identity Docker browser <script>",
    ),
  );
  assert.deepEqual(
    await rpc(
      "revoke-user-sessions",
      { ...revoke, mode: "all" },
      replacementOptions,
    ),
    { revoked_count: 2, current_revoked: true },
  );
  await rpc("get-current-account", account, {
    ...replacementOptions,
    status: 401,
  });
  const feed = await rpc("list-session-revocations", {
    after_sequence: baseline.next_sequence,
    limit: 500,
  });
  assert.equal(feed.events.length, 4);
  assert(
    feed.events.every((event) => event.user_id === first.principal.user_id),
  );
  assert.equal(
    feed.events.filter((event) => event.reason === "password_changed").length,
    1,
  );
  await rpc(
    "list-session-revocations",
    { after_sequence: 0, limit: 500 },
    { caller: "admin-console", cct: adminContext.caller_context, status: 403 },
  );
  const principal = await rpc(
    "list-principal-revocations",
    { after_sequence: 0, limit: 500 },
    { caller: "agent-controller" },
  );
  assert.equal(principal.events.length, 0);
  await rpc(
    "get-current-account",
    {
      actor_principal_id: administrator.principal.user_id,
      organization_id: administrator.principal.organization_id,
    },
    { caller: "admin-console", cct: adminContext.caller_context },
  );
  return {
    complete: true,
    scope:
      "Identity producer only; browser consumers and HTTPS workflow remain separate",
    covered: [
      "session audience",
      "public inventory",
      "non-touch reads",
      "explicit activity",
      "wrong-password preservation",
      "Gateway-only rotation",
      "old SID rejection",
      "new-password login",
      "self others/all",
      "private session feed",
      "no principal offboarding",
      "unrelated administrator preserved",
    ],
  };
}
