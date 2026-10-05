import assert from "node:assert/strict";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const plan = JSON.parse(process.argv[2]);
const checks = [];
let step = "login";
const credential = (name) => {
  const value = readFileSync(`/run/auth/${name}`, "utf8");
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
  assert.equal(response.status, status, `${step}: unexpected HTTP status`);
  const text = await response.text();
  assert(text.length < 65536, `${step}: excessive response`);
  const result = text ? JSON.parse(text) : null;
  if (code) assert.equal(result.code ?? result.error?.code, code, step);
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
function verifyIssuer(context, jwks, principal) {
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
  assert.equal(claims.agt, undefined);
  assert(claims.exp > claims.iat && claims.exp - claims.iat <= 60);
  assert.equal(Object.hasOwn(claims, "act"), false);
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
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: directory,
      status: 401,
      code: "caller_context_required",
    });
    step = "signed wrong audience rejected";
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: directory,
      context: wrongAudience,
      status: 401,
      code: "caller_context_invalid",
    });
    const [header, payload, signature] = context.split(".");
    const modified = JSON.parse(Buffer.from(payload, "base64url"));
    modified.org = `org_${"f".repeat(32)}`;
    const tampered = `${header}.${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`;
    step = "tampered real CCT rejected";
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: directory,
      context: tampered,
      status: 401,
      code: "caller_context_invalid",
    });
    step = "valid signed administrator read";
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: directory,
      context,
    });
    step = "body actor mismatch rejected";
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: { ...directory, actor_principal_id: owner.principal.user_id },
      context,
      status: 403,
      code: "actor_mismatch",
    });
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
    step = "Gateway credential cannot claim ACP control authority";
    await call("control", "/rpc/agent-acp/settle-agent", "gateway-acp", {
      body: {},
      headers: { "X-Antnest-Service": "agent-controller" },
      status: 403,
      code: "caller_not_allowed",
    });
    step = "issue owner ACP context";
    const ownerContext = (await issued(owner, "acp", plan.agent_id))
      .caller_context;
    step = "workspace honors signed owner despite forged raw identity";
    await call(
      "workspace",
      "/rpc/agent-acp/get-agent-execution-state",
      "gateway-acp",
      {
        body: {},
        context: ownerContext,
        headers: {
          "X-Antnest-User-ID": admin.principal.user_id,
          "X-Antnest-Organization-ID": `org_${"f".repeat(32)}`,
        },
      },
    );
    const search = {
      organization_id: owner.principal.organization_id,
      actor_id: owner.principal.user_id,
      query: "fixture-procedure",
    };
    step = "RC cannot claim ACP discovery permission";
    await call("registry", "/internal/skill-discovery/search", "rc-registry", {
      body: search,
      headers: { "X-Antnest-Service": "agent-acp-service" },
      status: 403,
      code: "caller_not_allowed",
    });
    step = "actual ACP discovery grant remains allowed";
    await call("registry", "/internal/skill-discovery/search", "acp-registry", {
      body: search,
    });
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
    const live = await call("runtime", "/status/live", null, { method: "GET" });
    assert.deepEqual(live, { status: "ready" });
    step = "revoke actual administrator session";
    await revoke(admin);
    step = "revoked session rejects still-unexpired CCT";
    await call("identity", "/rpc/identity/list-directory", "console-identity", {
      body: directory,
      context,
      status: 401,
      code: "caller_context_invalid",
    });
  }
} catch (error) {
  console.log(
    JSON.stringify({
      mode: plan.mode,
      status: "failed",
      step,
      checks,
      error: { name: error.name, message: error.message.slice(0, 512) },
    }),
  );
  throw error;
} finally {
  step = "release disposable owner session";
  if (owner) await revoke(owner);
  step = "release disposable administrator session";
  if (admin) await revoke(admin);
}
console.log(JSON.stringify({ mode: plan.mode, status: "passed", checks }));
