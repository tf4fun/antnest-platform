import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";
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
    "rc-acp",
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
  if (options.owner) plan.endpoints.owner = "http://owner.fixture:8085";
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
      if (hostname === "owner.fixture") {
        assert(options.owner, "owner endpoint was not selected");
        assert.equal(
          context,
          undefined,
          "owner probe must use only workload authority",
        );
        for (const header of ["Authorization", "Cookie"])
          assert.equal(init.headers[header], undefined);
        let check;
        if (pathname === "/internal/acp-owner/incarnation/probe") {
          assert.equal(init.method, "POST");
          if (grant === undefined) check = "anonymous";
          else if (grant === "agent-ui-acp") check = "wrong-caller";
          else {
            assert.equal(grant, "rc-acp");
            check = "pending-intent";
            assert(body && typeof body === "object" && !Array.isArray(body));
            assert.deepEqual(Object.keys(body).sort(), [
              "challenge",
              "incarnation_id",
              "member_id",
              "registration_nonce",
            ]);
            assert.equal(body.member_id, "acp-a");
            assert(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                body.incarnation_id,
              ),
              "owner probe requires a canonical UUIDv4",
            );
            for (const key of ["registration_nonce", "challenge"])
              assert(
                typeof body[key] === "string" &&
                  /^[a-f0-9]{64}$/u.test(body[key]),
                "owner probe requires a lower-hex nonce and challenge",
              );
          }
        } else {
          assert.equal(pathname, "/status");
          assert.equal(init.method, "GET");
          assert.equal(grant, "rc-acp");
          assert.equal(body, undefined);
          check = "private-status";
        }
        const [status, code] = {
          anonymous: [401, "service_unauthenticated"],
          "wrong-caller": [403, "caller_not_allowed"],
          "pending-intent": [409, "acp_probe_intent_mismatch"],
          "private-status": [404, "route_not_found"],
        }[check];
        request.ownerCheck = check;
        const fault =
          options.ownerFault?.check === check
            ? options.ownerFault.kind
            : undefined;
        const actualStatus = fault === "status" ? 200 : status;
        const actualCode =
          fault === "code" ? "PRIVATE_OWNER_PROBE_RAW_PAYLOAD" : code;
        request.ownerResponse = { status: actualStatus, code: actualCode };
        return json(
          {
            code: actualCode,
            message: fault
              ? `PRIVATE_OWNER_PROBE_RAW_PAYLOAD:${tokens["rc-acp"]}:${body?.registration_nonce ?? "absent"}`
              : "ACP incarnation request did not complete",
            retryable: false,
          },
          actualStatus,
        );
      }
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

test("matrix exercises all four private owner authentication gates when its endpoint is selected", async () => {
  const f = fixture({ owner: true });
  const result = await authenticatePeer(f.plan, f.dependencies);
  assert.equal(result.status, "passed");
  const owner = f.requests.filter(
    (request) => request.hostname === "owner.fixture",
  );
  assert.equal(
    owner.length,
    4,
    "selected owner admission checks must actually run",
  );
  for (const [check, method, path, grant, status, code] of [
    [
      "anonymous",
      "POST",
      "/internal/acp-owner/incarnation/probe",
      undefined,
      401,
      "service_unauthenticated",
    ],
    [
      "wrong-caller",
      "POST",
      "/internal/acp-owner/incarnation/probe",
      "agent-ui-acp",
      403,
      "caller_not_allowed",
    ],
    [
      "pending-intent",
      "POST",
      "/internal/acp-owner/incarnation/probe",
      "rc-acp",
      409,
      "acp_probe_intent_mismatch",
    ],
    ["private-status", "GET", "/status", "rc-acp", 404, "route_not_found"],
  ]) {
    const matching = owner.filter((request) => request.ownerCheck === check);
    assert.equal(
      matching.length,
      1,
      `${check}: missing or duplicate owner check`,
    );
    const [request] = matching;
    assert.equal(request.method, method);
    assert.equal(request.pathname, path);
    assert.equal(request.grant, grant);
    assert.deepEqual(request.ownerResponse, { status, code });
    assert.equal(request.context, undefined);
  }
  for (const session of ["owner", "admin"])
    assert(
      f.revoked.includes(session),
      "owner checks must release both disposable identities",
    );
  assert.equal(f.reports.at(-1).status, "passed");
});

for (const check of [
  "anonymous",
  "wrong-caller",
  "pending-intent",
  "private-status",
]) {
  for (const kind of ["status", "code"]) {
    test(`matrix rejects owner ${check} with the wrong ${kind} and still revokes both identities`, async () => {
      const f = fixture({ owner: true, ownerFault: { check, kind } });
      const outcome = await authenticatePeer(f.plan, f.dependencies).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      // These are actual revocation requests, observed even when the baseline
      // incorrectly skips the selected owner checks and returns success.
      const revocations = f.requests.filter(
        (request) =>
          request.hostname === "identity.fixture" &&
          request.pathname.endsWith("/revoke-access-token"),
      );
      for (const session of ["owner", "admin"]) {
        assert(
          f.revoked.includes(session),
          "owner gate failure skipped identity cleanup",
        );
        assert(
          revocations.some((request) => request.body.access_token === session),
          "identity cleanup was not actually requested",
        );
      }
      assert.equal(
        outcome.ok,
        false,
        "matrix accepted an unverified private owner endpoint",
      );
      if (outcome.ok) assert.fail("owner gate failure became a passing matrix");
      assert.equal(
        f.requests.filter((request) => request.ownerCheck === check).length,
        1,
        "the failing owner gate must actually execute",
      );
      assert.equal(f.reports.at(-1).status, "failed");
      const rendered = `${inspect(outcome.error, { depth: 8 })}\n${JSON.stringify(f.reports)}`;
      const opaque = f.requests
        .flatMap((request) =>
          request.hostname === "owner.fixture"
            ? [request.body?.registration_nonce, request.body?.challenge]
            : [],
        )
        .filter((value) => typeof value === "string" && value.length !== 0);
      for (const secret of [
        ...Object.values(tokens),
        ...opaque,
        "PRIVATE_OWNER_PROBE_RAW_PAYLOAD",
      ])
        assert(
          !rendered.includes(secret),
          "owner failure/report disclosed private response material",
        );
    });
  }
}
