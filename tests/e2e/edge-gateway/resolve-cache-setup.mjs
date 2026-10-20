import assert from "node:assert/strict";
import { setup as setupWorkspace } from "../workspace-closeout/c4-setup.mjs";
import {
  assertAgentReady,
  waitForAgentReady,
} from "../../support/verification/agent-state.mjs";

export async function setupResolveCache(
  config,
  signal,
  {
    setup = setupWorkspace,
    waitReady = waitForAgentReady,
    now = () => performance.now(),
  } = {},
) {
  const provisioningBudget = () =>
    assert.equal(
      config.env.ANTNEST_EDGE_REQUEST_TIMEOUT,
      "150s",
      "cold Agent requires the normal provisioning budget",
    );
  provisioningBudget();
  signal?.throwIfAborted();
  const fixture = await setup(config, signal);
  provisioningBudget();
  signal?.throwIfAborted();
  const started_at = now();
  // Creation can continue after an HTTP timeout. Issue it once during setup,
  // before the runner recreates Gateway with the short outage request budget.
  const created = await fixture.json("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: fixture.ownerID,
      name: "Cold cache Agent",
      template_id: fixture.template.template_id,
      template_revision: fixture.template.revision,
    },
  });
  const created_at = now(),
    coldAgentID = created.agent?.agent_id,
    requestID = created.operation?.request_id;
  assert(typeof coldAgentID === "string" && coldAgentID.length > 0);
  assert.notEqual(coldAgentID, fixture.agentID);
  assert(typeof requestID === "string" && requestID.length > 0);
  const operation = await fixture.operation(requestID);
  assert.equal(operation.state, "completed");
  signal?.throwIfAborted();
  const ready = await waitReady(
    () => fixture.json(`/api/admin/agents/${encodeURIComponent(coldAgentID)}`),
    signal,
  );
  signal?.throwIfAborted();
  assert.equal(ready.agent_id, coldAgentID);
  assert.equal(ready.owner_user_id, fixture.ownerID);
  assertAgentReady(ready);
  return {
    ...fixture,
    coldAgentID,
    coldAgentSetup: {
      request_timeout_ms: 150000,
      agent_id: coldAgentID,
      owner_user_id: ready.owner_user_id,
      request_id: requestID,
      executable_execution_revision: ready.executable_execution_revision,
      runtime_revision: ready.runtime.runtime_revision,
      started_at,
      created_at,
      ready_at: now(),
    },
  };
}
