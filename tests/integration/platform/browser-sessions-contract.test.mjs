import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const read = (path) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${path}`, import.meta.url),
      "utf8",
    ),
  );
const identity = read("identity/identity-contract.json");
const gateway = read("edge-gateway/session-contract.json");
const browser = read("edge-gateway/session-response.schema.json");
const rollout = read("platform/service-authentication-rollout.json");

function compiler() {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
  ajv.addKeyword({ keyword: "secret", schemaType: "boolean" });
  // Existing email/URI behavior is outside this contract test. Timestamp fields
  // must actually use the date-time format; invalid values cannot pass silently.
  ajv.addFormat("email", true);
  ajv.addFormat("uri", true);
  ajv.addFormat("date-time", {
    type: "string",
    validate(value) {
      const parts =
        /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u.exec(
          value,
        );
      if (!parts) return false;
      const [
        ,
        year,
        month,
        day,
        hour,
        minute,
        second,
        offsetHour = "0",
        offsetMinute = "0",
      ] = parts;
      const leap =
        Number(year) % 4 === 0 &&
        (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return (
        Number(month) >= 1 &&
        Number(month) <= 12 &&
        Number(day) >= 1 &&
        Number(day) <= days[Number(month) - 1] &&
        Number(hour) <= 23 &&
        Number(minute) <= 59 &&
        Number(second) <= 59 &&
        Number(offsetHour) <= 23 &&
        Number(offsetMinute) <= 59
      );
    },
  });
  return ajv;
}

function identityValidator(schema) {
  assert(schema, "Identity must publish the session schema");
  return compiler().compile({ definitions: identity.definitions, ...schema });
}

function externalValidator(name) {
  assert(browser.$defs[name], `missing browser ${name} schema`);
  return compiler().compile({ $defs: browser.$defs, $ref: `#/$defs/${name}` });
}

function rejectsInvalidRootsAndMissing(
  validate,
  value,
  required = Object.keys(value),
) {
  for (const candidate of [
    null,
    [],
    true,
    12,
    "object",
    { ...value, private_field: "secret" },
  ])
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  for (const field of required) {
    const candidate = { ...value };
    delete candidate[field];
    assert.equal(validate(candidate), false, `missing ${field}`);
  }
}

function methodValidator(name, direction) {
  assert(identity.methods[name], `missing Identity method: ${name}`);
  return identityValidator(identity.methods[name][direction]);
}

const session = {
  id: "session-public-reference",
  organization_id: "org-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  created_at: "2026-10-10T12:00:00Z",
  last_active_at: "2026-10-10T12:10:00Z",
  idle_expires_at: "2026-10-10T12:40:00Z",
  expires_at: "2026-10-11T00:00:00Z",
  user_agent_hint: "Test browser",
  current: true,
};
const actor = { actor_principal_id: "user-1", user_id: "user-1" };
const list = { ...actor, scope: "self", limit: 50 };

test("session inventory discloses only bounded browser metadata", () => {
  const validate = identityValidator(identity.definitions.browser_session);
  assert(validate(session), JSON.stringify(validate.errors));
  for (const field of [
    "token_id",
    "sid",
    "access_token",
    "token_hash",
    "caller_context",
    "credential",
  ])
    assert.equal(validate({ ...session, [field]: "private" }), false, field);
  rejectsInvalidRootsAndMissing(validate, session);
  for (const field of [
    "created_at",
    "last_active_at",
    "idle_expires_at",
    "expires_at",
  ])
    for (const invalid of [
      "not-a-date",
      "2026-02-30T12:00:00Z",
      "2026-10-10",
      "2026-10-10T25:00:00Z",
    ])
      assert.equal(
        validate({ ...session, [field]: invalid }),
        false,
        `${field}: ${invalid}`,
      );
  for (const field of Object.keys(session)) {
    const candidate = { ...session };
    delete candidate[field];
    assert.equal(validate(candidate), false, `missing ${field}`);
  }
  for (const candidate of [
    { ...session, id: "" },
    { ...session, current: "true" },
    { ...session, user_agent_hint: "x".repeat(257) },
    { ...session, organization_name: "" },
  ])
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
});

test("session list pagination cannot carry caller-controlled organization or private sid", () => {
  const validate = methodValidator("list_user_sessions", "request");
  assert(validate(list), JSON.stringify(validate.errors));
  rejectsInvalidRootsAndMissing(validate, list);
  assert(
    validate({
      ...list,
      scope: "organization",
      user_id: "user-2",
      after_id: session.id,
    }),
  );
  for (const candidate of [
    { ...list, limit: 0 },
    { ...list, limit: 101 },
    { ...list, limit: 1.5 },
    { ...list, scope: "all" },
    { ...list, organization_id: "org-2" },
    { ...list, current_token_id: "private" },
    { ...list, after_id: "" },
    { ...list, actor_principal_id: " user-1 " },
  ])
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  const response = methodValidator("list_user_sessions", "response");
  assert(response({ sessions: [session] }), JSON.stringify(response.errors));
  rejectsInvalidRootsAndMissing(response, { sessions: [session] });
  assert(response({ sessions: [session], next_after_id: session.id }));
  assert(response({ sessions: [] }));
  assert.equal(response({ sessions: [], next_after_id: "" }), false);
  assert.equal(response({ sessions: Array(101).fill(session) }), false);
  assert.equal(
    response({ sessions: [{ ...session, token_id: "private" }] }),
    false,
  );
});

test("revocation schema excludes caller-selected private current-session identifiers", () => {
  const validate = methodValidator("revoke_user_sessions", "request");
  const command = {
    ...actor,
    request_id: "revoke-1",
    scope: "self",
    mode: "others",
  };
  assert(validate(command), JSON.stringify(validate.errors));
  rejectsInvalidRootsAndMissing(validate, command);
  assert(validate({ ...command, mode: "all" }));
  assert(
    validate({
      ...command,
      scope: "organization",
      user_id: "user-2",
      mode: "all",
    }),
  );
  for (const candidate of [
    { ...command, scope: "organization" },
    { ...command, mode: "one" },
    { ...command, except_token_id: "private" },
    { ...command, current_token_id: "private" },
    { ...command, organization_id: "org-2" },
    { ...command, access_token: "secret" },
  ])
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  const response = methodValidator("revoke_user_sessions", "response");
  assert(response({ revoked_count: 2, current_revoked: false }));
  rejectsInvalidRootsAndMissing(response, {
    revoked_count: 2,
    current_revoked: false,
  });
  assert.equal(response({ revoked_count: -1, current_revoked: false }), false);
  assert.equal(
    response({
      revoked_count: 1,
      current_revoked: false,
      access_token: "secret",
    }),
    false,
  );
});

test("session feed is separate from Controller offboarding and has bounded cursors", () => {
  const validate = identityValidator(identity.definitions.session_revocation);
  const event = {
    sequence: 1,
    token_id: "private-token-1",
    user_id: "user-1",
    organization_id: "org-1",
    reason: "session_revoked",
    occurred_at: "2026-10-10T12:00:00Z",
  };
  assert(validate(event), JSON.stringify(validate.errors));
  rejectsInvalidRootsAndMissing(validate, event);
  for (const occurred_at of [
    "not-a-date",
    "2026-02-30T12:00:00Z",
    "2026-10-10T25:00:00Z",
  ])
    assert.equal(validate({ ...event, occurred_at }), false);
  for (const reason of [
    "password_changed",
    "role_changed",
    "user_deactivated",
    "membership_deactivated",
    "membership_deleted",
  ])
    assert(validate({ ...event, reason }), reason);
  for (const candidate of [
    { ...event, reason: "unknown" },
    { ...event, sequence: 0 },
    { ...event, access_token: "secret" },
  ])
    assert.equal(validate(candidate), false);
  assert.deepEqual(identity.definitions.principal_revocation, {
    type: "object",
    additionalProperties: false,
    required: ["sequence", "user_id", "reason", "occurred_at"],
    properties: {
      sequence: {
        type: "integer",
        minimum: 1,
      },
      user_id: {
        $ref: "#/definitions/id",
      },
      organization_id: {
        $ref: "#/definitions/id",
      },
      reason: {
        type: "string",
        enum: [
          "user_deactivated",
          "membership_deactivated",
          "membership_deleted",
        ],
      },
      occurred_at: {
        $ref: "#/definitions/timestamp",
      },
      traceparent: {
        type: "string",
        pattern: "^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
      },
    },
    oneOf: [
      {
        properties: {
          reason: {
            const: "user_deactivated",
          },
        },
        not: {
          required: ["organization_id"],
        },
      },
      {
        properties: {
          reason: {
            enum: ["membership_deactivated", "membership_deleted"],
          },
        },
        required: ["organization_id"],
      },
    ],
  });
  const query = methodValidator("list_session_revocations", "request");
  assert(query({ after_sequence: 0, limit: 500 }));
  rejectsInvalidRootsAndMissing(query, { after_sequence: 0, limit: 500 });
  for (const value of [
    { after_sequence: -1, limit: 1 },
    { after_sequence: 0, limit: 501 },
    { after_sequence: 0, limit: 0 },
  ])
    assert.equal(query(value), false);
  const response = methodValidator("list_session_revocations", "response");
  assert(response({ events: [event], next_sequence: 1 }));
  rejectsInvalidRootsAndMissing(response, {
    events: [event],
    next_sequence: 1,
  });
  assert.equal(
    response({ events: Array(501).fill(event), next_sequence: 1 }),
    false,
  );
  assert(response({ events: [], next_sequence: 1 }));
  assert.equal(response({ events: [event], next_sequence: -1 }), false);
});

test("account operations require live CCT and the session profile grants Identity alone", () => {
  assert.deepEqual(rollout.audience_profiles, {
    console: [
      "admin-console",
      "identity-service",
      "agent-controller",
      "skill-registry",
      "agent-acp-service",
    ],
    workspace: ["agent-ui", "agent-acp-service", "agent-controller"],
    acp: ["agent-acp-service"],
    session: ["identity-service"],
  });
  assert(
    identity.methods.resolve_access_token.request.properties.profile.enum.includes(
      "session",
    ),
  );
  const resolve = methodValidator("resolve_access_token", "request");
  assert(resolve({ access_token: "secret", profile: "session" }));
  assert.equal(
    resolve({
      access_token: "secret",
      profile: "session",
      agent_id: "agent-1",
    }),
    false,
  );
  assert.equal(
    resolve({ access_token: "secret", profile: "session", touch: true }),
    false,
  );
  const expected = {
    "get-current-account": ["edge-gateway", "admin-console"],
    "change-local-password": ["edge-gateway"],
    "touch-browser-session": ["edge-gateway"],
    "list-user-sessions": ["edge-gateway", "admin-console"],
    "revoke-user-sessions": ["edge-gateway", "admin-console"],
  };
  for (const [name, allowed] of Object.entries(expected)) {
    const policy = identity.methods[name.replaceAll("-", "_")]?.authorization;
    assert(policy, `missing policy for ${name}`);
    assert.deepEqual(policy.callers, allowed, name);
    assert.equal(policy.authentication, "workload");
    assert.deepEqual(
      policy.caller_context,
      Object.fromEntries(allowed.map((caller) => [caller, "required"])),
    );
  }
  const feed = identity.methods.list_session_revocations?.authorization;
  assert.equal(feed.authentication, "workload");
  assert.deepEqual(feed.callers, ["edge-gateway"]);
  assert.deepEqual(feed.caller_context, { "edge-gateway": "operation" });
  const touch = methodValidator("touch_browser_session", "request");
  assert(touch({ actor_principal_id: "user-1" }));
  rejectsInvalidRootsAndMissing(touch, { actor_principal_id: "user-1" });
  assert.equal(
    touch({ actor_principal_id: "user-1", token_id: "private" }),
    false,
  );
});

test("password rotation schema requires private replacement credentials and both deadlines", () => {
  const response = methodValidator("change_local_password", "response");
  const principal = {
    user_id: "user-1",
    organization_id: "org-1",
    organization_slug: "engineering",
    organization_name: "Engineering",
    membership_id: "mbr-1",
    system_role: "user",
    organization_role: "member",
    active: true,
  };
  const rotated = {
    status: "changed",
    principal,
    token_id: "private-new-token",
    access_token: "replacement-secret",
    expires_at: session.expires_at,
    idle_expires_at: session.idle_expires_at,
    activity_interval_ms: 30000,
  };
  assert(response(rotated), JSON.stringify(response.errors));
  rejectsInvalidRootsAndMissing(response, rotated);
  rejectsInvalidRootsAndMissing(
    (value) => response({ ...rotated, principal: value }),
    principal,
  );
  assert.equal(
    identity.methods.change_local_password.response.properties.access_token
      .secret,
    true,
  );
  rejectsDeadlinesAndIntervals(response, rotated);
  assert.equal(
    response({
      ...rotated,
      principal: { ...principal, access_token: "secret" },
    }),
    false,
  );
  for (const field of [
    "access_token",
    "token_id",
    "expires_at",
    "idle_expires_at",
    "activity_interval_ms",
    "principal",
  ]) {
    const candidate = { ...rotated };
    delete candidate[field];
    assert.equal(response(candidate), false, field);
  }
  assert.equal(response({ status: "changed" }), false);
  for (const name of ["login", "session", "password_rotation"]) {
    assert(browser.$defs[name], `missing browser ${name} schema`);
    const validate = externalValidator(name);
    const publicValue = {
      principal,
      expires_at: session.expires_at,
      idle_expires_at: session.idle_expires_at,
      activity_interval_ms: 30000,
    };
    assert(validate(publicValue), JSON.stringify(validate.errors));
    rejectsInvalidRootsAndMissing(validate, publicValue);
    rejectsInvalidRootsAndMissing(
      (value) => validate({ ...publicValue, principal: value }),
      principal,
    );
    rejectsDeadlinesAndIntervals(validate, publicValue);
    assert.equal(
      validate({
        ...publicValue,
        principal: { ...principal, token_id: "private" },
      }),
      false,
    );
    for (const field of ["token_id", "access_token", "sid", "caller_context"])
      assert.equal(
        validate({ ...publicValue, [field]: "private" }),
        false,
        `${name}: ${field}`,
      );
    for (const interval of [0, -1, 1.5, 30001])
      assert.equal(
        validate({ ...publicValue, activity_interval_ms: interval }),
        false,
        `${name}: interval ${interval}`,
      );
  }
});

test("explicit activity returns deadlines and a bounded scheduling hint without replacing credentials", () => {
  const value = {
    expires_at: session.expires_at,
    idle_expires_at: session.idle_expires_at,
    activity_interval_ms: 1666,
  };
  const internal = methodValidator("touch_browser_session", "response");
  assert(internal(value), JSON.stringify(internal.errors));
  rejectsInvalidRootsAndMissing(internal, value);
  rejectsDeadlinesAndIntervals(internal, value);
  assert.equal(internal({ ...value, token_id: "private" }), false);
  assert(browser.$defs.activity, "missing browser activity schema");
  const external = externalValidator("activity");
  assert(external(value), JSON.stringify(external.errors));
  rejectsInvalidRootsAndMissing(external, value);
  rejectsDeadlinesAndIntervals(external, value);
  assert.equal(external({ ...value, access_token: "secret" }), false);
  assert.equal(external({ ...value, activity_interval_ms: 0 }), false);
});

test("Console browser-session consumer adopts the current Gateway contract", () => {
  const consumer = read("admin-console/admin-contract.json").response_policy
    .account_security;
  assert.equal(gateway.version, 24);
  assert.equal(consumer.gateway_revision, gateway.version);
  assert.equal(consumer.identity_revision, identity.revision);
  assert.equal(
    consumer.browser_session_contract,
    "../identity/browser-sessions.md",
  );
});

test("Gateway owns session mutations and records cookie concurrency and stream bounds", () => {
  assert.equal(identity.revision, 18);
  assert.equal(gateway.version, 24);
  assert.equal(
    gateway.browser_session_contract,
    "../identity/browser-sessions.md",
  );
  for (const [name, method, path] of [
    ["get_account", "GET", "/api/session/account"],
    ["change_password", "POST", "/api/session/password"],
    ["session_activity", "POST", "/api/session/activity"],
    ["list_sessions", "GET", "/api/session/sessions"],
    ["revoke_sessions", "POST", "/api/session/sessions/revoke"],
  ]) {
    assert.equal(gateway.routes[name]?.method, method, name);
    assert.equal(gateway.routes[name]?.path, path, name);
    assert.equal(gateway.routes[name]?.authentication, "browser_session", name);
    const policy = read("edge-gateway/callers.json").routes[
      `${method} ${path}`
    ];
    assert.deepEqual(
      policy,
      {
        callers: ["browser"],
        authentication: "public",
        caller_context: { browser: "session" },
        request_body: method === "POST" ? "json" : "none",
      },
      `${name} must have an exact browser-session caller policy`,
    );
  }
  assert.deepEqual(gateway.session_security.cookie_writers, [
    "login",
    "oidc_callback",
    "change_password",
    "logout",
  ]);
  assert.equal(
    gateway.session_security.cookie_expiry,
    "absolute-session-deadline",
  );
  assert.equal(
    gateway.session_validation.invalid_or_expired,
    "401 unauthenticated; preserve browser cookies",
  );
  assert.equal(
    gateway.session_lifecycle.activity_route,
    "/api/session/activity",
  );
  assert.equal(gateway.session_lifecycle.background_resolution, "non-touch");
  assert.equal(gateway.session_lifecycle.idle_timeout_default_seconds, 1800);
  assert.equal(
    gateway.session_lifecycle.absolute_timeout_default_seconds,
    43200,
  );
  assert.equal(
    gateway.session_lifecycle.stream_revalidation.maximum_stale_seconds,
    30,
  );
  assert.equal(
    gateway.session_lifecycle.stream_revalidation.feed_dependency,
    false,
  );
  assert.deepEqual(
    gateway.session_lifecycle.stream_revalidation.initial_resolution,
    {
      timeout:
        "at most maximum stale bound / 3 before the activity hint is known",
      reply_budget:
        "elapsed at most min(maximum stale bound / 3, returned activity_interval_ms)",
      stale_deadline_anchor:
        "actual Resolve RPC start, including a reused cached snapshot",
      late_reply: "reject before starting upstream",
      cache_hit:
        "current invocation must meet its reply budget and retained snapshot must pass cache/feed/session/CCT and remaining stale-output bounds; cache age is not RPC duration",
      live_miss:
        "actual RPC duration and current invocation must fit the existing initial reply budget",
    },
  );
});

test("explicit logout preserves its Origin, CSRF and cookie outcome matrix", () => {
  assert.equal(
    gateway.session_validation.scope,
    "ordinary authenticated requests; explicit logout follows routes.logout.cookie_outcomes",
  );
  assert.deepEqual(gateway.routes.logout.cookie_outcomes, {
    no_session: { status: 204, cookies: "clear", identity_call: false },
    revoked: { status: 204, cookies: "clear" },
    malformed_invalid_or_inactive: { status: 401, cookies: "clear" },
    identity_unavailable: { status: 503, cookies: "preserve" },
    csrf_rejected: { status: 403, cookies: "preserve" },
    origin_rejected: { status: 403, cookies: "preserve" },
  });
});

function rejectsDeadlinesAndIntervals(validate, value) {
  for (const field of ["expires_at", "idle_expires_at"])
    for (const invalid of [
      null,
      12,
      "not-a-date",
      "2026-02-30T12:00:00Z",
      "2026-10-10T25:00:00Z",
    ])
      assert.equal(
        validate({ ...value, [field]: invalid }),
        false,
        `${field}: ${invalid}`,
      );
  for (const activity_interval_ms of [0, -1, 1.5, 30001, "1000"])
    assert.equal(
      validate({ ...value, activity_interval_ms }),
      false,
      String(activity_interval_ms),
    );
}

const principal = {
  user_id: "user-1",
  organization_id: "org-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  membership_id: "mbr-1",
  system_role: "user",
  organization_role: "member",
  active: true,
};
const deadlines = {
  expires_at: session.expires_at,
  idle_expires_at: session.idle_expires_at,
  activity_interval_ms: 30000,
};

test("public response schemas declare no private credential fields or secret-marked values", () => {
  const forbidden = new Set([
    "token_id",
    "sid",
    "access_token",
    "token_hash",
    "caller_context",
    "credential",
    "current_token_id",
    "password",
    "password_hash",
    "current_password",
    "new_password",
  ]);
  const visited = new Set();
  function inspect(value, path = "browser") {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    assert.notEqual(value.secret, true, path);
    for (const key of Object.keys(value.properties ?? {}))
      assert.equal(forbidden.has(key), false, `${path}.${key}`);
    if (value.$ref) {
      assert.match(
        value.$ref,
        /^#\//u,
        `${path}: public schema reference must be resolvable`,
      );
      let referenced = browser;
      for (const part of value.$ref.slice(2).split("/"))
        referenced =
          referenced?.[
            decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")
          ];
      assert.notEqual(referenced, undefined, `${path}: missing ${value.$ref}`);
      inspect(referenced, `${path}->${value.$ref}`);
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "$defs" && key !== "definitions")
        inspect(child, `${path}.${key}`);
  }
  for (const name of [
    "login",
    "session",
    "password_rotation",
    "activity",
    "account",
    "session_list",
    "session_revocation",
  ]) {
    assert(browser.$defs[name], `missing public ${name} schema`);
    inspect(browser.$defs[name], name);
  }
  for (const [name, schema] of Object.entries(browser.$defs))
    if (!name.endsWith("_request") && !name.endsWith("_query"))
      inspect(schema, name);
});

for (const [method, value] of [
  [
    "local_login",
    {
      request_id: "request-1",
      organization_slug: "engineering",
      email: "member@example.test",
      password: "existing-password",
    },
  ],
  [
    "start_oidc_login",
    {
      request_id: "request-1",
      organization_slug: "engineering",
      provider_name: "company",
    },
  ],
]) {
  test(`${method} admits only strict login inputs with an optional bounded display hint`, () => {
    const validate = methodValidator(method, "request");
    assert(validate(value), JSON.stringify(validate.errors));
    rejectsInvalidRootsAndMissing(validate, value);
    for (const user_agent_hint of ["", "Browser / OS", "界".repeat(256)])
      assert(
        validate({ ...value, user_agent_hint }),
        JSON.stringify(validate.errors),
      );
    for (const user_agent_hint of [null, 123, [], "界".repeat(257)])
      assert.equal(
        validate({ ...value, user_agent_hint }),
        false,
        `${method}: invalid user-agent hint`,
      );
    for (const field of [
      "token_id",
      "user_id",
      "expires_at",
      "idle_expires_at",
    ])
      assert.equal(validate({ ...value, [field]: "chosen-by-client" }), false);
    if (method === "local_login")
      assert.equal(
        identity.methods[method].request.properties.password.secret,
        true,
      );
  });
}

test("local login and token resolution declare both deadlines without adding touch authority", () => {
  const login = methodValidator("local_login", "response");
  const issued = {
    principal,
    token_id: "private-1",
    access_token: "ant_api_secret",
    ...deadlines,
  };
  assert(login(issued), JSON.stringify(login.errors));
  rejectsInvalidRootsAndMissing(login, issued);
  rejectsInvalidRootsAndMissing(
    (value) => login({ ...issued, principal: value }),
    principal,
  );
  rejectsDeadlinesAndIntervals(login, issued);
  assert.equal(
    identity.methods.local_login.response.properties.access_token.secret,
    true,
  );
  const resolve = methodValidator("resolve_access_token", "response");
  const resolved = {
    principal,
    caller_context: "private-signed-context",
    ...deadlines,
  };
  assert(resolve(resolved), JSON.stringify(resolve.errors));
  rejectsInvalidRootsAndMissing(resolve, resolved);
  rejectsInvalidRootsAndMissing(
    (value) => resolve({ ...resolved, principal: value }),
    principal,
  );
  rejectsDeadlinesAndIntervals(resolve, resolved);
  assert.equal(resolve({ ...resolved, access_token: "ant_api_secret" }), false);
  assert.equal(
    identity.methods.resolve_access_token.response.properties.caller_context
      .secret,
    true,
  );
});

test("OIDC initial and completed response schemas preserve deadlines and reject credential replay", () => {
  const initial = identityValidator(
    identity.protocols.oidc_callback.initial_response,
  );
  const value = {
    principal,
    token_id: "private-1",
    access_token: "ant_api_secret",
    ...deadlines,
  };
  assert(initial(value), JSON.stringify(initial.errors));
  rejectsInvalidRootsAndMissing(initial, value);
  rejectsInvalidRootsAndMissing(
    (candidate) => initial({ ...value, principal: candidate }),
    principal,
  );
  rejectsDeadlinesAndIntervals(initial, value);
  assert.equal(
    identity.protocols.oidc_callback.initial_response.properties.access_token
      .secret,
    true,
  );
  const replaySchema = identity.protocols.oidc_callback.replay_response;
  assert.deepEqual(replaySchema.forbidden, ["access_token"]);
  const { forbidden, ...schema } = replaySchema;
  const replay = identityValidator(schema);
  const completed = {
    principal,
    token_id: "private-1",
    already_completed: true,
    ...deadlines,
  };
  assert(replay(completed), JSON.stringify(replay.errors));
  rejectsInvalidRootsAndMissing(replay, completed);
  rejectsInvalidRootsAndMissing(
    (value) => replay({ ...completed, principal: value }),
    principal,
  );
  rejectsDeadlinesAndIntervals(replay, completed);
  assert.equal(replay({ ...completed, access_token: "ant_api_secret" }), false);
  assert.equal(replay({ ...completed, already_completed: false }), false);
});

test("Gateway self-service bodies cannot choose the actor, Organization or private session", () => {
  for (const [name, value] of [
    [
      "password_request",
      {
        current_password: "current-password",
        new_password: "new-long-password",
      },
    ],
    ["activity_request", {}],
    ["revoke_sessions_request", { mode: "others" }],
  ]) {
    const validate = externalValidator(name);
    assert(validate(value), JSON.stringify(validate.errors));
    rejectsInvalidRootsAndMissing(validate, value);
    for (const [field, secret] of Object.entries({
      actor_principal_id: "user-2",
      user_id: "user-2",
      organization_id: "org-2",
      scope: "organization",
      token_id: "private-1",
    }))
      assert.equal(
        validate({ ...value, [field]: secret }),
        false,
        `${name}: ${field}`,
      );
  }
  const revoke = externalValidator("revoke_sessions_request");
  assert(revoke({ mode: "all" }));
  assert.equal(revoke({ mode: "one" }), false);
  const password = externalValidator("password_request");
  for (const field of ["current_password", "new_password"]) {
    assert.equal(
      browser.$defs.password_request.properties[field].secret,
      true,
      `Gateway ${field}`,
    );
    assert.equal(
      identity.methods.change_local_password.request.properties[field].secret,
      true,
      `Identity ${field}`,
    );
  }
  assert.equal(
    password({ current_password: "", new_password: "new-long-password" }),
    false,
  );
  assert.equal(
    password({ current_password: "current-password", new_password: "short" }),
    false,
  );
  const query = externalValidator("list_sessions_query");
  assert(query({ limit: 50, after_id: session.id }));
  rejectsInvalidRootsAndMissing(query, { limit: 50 });
  for (const invalid of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 1, after_id: "" },
    { limit: 1, organization_id: "org-2" },
  ])
    assert.equal(query(invalid), false);
});

test("Gateway account and session inventory responses exclude nested private fields", () => {
  const account = {
    user_id: "user-1",
    organization_id: "org-1",
    membership_id: "mbr-1",
    email: "member@example.com",
    display_name: "Member",
    source: "local",
    local_password_available: true,
  };
  for (const [name, value] of [
    ["account", { account }],
    ["session_list", { sessions: [session] }],
    ["session_revocation", { revoked_count: 1, current_revoked: false }],
  ]) {
    const validate = externalValidator(name);
    assert(validate(value), JSON.stringify(validate.errors));
    rejectsInvalidRootsAndMissing(validate, value);
  }
  rejectsInvalidRootsAndMissing(
    (value) => externalValidator("account")({ account: value }),
    account,
  );
  const withoutPassword = {
    ...account,
    source: "scim",
    local_password_available: false,
  };
  assert(
    externalValidator("account")({ account: withoutPassword }),
    "OIDC-only accounts keep public session controls",
  );
  const internalAccount = methodValidator("get_current_account", "response");
  const identityAccount = {
    ...account,
    organization_slug: "engineering",
    organization_name: "Engineering",
  };
  const identityWithoutPassword = { ...identityAccount, ...withoutPassword };
  assert(
    internalAccount({ account: identityAccount }),
    JSON.stringify(internalAccount.errors),
  );
  assert(
    internalAccount({ account: identityWithoutPassword }),
    "Identity supports accounts without a local password",
  );
  rejectsInvalidRootsAndMissing(internalAccount, { account: identityAccount });
  rejectsInvalidRootsAndMissing(
    (value) => internalAccount({ account: value }),
    identityAccount,
  );
  assert.equal(
    internalAccount({
      account: { ...identityWithoutPassword, access_token: "private" },
    }),
    false,
  );
  assert.equal(
    externalValidator("account")({
      account: { ...account, token_id: "private" },
    }),
    false,
  );
  assert.equal(
    externalValidator("session_list")({
      sessions: [{ ...session, token_hash: "a".repeat(64) }],
    }),
    false,
  );
  assert.equal(
    externalValidator("session_list")({ sessions: Array(101).fill(session) }),
    false,
  );
  assert.equal(
    externalValidator("session_revocation")({
      revoked_count: -1,
      current_revoked: false,
    }),
    false,
  );
});

test("an invalid current password is a business error and does not invalidate the session", () => {
  assert(
    identity.error.properties.code.enum.includes("invalid_current_password"),
  );
  assert.equal(
    identity.error.http_status_by_code.invalid_current_password,
    400,
  );
  assert(gateway.error.codes.includes("invalid_current_password"));
});
