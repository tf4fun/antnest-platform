import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { until } from "../acp-closeout/wait.mjs";

export async function cleanupPermissionAgents(api, runID, cancel) {
  assert.match(
    runID ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  const names = new Set([`Permissions v1 ${runID}`, `Permissions v2 ${runID}`]);
  const owned = [],
    seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({
      view: "current",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const page = await api(`/api/admin/agents?${query}`);
    owned.push(...page.items.filter((agent) => names.has(agent.name)));
    cursor = page.next_cursor;
    assert(!cursor || !seen.has(cursor), "cleanup cursor repeated");
    seen.add(cursor);
    assert(seen.size <= 100, "cleanup page limit");
  } while (cursor);
  const errors = [];
  for (const candidate of owned) {
    try {
      let agent = await api(`/api/admin/agents/${candidate.agent_id}`);
      if (agent.active_operation_request_id) {
        await operation(api, agent.active_operation_request_id);
        agent = await api(`/api/admin/agents/${candidate.agent_id}`);
      }
      if (agent.lifecycle_state === "deleted") continue;
      if (agent.lifecycle_state === "created") await cancel(agent.agent_id);
      const deleted = await api(
        `/api/admin/agents/${agent.agent_id}/delete`,
        {},
        202,
      );
      const result = await operation(api, deleted.request_id);
      assert.equal(
        result.state,
        "completed",
        `cleanup failed: ${agent.agent_id}`,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `${errors.length} Agent cleanup(s) failed`,
    );
  return owned.length;
}

async function operation(api, id) {
  let result;
  await until(
    async () => {
      result = await api(`/api/admin/operations/${id}`);
      return result.state !== "running";
    },
    "cleanup operation",
    120000,
  );
  return result;
}

async function main() {
  const { GatewayClient } = await import("../identity-closeout/support.mjs");
  const { gateway, connectACP } =
    await import("../identity-closeout/acp-connection.mjs");
  const runID = process.env.TEST_PERMISSION_RUN_ID;
  const admin = new GatewayClient(gateway),
    member = new GatewayClient(gateway);
  const login = (client, email, password) =>
    client.request("/api/session/login", {
      body: { organization_slug: "stage3", email, password },
    });
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const api = async (path, body, status = 200) =>
    (await admin.request(path, { body, status })).body;
  const count = await cleanupPermissionAgents(api, runID, async (agent) => {
    await login(
      member,
      `permission-owner-${runID}@example.com`,
      "permission-owner-password",
    );
    const client = connectACP(1, agent, member.cookie);
    try {
      await client.initialize();
      let cursor;
      const seen = new Set();
      do {
        const page = await client.request("list", { cursor });
        // The response confirms cancellation was persisted before closing this connection.
        for (const session of page.sessions)
          await client.request("close", { sessionId: session.sessionId });
        cursor = page.nextCursor;
        assert(!cursor || !seen.has(cursor), "cleanup Session cursor repeated");
        seen.add(cursor);
        assert(seen.size <= 100, "cleanup Session page limit");
      } while (cursor);
    } finally {
      client.close();
    }
  });
  console.log(JSON.stringify({ status: "cleanup_passed", agents: count }));
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({ status: "cleanup_failed", error: error.message }),
    );
    process.exitCode = 1;
  }
}
