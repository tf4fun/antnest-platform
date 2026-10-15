import assert from "node:assert/strict";
import { createCacheRuntimeWork } from "./resolve-cache-runtime-work.mjs";

export async function prepareOutageAdmissions({
  evidence,
  agentID,
  ownerCredentials,
  adminCredentials,
  prepPrincipal,
  prepClient,
  login,
  http,
  poll,
  signal,
  docker,
  config,
  createRuntimeWork = createCacheRuntimeWork,
}) {
  const base = `/api/app/workspace/v1/agents/${encodeURIComponent(agentID)}`;
  // Physical Runtime setup and configuration polling have no dependency on
  // the final SID/CCT. Keep them outside both final Resolve-cache lifetimes.
  const { client: prepAdministrator, response: prepAdminSession } = await login(
    adminCredentials,
    "prep-admin-login",
  );
  assert.equal(
    prepAdminSession.body.principal.organization_id,
    prepPrincipal.organization_id,
    "preparation Principals must share an organization",
  );
  evidence.runtime_binding = await http(
    prepAdministrator,
    `/api/admin/agents/${encodeURIComponent(agentID)}`,
    { label: "prep-runtime-binding" },
  );
  assert.equal(evidence.runtime_binding.body.agent_id, agentID);
  const runtimeWork = await createRuntimeWork({
    docker,
    config,
    agent: evidence.runtime_binding.body,
    principal: prepPrincipal,
    readerPrincipal: prepAdminSession.body.principal,
    signal,
  });
  evidence.runtime = runtimeWork.evidence;
  await runtimeWork.assertFresh();
  const acpStarted = evidence.consumer_restarts.find(
    (row) => row.service === "agent-acp-service",
  ).after.started_at;
  const appliedAfterRestart = (row) => {
    const value = row.body.synchronization;
    return (
      value &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      value.revision === value.applied_revision &&
      Date.parse(value.applied_at) > Date.parse(acpStarted)
    );
  };
  await poll(
    async (samplingSignal) => {
      const row = await http(
        prepAdministrator,
        "/api/admin/execution-synchronization",
        {
          label: "prep-configuration-acknowledgement",
          requestSignal: samplingSignal,
        },
      );
      return appliedAfterRestart(row) && row;
    },
    "new ACP process configuration acknowledgement",
    signal,
    10000,
  );
  signal.throwIfAborted();
  const { client, response: session } = await login(
    ownerCredentials,
    "warm-login",
  );
  const { client: administrator, response: adminSession } = await login(
    adminCredentials,
    "audit-login",
  );
  evidence.session_deadlines = {
    owner: session.body,
    admin: adminSession.body,
  };
  assert.deepEqual(
    session.body.principal,
    prepPrincipal,
    "final member changed preparation Principal",
  );
  assert.deepEqual(
    adminSession.body.principal,
    prepAdminSession.body.principal,
    "final administrator changed preparation Principal",
  );
  // Boolean assertions keep actual Cookie values out of failure evidence.
  assert(
    client.cookie && prepClient.cookie && client.cookie !== prepClient.cookie,
    "final member reused preparation Cookie",
  );
  assert(
    administrator.cookie &&
      prepAdministrator.cookie &&
      administrator.cookie !== prepAdministrator.cookie,
    "final administrator reused preparation Cookie",
  );
  // One real request establishes the final admin's cold RPC source. If the
  // configuration changes again, fail this run instead of polling on its budget.
  const synchronization = await http(
    administrator,
    "/api/admin/execution-synchronization",
    { label: "fresh-configuration-acknowledgement" },
  );
  assert(
    appliedAfterRestart(synchronization),
    "final configuration acknowledgement is not current",
  );
  const state = await http(client, `${base}/view`, {
    label: "fresh-consumer-agent-ready",
  });
  evidence.consumer_configuration = { synchronization, state };
  assert.equal(state.body.agentId, agentID);
  assert.equal(state.body.availability, "ready");
  assert.equal(state.body.activeSessionId, null);
  return { client, session, administrator, adminSession, runtimeWork };
}
