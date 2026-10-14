import assert from "node:assert/strict";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serviceClient } from "../../support/service-grants.mjs";

// Only fixed, locally authored diagnostics may escape this private peer.
class PeerFailure extends Error {}

export async function authenticatePeer(
  plan,
  {
    fetch = globalThis.fetch,
    readCredential = (name) => readFileSync(`/run/auth/${name}`, "utf8"),
    report = (value) => console.log(JSON.stringify(value)),
  } = {},
) {
  const checks = [];
  const failures = [];
  let step = "login";
  const client = serviceClient({
    fetch,
    readCredential,
    identityEndpoint: plan.endpoints.identity,
  });
  const recordFailure = (error) =>
    failures.push(
      error instanceof PeerFailure
        ? error
        : new PeerFailure(`${step}: admission failed`),
    );
  const credential = (name) => {
    const value = readCredential(name);
    assert(
      /^[A-Za-z0-9_-]{43}$/u.test(value),
      "invalid disposable credential encoding",
    );
    return value;
  };
  async function call(
    endpoint,
    path,
    sender,
    { method = "POST", body, context, headers = {}, status = 200, code } = {},
  ) {
    const response = await fetch(`${plan.endpoints[endpoint]}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(sender
          ? { "Antnest-Service-Authorization": `Bearer ${credential(sender)}` }
          : {}),
        ...(context ? { "Antnest-Caller-Context": context } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    if (response.status !== status)
      throw new PeerFailure(
        `${step}: HTTP ${response.status}, expected ${status}`,
      );
    if (text.length >= 65536)
      throw new PeerFailure(`${step}: excessive response`);
    let result;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new PeerFailure(`${step}: invalid JSON response`);
    }
    if (code && (result?.code ?? result?.error?.code) !== code)
      throw new PeerFailure(`${step}: unexpected error code`);
    checks.push(step);
    return result;
  }
  async function login(owner) {
    return call("identity", "/rpc/identity/local-login", "gateway-identity", {
      body: {
        request_id: randomUUID(),
        organization_slug: "stage3",
        email: owner ? "c4-member@example.com" : "stage3-admin@example.com",
        password: owner ? "c4-member-password" : "stage3-admin-password",
      },
    });
  }
  const issued = (session, profile, agentId) =>
    call("identity", "/rpc/identity/resolve-access-token", "gateway-identity", {
      body: {
        access_token: session.access_token,
        profile,
        ...(agentId === undefined ? {} : { agent_id: agentId }),
      },
    });
  const revoke = (session) =>
    call("identity", "/rpc/identity/revoke-access-token", "gateway-identity", {
      body: { access_token: session.access_token },
    });
  function verifyIssuer(context, jwks, principal, { agentId, audiences } = {}) {
    try {
      const [head, payload, signature] = context.split(".");
      const header = JSON.parse(Buffer.from(head, "base64url"));
      assert.equal(header.alg, "EdDSA");
      assert.equal(header.typ, "antnest-cct+jwt");
      const key = jwks.keys.find((entry) => entry.kid === header.kid);
      assert(key, "issued CCT has no published verification key");
      assert(
        verify(
          null,
          Buffer.from(`${head}.${payload}`),
          createPublicKey({ key, format: "jwk" }),
          Buffer.from(signature, "base64url"),
        ),
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      assert.equal(claims.iss, "antnest://service/identity-service");
      assert.equal(claims.sub, principal.user_id);
      assert.equal(claims.org, principal.organization_id);
      assert.equal(claims.agt, agentId);
      if (audiences)
        assert.deepEqual([...claims.aud].sort(), [...audiences].sort());
      assert(claims.exp > claims.iat && claims.exp - claims.iat <= 60);
      assert.equal(Object.hasOwn(claims, "act"), false);
    } catch {
      throw new PeerFailure(`${step}: invalid signed Identity caller context`);
    }
  }
  let owner, admin;
  try {
    owner = await login(true);
    if (plan.mode === "policy-off") {
      step = "read policy through ACP grant";
      const query = new URLSearchParams({
        organization_id: owner.principal.organization_id,
        principal_id: owner.principal.user_id,
      });
      const path = `/internal/agents/${plan.agent_id}/skill-learning-policy`;
      const before = await call(
        "controller",
        `${path}?${query}`,
        "acp-controller",
        { method: "GET" },
      );
      step = "issue owner context through real Identity";
      const context = (await issued(owner, "console", plan.agent_id))
        .caller_context;
      step = "set policy through signed Console grant";
      const after = await call("controller", path, "console-controller", {
        method: "PUT",
        context,
        body: {
          request_id: randomUUID(),
          organization_id: owner.principal.organization_id,
          actor_principal_id: owner.principal.user_id,
          expected_revision: before.revision,
          mode: "off",
          scope: before.scope,
          pinned_paths: before.pinned_paths,
          limits: before.limits,
        },
      });
      assert.equal(after.mode, "off");
      assert.notEqual(after.revision, before.revision);
    } else {
      step = "administrator login through real Identity";
      admin = await login(false);
      step = "issue Console CCT";
      const context = (await issued(admin, "console")).caller_context;
      step = "issue distinct ACP audience";
      const wrongAudience = (await issued(admin, "acp")).caller_context;
      step = "authenticated public JWKS";
      const jwks = await call(
        "identity",
        "/rpc/identity/jwks",
        "gateway-identity",
        { method: "GET" },
      );
      verifyIssuer(context, jwks, admin.principal);
      checks.push("real Ed25519 issuer and bounded claims");
      const directory = {
        actor_principal_id: admin.principal.user_id,
        organization_id: admin.principal.organization_id,
      };
      step = "body actor alone cannot delegate";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: directory,
          status: 401,
          code: "caller_context_required",
        },
      );
      step = "signed wrong audience rejected";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: directory,
          context: wrongAudience,
          status: 401,
          code: "caller_context_invalid",
        },
      );
      const [header, payload, signature] = context.split(".");
      const modified = JSON.parse(Buffer.from(payload, "base64url"));
      modified.org = `org_${"f".repeat(32)}`;
      const tampered = `${header}.${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`;
      step = "tampered real CCT rejected";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: directory,
          context: tampered,
          status: 401,
          code: "caller_context_invalid",
        },
      );
      step = "valid signed administrator read";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: directory,
          context,
        },
      );
      step = "body actor mismatch rejected";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: { ...directory, actor_principal_id: owner.principal.user_id },
          context,
          status: 403,
          code: "actor_mismatch",
        },
      );
      const catalog = `/internal/agent-templates?organization_id=${admin.principal.organization_id}`;
      step = "Controller rejects signed wrong audience";
      await call("controller", catalog, "console-controller", {
        method: "GET",
        context: wrongAudience,
        status: 401,
        code: "caller_context_invalid",
      });
      step = "Console credential remains Console despite claimed ACP header";
      await call("controller", catalog, "console-controller", {
        method: "GET",
        context,
        headers: { "X-Antnest-Service": "agent-acp-service" },
      });
      step = "ACP credential cannot claim Console permission";
      await call("controller", catalog, "acp-controller", {
        method: "GET",
        context,
        headers: { "X-Antnest-Service": "admin-console" },
        status: 403,
        code: "caller_not_allowed",
      });
      step = "Agent UI credential cannot claim ACP control authority";
      await call("control", "/rpc/agent-acp/settle-agent", "agent-ui-acp", {
        body: {},
        headers: { "X-Antnest-Service": "agent-controller" },
        status: 403,
        code: "caller_not_allowed",
      });
      step = "issue owner workspace context through real Identity";
      const { context: ownerContext } = await client.workspaceContext(
        owner.access_token,
        plan.agent_id,
      );
      checks.push(step);
      step = "verify owner workspace context";
      verifyIssuer(ownerContext, jwks, owner.principal, {
        agentId: plan.agent_id,
        audiences: ["agent-ui", "agent-acp-service", "agent-controller"],
      });
      checks.push(step);
      step = "Agent UI workspace grant requires a caller context";
      await call(
        "workspace",
        "/rpc/agent-acp/get-agent-execution-state",
        "agent-ui-acp",
        {
          body: {},
          status: 401,
          code: "caller_context_required",
        },
      );
      const [ownerHead, ownerPayload] = ownerContext.split(".");
      step = "Agent UI workspace grant rejects a modified CCT signature";
      await call(
        "workspace",
        "/rpc/agent-acp/get-agent-execution-state",
        "agent-ui-acp",
        {
          body: {},
          context: `${ownerHead}.${ownerPayload}.${Buffer.alloc(64).toString("base64url")}`,
          status: 401,
          code: "caller_context_invalid",
        },
      );
      step = "workspace honors signed owner despite forged raw identity";
      const workspace = await call(
        "workspace",
        "/rpc/agent-acp/get-agent-execution-state",
        "agent-ui-acp",
        {
          body: {},
          context: ownerContext,
          headers: {
            "X-Antnest-User-ID": admin.principal.user_id,
            "X-Antnest-Principal-ID": `user_${"f".repeat(32)}`,
            "X-Antnest-Agent-ID": `agent_${"f".repeat(32)}`,
            "X-Antnest-Organization-ID": `org_${"f".repeat(32)}`,
          },
        },
      );
      assert.equal(workspace.agent_id, plan.agent_id);
      assert.equal(workspace.access_allowed, true);
      const search = {
        organization_id: owner.principal.organization_id,
        actor_id: owner.principal.user_id,
        query: "fixture-procedure",
      };
      step = "RC cannot claim ACP discovery permission";
      await call(
        "registry",
        "/internal/skill-discovery/search",
        "rc-registry",
        {
          body: search,
          headers: { "X-Antnest-Service": "agent-acp-service" },
          status: 403,
          code: "caller_not_allowed",
        },
      );
      step = "actual ACP discovery grant remains allowed";
      await call(
        "registry",
        "/internal/skill-discovery/search",
        "acp-registry",
        {
          body: search,
        },
      );
      step = "RC cannot publish formal Skills";
      await call("registry", "/internal/skills", "rc-registry", {
        body: {},
        status: 403,
        code: "caller_not_allowed",
      });
      for (const [path, method] of [
        ["/status", "GET"],
        ["/mcp", "POST"],
        ["/mcp", "DELETE"],
        ["/internal/skill-maintenance/status", "POST"],
        ["/internal/skill-temporary/release", "POST"],
      ]) {
        step = `Runtime unauthenticated ${method} ${path}`;
        await call("runtime", path, null, {
          method,
          ...(method === "POST" ? { body: {} } : {}),
          status: 401,
          code: "runtime_unauthorized",
        });
      }
      step = "Runtime public liveness contains no execution identity";
      const live = await call("runtime", "/status/live", null, {
        method: "GET",
      });
      assert.deepEqual(live, { status: "ready" });
      step = "revoke actual administrator session";
      await revoke(admin);
      step = "revoked session rejects still-unexpired CCT";
      await call(
        "identity",
        "/rpc/identity/list-directory",
        "console-identity",
        {
          body: directory,
          context,
          status: 401,
          code: "caller_context_invalid",
        },
      );
    }
  } catch (error) {
    recordFailure(error);
  } finally {
    for (const [label, session] of [
      ["owner", owner],
      ["administrator", admin],
    ]) {
      step = `release disposable ${label} session`;
      if (session) {
        try {
          await revoke(session);
        } catch (error) {
          recordFailure(error);
        }
      }
    }
  }
  if (failures.length) {
    const error = new AggregateError(
      failures,
      "Authenticated peer admission or session cleanup failed",
    );
    report({
      mode: plan.mode,
      status: "failed",
      checks,
      errors: failures.map((failure) => ({
        name: failure.name,
        message: failure.message,
      })),
    });
    throw error;
  }
  const result = { mode: plan.mode, status: "passed", checks };
  report(result);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(process.argv[2]);
  await authenticatePeer(plan);
}
