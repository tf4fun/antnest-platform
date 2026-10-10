import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
} from "../../support/development-configuration.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const { config, settings } = readDevelopmentConfiguration(
  values.config,
  "agent-state",
);
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const api = new GatewayClient(config.gateway);
const id = config.agentId;
try {
  await api.request("/api/session/login", {
    body: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  const { body: agent } = await api.request(`/api/admin/agents/${id}`);
  const { body: state } = await api.request(`/api/app/agents/${id}/state`);
  assert.equal(agent.agent_id, id, "managed Agent identity mismatch");
  assert.equal(state.agent_id, id, "execution Agent identity mismatch");
  assert.equal(state.availability, "ready");
  assert.equal(state.active_session_id, null);
  assert.equal(state.access_allowed, true);
  const result = {
    checked_at: new Date().toISOString(),
    agent_id: id,
    lifecycle_state: agent.lifecycle_state,
    activation_state: agent.activation_state,
    runtime_state: agent.runtime_state,
    active_operation_request_id: agent.active_operation_request_id,
    runtime_revision: agent.runtime?.runtime_revision,
    execution_revision: agent.executable_execution_revision,
    execution_state: state,
  };
  writeDevelopmentJSON(config, config.reportBasename + ".json", result);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      type: error.name,
      assertion:
        error.name === "AssertionError"
          ? error.message.split("\n")[0]
          : undefined,
    }),
  );
  process.exitCode = 1;
}
