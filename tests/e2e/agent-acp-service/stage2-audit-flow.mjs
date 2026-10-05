import assert from "node:assert/strict";
import { json, registerFixturePrincipal } from "./stage2-transport.mjs";
import { gatewayLogin } from "./stage2-gateway.mjs";

export async function verifyAdministrativeAudit({
  gateway,
  identity,
  organizationId,
  principalId,
  owner,
  agentId,
  rpc,
  modelState,
  compose,
}) {
  const traces = [];
  const request = async (path, cookie = "", status = 200, extra = {}) => {
    const response = await fetch(gateway + path, {
      headers: { cookie, ...extra },
      // The fault probe must outlive Compose's 150s dependency deadline.
      signal: AbortSignal.timeout(status === 503 ? 165000 : 20000),
    });
    const payload = await response.json();
    assert.equal(
      response.status,
      status,
      `Gateway ${path}: ${JSON.stringify(payload)}`,
    );
    const traceId = response.headers.get("x-antnest-trace-id");
    assert.match(traceId ?? "", /^[0-9a-f]{32}$/u);
    if (status === 200 && path.startsWith("/api/admin/execution-audits"))
      traces.push(traceId);
    return payload;
  };
  const login = (slug, email, password) =>
    gatewayLogin(gateway, slug, email, password);
  const command = (method, body) =>
    json(`${identity}/rpc/identity/${method}`, {
      request_id: `stage2-audit-${method}`,
      actor_principal_id: principalId,
      ...body,
    });
  const admin = await login(
    "stage2",
    "stage2-admin@example.com",
    "stage2-admin-password",
  );
  assert.equal(admin.principal.system_role, "admin");
  const attempts = (await modelState()).attempts.length;
  const listPath = `/api/admin/execution-audits?agent_id=${agentId}&limit=100`;
  const actual = await rpc("list-execution-audits", {
    agent_id: agentId,
    limit: 100,
  });
  const before = await request(listPath, admin.cookie);
  assert.deepEqual(before, actual);
  assert.equal(before.items.length, 7);
  const readAll = async () => {
    assert.deepEqual(await request(listPath, admin.cookie), before);
    const records = [];
    for (const run of before.items) {
      const path = `/api/admin/execution-audits/${run.run_id}`;
      const detail = await request(path, admin.cookie);
      const stored = await rpc("get-execution-audit", { run_id: run.run_id });
      assert.equal(detail.run_id, run.run_id);
      assert.equal(detail.state, stored.state);
      assert.deepEqual(detail.input, stored.input);
      assert(
        JSON.stringify(detail.input).includes("Stage 2 acceptance evidence"),
      );
      const streams = [];
      for (const stream of ["execution", "permissions"]) {
        const events = await request(
          `${path}/events?stream=${stream}&limit=100`,
          admin.cookie,
        );
        assert.deepEqual(
          events,
          await rpc("list-execution-events", {
            run_id: run.run_id,
            stream,
            limit: 100,
          }),
        );
        if (stream === "execution") assert(events.items.length > 0);
        streams.push(events);
      }
      records.push({ detail, streams });
    }
    return records;
  };
  const retained = await readAll();
  compose("restart", "agent-acp-service");
  compose("up", "-d", "--no-deps", "--wait", "agent-acp-service");
  assert.deepEqual(
    await readAll(),
    retained,
    "ACP restart changed retained audit details or events",
  );

  await command("update-membership", {
    organization_id: organizationId,
    membership_id: owner.membership.id,
    email: "stage2-owner@example.com",
    display_name: "Stage 2 Owner",
    role: "member",
    active: true,
  });
  const member = await login(
    "stage2",
    "stage2-owner@example.com",
    "stage2-owner-password",
  );
  const { organization } = await command("create-organization", {
    slug: "stage2-foreign",
    name: "Stage 2 Foreign",
    owner_email: "stage2-admin@example.com",
    owner_display_name: "Stage 2 Administrator",
  });
  const foreignAdmin = await json(`${identity}/rpc/identity/local-login`, {
    request_id: "stage2-foreign-admin-login",
    organization_slug: "stage2-foreign",
    email: "stage2-admin@example.com",
    password: "stage2-admin-password",
  });
  registerFixturePrincipal(foreignAdmin.principal, foreignAdmin.token_id);
  await command("create-local-user", {
    organization_id: organization.id,
    email: "stage2-foreign@example.com",
    display_name: "Foreign Administrator",
    password: "stage2-foreign-password",
    role: "admin",
  });
  const foreign = await login(
    "stage2-foreign",
    "stage2-foreign@example.com",
    "stage2-foreign-password",
  );
  assert.equal(foreign.principal.system_role, "user");
  const runId = before.items[0].run_id;
  for (const path of [
    listPath,
    `/api/admin/execution-audits/${runId}`,
    `/api/admin/execution-audits/${runId}/events`,
  ]) {
    await request(path, "", 401);
    await request(path, member.cookie, 403);
    await request(path, member.cookie, 403, {
      "x-antnest-user-id": principalId,
      "x-antnest-organization-id": organizationId,
      "x-antnest-membership-id": admin.principal.membership_id,
      "x-antnest-system-role": "admin",
      "x-antnest-organization-role": "owner",
    });
  }
  assert.deepEqual(await request(listPath, foreign.cookie), {
    items: [],
    next_cursor: null,
  });
  await request(`/api/admin/execution-audits/${runId}`, foreign.cookie, 404);
  await request(
    `/api/admin/execution-audits/${runId}/events`,
    foreign.cookie,
    404,
  );
  const page = await request(
    `/api/admin/execution-audits?agent_id=${agentId}&limit=1`,
    admin.cookie,
  );
  assert.equal(typeof page.next_cursor, "string");
  await request(
    `/api/admin/execution-audits?agent_id=${agentId}&cursor=${encodeURIComponent(page.next_cursor)}`,
    foreign.cookie,
    400,
  );

  compose("stop", "agent-acp-service");
  try {
    await request(listPath, admin.cookie, 503);
    await request("/api/admin/agents", admin.cookie);
  } finally {
    compose("up", "-d", "--no-deps", "--wait", "agent-acp-service");
  }
  assert.deepEqual(await request(listPath, admin.cookie), before);
  assert.equal(
    (await modelState()).attempts.length,
    attempts,
    "audit reads caused model execution",
  );
  return { runs: before.items.length, restarted: true, traces };
}
