import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { serviceClient } from "../../support/service-grants.mjs";
import { CostExecutionStateUnavailableError } from "./setup.mjs";

const path = "/rpc/agent-acp/get-agent-execution-state";
const validateState = new Ajv2020({ strict: false }).compile(schema);
const startupUnavailable = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};

export async function readPrivateExecutionState(
  agentId,
  browser,
  options = {},
) {
  const {
    endpoint = "http://agent-acp-service:8080" + path,
    service = serviceClient(),
    signal,
    receipts,
    secrets,
  } = options;
  signal?.throwIfAborted();
  assert(Array.isArray(receipts), "Cost state response inventory required");
  assert(Array.isArray(secrets), "Cost state secret inventory required");
  assert(
    typeof agentId === "string" && agentId.length > 0,
    "Cost Agent required",
  );
  const target = new URL(endpoint);
  assert(
    ["http:", "https:"].includes(target.protocol) &&
      target.pathname === path &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password,
    "invalid private Cost state endpoint",
  );
  const principal = {};
  for (const field of ["organization_id", "user_id"]) {
    assert(
      typeof options.principal?.[field] === "string" &&
        options.principal[field].length > 0,
      "original browser Principal required",
    );
    principal[field] = options.principal[field];
  }
  const accessToken = browser.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "original browser session required",
  );
  secrets.push(accessToken);
  const issued = await service.workspaceContext(accessToken, agentId, {
    signal,
  });
  secrets.push(issued.context);
  signal?.throwIfAborted();
  for (const field of ["organization_id", "user_id"])
    assert.equal(
      issued.principal[field],
      principal[field],
      "workspace authority changed",
    );
  const headers = service.authorization("agent-ui-acp");
  const grant = headers["Antnest-Service-Authorization"];
  assert(
    typeof grant === "string" && grant.startsWith("Bearer "),
    "Cost private workload grant required",
  );
  secrets.push(grant, grant.slice("Bearer ".length));
  let response, rawBody;
  try {
    response = await service.send(target.href, "agent-ui-acp", {
      body: {},
      context: issued.context,
      headers,
      signal,
    });
    rawBody = await response.text();
  } catch {
    signal?.throwIfAborted();
    throw new Error("Cost private execution state request failed");
  }
  // Private evidence retains the complete response, including failures, without
  // reflecting response bodies or credentials into errors or telemetry.
  receipts.push({
    agentId,
    method: "POST",
    path,
    status: response.status,
    rawBody,
  });
  signal?.throwIfAborted();
  let state;
  try {
    state = JSON.parse(rawBody);
  } catch {
    throw new Error("invalid Cost execution state JSON");
  }
  if (response.status !== 200) {
    const exactUnavailable =
      response.status === 503 &&
      state !== null &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      Object.keys(state).length === Object.keys(startupUnavailable).length &&
      Object.entries(startupUnavailable).every(
        ([key, value]) => state[key] === value,
      );
    if (exactUnavailable) throw new CostExecutionStateUnavailableError();
    throw new Error("Cost private execution state HTTP " + response.status);
  }
  assert(validateState(state), "invalid complete Cost execution state schema");
  assert.equal(state.agent_id, agentId, "foreign Cost execution state Agent");
  return state;
}
