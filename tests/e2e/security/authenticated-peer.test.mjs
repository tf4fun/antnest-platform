import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { authenticatePeer } from "./authenticated-peer.mjs";

const agentId = `agent_${"1".repeat(32)}`;
const audiences = {
  console: [
    "admin-console",
    "identity-service",
    "agent-controller",
    "skill-registry",
    "agent-acp-service",
  ],
  workspace: ["agent-ui", "agent-acp-service", "agent-controller"],
  acp: ["agent-acp-service"],
};
const tokens = Object.fromEntries(
  [
    "gateway-identity",
    "console-identity",
    "console-controller",
    "acp-controller",
    "agent-ui-acp",
    "gateway-acp",
    "acp-registry",
    "rc-registry",
  ].map((name, index) => [name, String.fromCharCode(65 + index).repeat(43)]),
);

function fixture(options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const principals = {
    owner: { organization_id: "org_fixture", user_id: "user_owner" },
    admin: { organization_id: "org_fixture", user_id: "user_admin" },
  };
  const requests = [],
    reports = [],
    contexts = new Map(),
    revoked = [];
  const plan = {
    mode: "admission",
    agent_id: agentId,
    endpoints: Object.fromEntries(
      [
        "identity",
        "controller",
        "workspace",
        "control",
        "registry",
        "runtime",
      ].map((name) => [name, `http://${name}.fixture:8080`]),
    ),
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const failure = (code, status) => json({ code }, status);
  function issue(session, profile, scopedAgent) {
    const principal = principals[session];
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "antnest://service/identity-service",
      sub: principal.user_id,
      org: principal.organization_id,
      aud: audiences[profile],
      iat: now,
      exp: now + 60,
      ...(scopedAgent === undefined ? {} : { agt: scopedAgent }),
      ...(profile === "workspace" ? options.workspaceClaims : {}),
    };
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "antnest-cct+jwt", kid: "test-key" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const input = `${header}.${payload}`;
    let context = `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    if (profile === "workspace" && options.badSignature)
      context = `${input}.${Buffer.alloc(64).toString("base64url")}`;
    contexts.set(context, { profile, principal, session });
    return {
      principal,
      ...(profile === "workspace" && options.missingContext
        ? {}
        : { caller_context: context }),
    };
  }
  const dependencies = {
    readCredential: (name) => tokens[name],
    report: (value) => reports.push(value),
    fetch: async (url, init) => {
      const { hostname, pathname } = new URL(url);
      const body = init.body ? JSON.parse(init.body) : undefined;
      const context = init.headers["Antnest-Caller-Context"];
      const signed = contexts.get(context);
      const grant = Object.keys(tokens).find(
        (name) =>
          init.headers["Antnest-Service-Authorization"] ===
          `Bearer ${tokens[name]}`,
      );
      const request = {
        hostname,
        pathname,
        body,
        context,
        grant,
        headers: init.headers,
        method: init.method,
      };
      requests.push(request);
      if (hostname === "identity.fixture") {
        if (pathname.endsWith("/local-login")) {
          const session =
            body.email === "c4-member@example.com" ? "owner" : "admin";
          return json({
            access_token: session,
            principal: principals[session],
          });
        }
        if (pathname.endsWith("/resolve-access-token"))
          return json(issue(body.access_token, body.profile, body.agent_id));
        if (pathname.endsWith("/jwks")) {
          if (options.malformedJWKS)
            return new Response("SENSITIVE_ACCESS_TOKEN_PAYLOAD", {
              status: 200,
            });
          return json({
            keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key" }],
          });
        }
        if (pathname.endsWith("/revoke-access-token")) {
          revoked.push(body.access_token);
          if (options.ownerCleanupFails && body.access_token === "owner")
            return failure("cleanup_failed", 503);
          return json({});
        }
        if (pathname.endsWith("/list-directory")) {
          if (!context) return failure("caller_context_required", 401);
          if (
            !signed ||
            signed.profile !== "console" ||
            revoked.includes("admin")
          )
            return failure("caller_context_invalid", 401);
          if (body.actor_principal_id !== signed.principal.user_id)
            return failure("actor_mismatch", 403);
          return json({ users: [] });
        }
      }
      if (hostname === "controller.fixture") {
        if (pathname.endsWith("/skill-learning-policy"))
          return json({
            mode: body ? "off" : "on",
            revision: body ? "after" : "before",
            scope: {},
            pinned_paths: [],
            limits: {},
          });
        if (signed?.profile !== "console")
          return failure("caller_context_invalid", 401);
        return grant === "console-controller"
          ? json({ items: [] })
          : failure("caller_not_allowed", 403);
      }
      if (hostname === "control.fixture")
        return failure("caller_not_allowed", 403);
      if (hostname === "workspace.fixture") {
        if (grant !== "agent-ui-acp") return failure("caller_not_allowed", 403);
        if (!context) return failure("caller_context_required", 401);
        if (!signed || signed.profile !== "workspace")
          return failure("caller_context_invalid", 401);
        return json({
          agent_id: agentId,
          access_allowed: true,
          ...options.workspaceResponse,
        });
      }
      if (hostname === "registry.fixture")
        return grant === "acp-registry"
          ? json({ items: [] })
          : failure("caller_not_allowed", 403);
      if (hostname === "runtime.fixture")
        return pathname === "/status/live"
          ? json({ status: "ready" })
          : failure("runtime_unauthorized", 401);
      assert.fail(`unexpected peer request: ${hostname}${pathname}`);
    },
  };
  return {
    plan,
    dependencies,
    requests,
    reports,
    contexts,
    revoked,
    principals,
  };
}

test("matrix delegates the exact Identity workspace CCT with the Agent UI grant", async () => {
  const f = fixture();
  const result = await authenticatePeer(f.plan, f.dependencies);
  assert.equal(result.status, "passed");
  const resolutions = f.requests.filter((r) =>
    r.pathname.endsWith("/resolve-access-token"),
  );
  assert.deepEqual(
    resolutions.map((r) => r.body.profile),
    ["console", "acp", "workspace"],
  );
  assert.deepEqual(resolutions.at(-1).body, {
    access_token: "owner",
    profile: "workspace",
    agent_id: agentId,
  });
  const workspace = f.requests.filter(
    (r) => r.hostname === "workspace.fixture",
  );
  const allowed = workspace.find(
    (r) => f.contexts.get(r.context)?.profile === "workspace",
  );
  assert(allowed);
  assert.equal(allowed.grant, "agent-ui-acp");
  assert.equal(
    allowed.context,
    [...f.contexts].find(([, value]) => value.profile === "workspace")[0],
  );
  assert.equal(
    allowed.headers["X-Antnest-User-ID"],
    f.principals.admin.user_id,
  );
  assert.equal(
    allowed.headers["X-Antnest-Principal-ID"],
    `user_${"f".repeat(32)}`,
  );
  assert.equal(
    allowed.headers["X-Antnest-Agent-ID"],
    `agent_${"f".repeat(32)}`,
  );
  assert.notEqual(
    allowed.headers["X-Antnest-Organization-ID"],
    f.principals.owner.organization_id,
  );
  assert(
    workspace.some((r) => r.context === undefined),
    "missing CCT must be exercised",
  );
  assert(
    workspace.some((r) => r.context && !f.contexts.has(r.context)),
    "tampered CCT must be exercised",
  );
  assert.equal(
    f.requests.find((r) => r.hostname === "control.fixture").grant,
    "agent-ui-acp",
  );
  assert(f.revoked.includes("owner") && f.revoked.includes("admin"));
});

for (const [label, options] of [
  ["wrong Agent", { workspaceClaims: { agt: "agent_foreign" } }],
  ["wrong audiences", { workspaceClaims: { aud: audiences.acp } }],
  ["wrong signature", { badSignature: true }],
  ["missing context", { missingContext: true }],
])
  test(`matrix rejects ${label} before workspace admission and releases both sessions`, async () => {
    const f = fixture(options);
    await assert.rejects(authenticatePeer(f.plan, f.dependencies));
    assert.equal(
      f.requests.filter((r) => r.hostname === "workspace.fixture").length,
      0,
    );
    assert.deepEqual(f.revoked, ["owner", "admin"]);
  });

for (const response of [
  { agent_id: "agent_foreign" },
  { access_allowed: false },
])
  test(`matrix rejects a workspace receipt with ${JSON.stringify(response)}`, async () => {
    const f = fixture({ workspaceResponse: response });
    await assert.rejects(authenticatePeer(f.plan, f.dependencies));
    assert(
      f.requests.some(
        (r) =>
          r.grant === "agent-ui-acp" &&
          f.contexts.get(r.context)?.profile === "workspace",
      ),
    );
    assert.deepEqual(f.revoked, ["owner", "admin"]);
  });

test("malformed private JSON is absent from thrown errors and reports", async () => {
  const f = fixture({ malformedJWKS: true });
  await assert.rejects(authenticatePeer(f.plan, f.dependencies), (error) => {
    assert(!String(error.stack).includes("SENSITIVE"));
    assert(!JSON.stringify(f.reports).includes("SENSITIVE"));
    return true;
  });
  assert.deepEqual(f.revoked, ["owner", "admin"]);
});

test("owner cleanup failure cannot skip administrator cleanup or erase primary failure", async () => {
  const f = fixture({ malformedJWKS: true, ownerCleanupFails: true });
  await assert.rejects(authenticatePeer(f.plan, f.dependencies), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert(!String(error.stack).includes("SENSITIVE"));
    return true;
  });
  assert.deepEqual(f.revoked, ["owner", "admin"]);
  assert.equal(f.reports.at(-1).status, "failed");
});

test("policy setup keeps the Console context and independent ACP reader", async () => {
  const f = fixture();
  f.plan.mode = "policy-off";
  const result = await authenticatePeer(f.plan, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(
    f.requests.find((r) => r.pathname.endsWith("/resolve-access-token")).body
      .profile,
    "console",
  );
  assert.deepEqual(f.revoked, ["owner"]);
});
