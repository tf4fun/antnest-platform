import assert from "node:assert/strict";
import { assertJsonRpcContentTypeRejection } from "../../../support/json-rpc-security.mjs";

export async function authenticationProbes({
  registry,
  credentialHeaders,
  archive,
  owner,
  organization,
  check,
}) {
  let count = 0;
  async function rejected(
    path,
    { headers = {}, method = "POST", body = "{}", status, code },
  ) {
    const response = await fetch(registry + path, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, status, path);
    assert.equal(result.error.code, code, path);
    assert.equal(result.error.retryable, false);
    assert.equal(
      response.headers.get("www-authenticate"),
      code === "service_unauthenticated"
        ? 'Bearer realm="antnest-service"'
        : null,
    );
    count++;
  }
  for (const caller of [
    "runtime-controller",
    "agent-controller",
    "agent-acp-service",
    "edge-gateway",
  ]) {
    await rejected("/internal/skills", {
      headers: credentialHeaders(caller),
      status: 403,
      code: "caller_not_allowed",
    });
    await rejected("/internal/skill-projections/promote", {
      headers: credentialHeaders(caller),
      status: 403,
      code: "caller_not_allowed",
    });
  }
  await rejected("/internal/skills", {
    status: 401,
    code: "service_unauthenticated",
  });
  await rejected("/internal/skills", {
    headers: { Authorization: "Bearer old-shared-secret-at-least-32-bytes" },
    status: 401,
    code: "service_unauthenticated",
  });
  const withoutContext = credentialHeaders("admin-console");
  delete withoutContext["Antnest-Caller-Context"];
  await rejected("/internal/skills", {
    headers: withoutContext,
    status: 401,
    code: "caller_context_required",
  });
  await rejected("/internal/skills", {
    headers: credentialHeaders("admin-console", { org_role: "member" }),
    status: 403,
    code: "forbidden",
  });
  await rejected("/internal/skills", {
    headers: credentialHeaders("admin-console", { aud: ["admin-console"] }),
    status: 401,
    code: "caller_context_invalid",
  });
  await rejected("/internal/../internal/skills", {
    status: 401,
    code: "service_unauthenticated",
  });

  for (const [method, path, caller] of [
    ["POST", "/internal/skill-versions/resolve", "agent-controller"],
    ["PUT", "/internal/skill-projections", "agent-acp-service"],
    ["POST", "/internal/skill-discovery/search", "agent-acp-service"],
    ["POST", "/internal/skill-discovery/load", "agent-acp-service"],
    ["POST", "/internal/skill-projections/promote", "admin-console"],
  ]) {
    count += await assertJsonRpcContentTypeRejection({
      url: registry + path,
      method,
      headers: credentialHeaders(caller),
      signal: AbortSignal.timeout(15000),
    });
  }

  const uploadOrg = `org_${"f".repeat(32)}`;
  const upload = async (org, actor, changes, expected) => {
    const body = new FormData();
    body.set(
      "metadata",
      JSON.stringify({
        request_id: "auth-console-upload",
        organization_id: org,
        actor_id: actor,
      }),
    );
    body.set(
      "artifact",
      new Blob([archive], { type: "application/zip" }),
      "skill.zip",
    );
    const response = await fetch(registry + "/internal/skills", {
      method: "POST",
      headers: credentialHeaders("admin-console", changes),
      body,
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    assert.equal(response.status, expected);
    count++;
    return result;
  };
  assert.equal(
    (await upload(uploadOrg, owner, {}, 403)).error.code,
    "organization_mismatch",
  );
  assert.equal(
    (await upload(uploadOrg, `user_${"d".repeat(32)}`, { org: uploadOrg }, 403))
      .error.code,
    "actor_mismatch",
  );
  const published = await upload(uploadOrg, owner, { org: uploadOrg }, 201);
  const resolve = await fetch(registry + "/internal/skill-versions/resolve", {
    method: "POST",
    headers: {
      ...credentialHeaders("agent-controller"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organization_id: uploadOrg,
      refs: [{ skill_id: published.skill_id, version: 1 }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(resolve.status, 200);
  assert.deepEqual((await resolve.json()).items, [published]);
  count++;
  const path = `/internal/skills/${published.skill_id}/versions/1/artifact?organization_id=${uploadOrg}`;
  const artifact = await fetch(registry + path, {
    headers: credentialHeaders("runtime-controller"),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(artifact.status, 200);
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), archive);
  count++;
  await rejected(path, {
    method: "GET",
    headers: credentialHeaders("admin-console"),
    status: 403,
    code: "organization_mismatch",
  });
  await rejected("/internal/skills?organization_id=" + organization, {
    method: "GET",
    headers: credentialHeaders("runtime-controller"),
    status: 403,
    code: "caller_not_allowed",
  });
  check(
    "per-caller-negative-json-media-console-scope-upload-controller-resolve-rc-artifact",
  );
  return { count, published, organization: uploadOrg };
}
