import assert from "node:assert/strict";
import { assertWorkspaceBootstrap } from "../identity-closeout/organization-workspace.mjs";

// Only browser acceptance needs the production frontend decoder and schema.
// Protocol-only clients share the lifecycle helpers in contracts.mjs without
// mounting Agent UI sources into their ACP harness containers.
export function assertWorkspaceProjection(
  bootstrap,
  state,
  agentId,
  principal,
  secrets = [],
) {
  assertWorkspaceBootstrap(
    bootstrap,
    principal,
    { slug: principal.organization_slug, name: principal.organization_name },
    [agentId],
    secrets,
  );
  const agent = bootstrap.agents.find((item) => item.agentId === agentId);
  assert(agent, "Agent missing from management discovery");
  assert.equal(agent.lifecycle, "created");
  assert.equal(agent.activation, "enabled");
  assert.equal(agent.runtime, "available");
  assert(
    !Object.hasOwn(agent, "availability"),
    "bootstrap must not own execution availability",
  );
  assert(!JSON.stringify(bootstrap).includes("agent_access_subject"));
  assert.equal(state.agent_id, agentId);
  assert.equal(state.access_allowed, true);
  assert.equal(state.availability, "ready");
  assert.match(state.configuration_revision, /^[a-f0-9]{64}$/);
}
