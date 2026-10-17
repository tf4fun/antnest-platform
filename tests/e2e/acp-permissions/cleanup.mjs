import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { until } from "../acp-closeout/wait.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
} from "../../support/storage.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const cleanupEvidenceDirectory = (directory) =>
  typeof directory === "string" && directory.length > 0
    ? join(directory, "independent-cleanup")
    : directory;

export async function preservePermissionCleanupFailure({
  directory = process.env.ANTNEST_PERMISSION_EVIDENCE_DIR,
  error,
  runID = process.env.TEST_PERMISSION_RUN_ID,
  fetchStatus = () =>
    fetch("http://permission-model:8080/status", {
      signal: AbortSignal.timeout(5000),
    }),
}) {
  return {
    ...(await preserveFileFailure({
      directory: cleanupEvidenceDirectory(directory),
      error,
      stage: "independent-cleanup",
      inventory: { run_id: runID },
      fetchStatus,
    })),
    status: "cleanup_failed",
  };
}

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
      const ownedDetails = (agent) => {
        assert.equal(
          agent.agent_id,
          candidate.agent_id,
          "cleanup Agent identity changed",
        );
        assert(names.has(agent.name), "cleanup Agent ownership changed");
        return agent;
      };
      let agent = ownedDetails(
        await api(`/api/admin/agents/${candidate.agent_id}`),
      );
      if (agent.active_operation_request_id) {
        await operation(api, agent.active_operation_request_id);
        agent = ownedDetails(
          await api(`/api/admin/agents/${candidate.agent_id}`),
        );
      }
      if (agent.lifecycle_state === "deleted") continue;
      if (agent.lifecycle_state === "created") {
        try {
          await cancel(agent.agent_id);
        } catch (error) {
          // The owning Controller deletion must still be attempted. Retain the
          // Session failure even if deletion later removes the Runtime.
          errors.push(error);
        }
      }
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

export async function closePermissionSessions(
  agent,
  browser,
  { clients, ...options } = {},
) {
  assert(clients instanceof Set, "cleanup connection inventory required");
  const { openPrivateCommandConnection, withPrivateCommandConnection } =
    await import("../acp-commands/connection.mjs");
  const client = await openPrivateCommandConnection(
    { version: 1 },
    agent,
    browser,
    options,
  );
  clients.add(client);
  return withPrivateCommandConnection(client, [], async () => {
    let cursor,
      pages = 0,
      closed = 0;
    const seen = new Set();
    do {
      assert(++pages <= 100, "cleanup Session page limit");
      const page = await client.request("list", { cursor });
      // Each real response confirms persisted cancellation before TCP closes.
      for (const session of page.sessions) {
        await client.request("close", { sessionId: session.sessionId });
        closed++;
      }
      cursor = page.nextCursor;
      assert(!cursor || !seen.has(cursor), "cleanup Session cursor repeated");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return closed;
  });
}

async function main() {
  const { GatewayClient } = await import("../identity-closeout/support.mjs");
  const { gateway } = await import("../identity-closeout/acp-connection.mjs");
  const { withPrivateCommandResources } =
    await import("../acp-commands/connection.mjs");
  const { createPrivateACPTelemetry } =
    await import("../identity-closeout/private-acp-telemetry.mjs");
  const directory = evidenceDirectory(
    cleanupEvidenceDirectory(process.env.ANTNEST_PERMISSION_EVIDENCE_DIR),
  );
  assert(directory, "independent Permissions cleanup evidence required");
  shellStoragePreflight(directory);
  const runID = process.env.TEST_PERMISSION_RUN_ID;
  const admin = new GatewayClient(gateway),
    member = new GatewayClient(gateway);
  const clients = new Set(),
    secrets = [];
  const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
  const login = async (client, email, password) => {
    const result = await client.request("/api/session/login", {
      body: { organization_slug: "stage3", email, password },
    });
    secrets.push(client.accessToken, ...client.cookies.values());
    return result.body;
  };
  return withPrivateCommandResources(clients, telemetry, async () => {
    await login(admin, "stage3-admin@example.com", "stage3-admin-password");
    const api = async (path, body, status = 200) =>
      (await admin.request(path, { body, status })).body;
    return cleanupPermissionAgents(api, runID, async (agent) => {
      const { principal } = await login(
        member,
        `permission-owner-${runID}@example.com`,
        "permission-owner-password",
      );
      await closePermissionSessions(agent, member, {
        principal,
        clients,
        telemetry,
        secrets,
      });
    });
  });
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const count = await main();
    console.log(asciiJSON({ status: "cleanup_passed", agents: count }));
  } catch (error) {
    console.error(asciiJSON(await preservePermissionCleanupFailure({ error })));
    process.exitCode = 1;
  }
}
