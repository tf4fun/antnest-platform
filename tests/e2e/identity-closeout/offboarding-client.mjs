import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { assertUnchanged } from "./agent-access-evidence.mjs";
import {
  assertDisabled,
  verifyOffboardingTrace,
} from "./offboarding-evidence.mjs";

// Controller routes admit named workloads only; the client container mounts
// the controller-runtime, gateway-identity and console-controller grants.
const services = serviceClient();
const runtimeController = "http://runtime-controller:8080";

export async function until(probe, label) {
  for (let i = 0; i < 240; i++) {
    const result = await probe();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

export const agentDetail = async (item) =>
  (await item.admin.request(`/api/admin/agents/${item.agent}`)).body;
export const agentEvents = async (item) =>
  (await item.admin.request(`/api/admin/agents/${item.agent}/events`)).body
    .events;

export async function inspectRuntime(item) {
  const response = await fetch(
    `${runtimeController}/internal/runtimes/${item.agent}`,
    {
      headers: services.authorization("controller-runtime"),
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(response.status, 200, "Runtime inspection failed");
  return response.json();
}

// Runtime MCP requires the per-instance credential ACP would receive; reading
// it does not rotate the credential ACP already holds.
async function runtimeConnection(item, runtime) {
  return services.json(
    `${runtimeController}/internal/runtimes/${item.agent}/connection`,
    "controller-runtime",
    {
      body: {
        runtime_revision: runtime.runtime_revision,
        expected_execution_id: runtime.runtime_execution_id,
      },
    },
  );
}

export async function sentinel(item, action) {
  const runtime = await inspectRuntime(item);
  assert(
    runtime.lifecycle_state === "provisioned" && runtime.health === "healthy",
    "sentinel requires a ready Runtime",
  );
  const connection = await runtimeConnection(item, runtime);
  const client = new Client(
    { name: "offboarding-fixture", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const signal = AbortSignal.timeout(10000);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.mcp_endpoint), {
        requestInit: {
          headers: {
            "Antnest-Service-Authorization": `Bearer ${connection.credential.token}`,
            "x-antnest-expected-execution-id": connection.runtime_execution_id,
          },
        },
      }),
      { signal },
    );
    const content = `retained-${item.agent}`;
    const result = await client.callTool(
      {
        name: action,
        arguments: {
          path: "offboarding-sentinel.txt",
          ...(action === "write" ? { content } : { offset: 1, limit: 1024 }),
        },
      },
      { signal },
    );
    assert(
      result.isError !== true &&
        result.structuredContent?.effect_state === "settled",
      "sentinel Tool failed or effect unknown",
    );
    if (action === "read")
      assert.equal(
        result.structuredContent.content,
        content,
        "workspace sentinel lost or changed",
      );
    else
      assert.equal(
        result.structuredContent.bytes_written,
        Buffer.byteLength(content),
      );
  } finally {
    await client.close();
  }
}

export async function waitOperation(item, requestID) {
  return until(async () => {
    const { body } = await item.admin.request(
      `/api/admin/operations/${requestID}`,
    );
    assert.notEqual(
      body.state,
      "failed",
      `lifecycle ${body.kind} failed: ${body.error_code ?? "unknown"}`,
    );
    return body.state === "completed" && body;
  }, "lifecycle completion");
}

export async function explicitEnable(item) {
  const { body } = await item.admin.request(
    `/api/admin/agents/${item.agent}/enable`,
    { body: {}, status: 202 },
  );
  await waitOperation(item, body.request_id);
  await waitForAgentReady(() => agentDetail(item));
  await sentinel(item, "read");
}

export async function waitOffboarding(item, before, response, reason, secrets) {
  await until(
    async () => (await agentDetail(item)).activation_state === "disabled",
    "automatic owner Disable",
  );
  assertDisabled(
    await agentDetail(item),
    await inspectRuntime(item),
    item.agent,
  );
  const events = await agentEvents(item);
  const added = events.filter(
    (event) => !before.some((old) => old.event_id === event.event_id),
  );
  const revoked = added.filter(
    (event) => event.event_type === "agent_owner_revoked",
  );
  const disabled = added.filter(
    (event) => event.event_type === "agent_disabled",
  );
  assert.equal(revoked.length, 1, "missing or duplicate owner revocation");
  // Console intentionally omits arbitrary event data; check cause through its owning RPC.
  const { context } = await services.sessionContext(
    item.admin.accessToken,
    item.agent,
  );
  const raw = await services.json(
    `http://agent-controller:8080/internal/agents/${item.agent}/events?${new URLSearchParams({ organization_id: item.organization })}`,
    "console-controller",
    { method: "GET", context },
  );
  const cause = raw.events.find(
    (event) => event.event_id === revoked[0].event_id,
  );
  assert.equal(cause?.data.reason, reason, "wrong revocation reason");
  assert.equal(
    cause.data.organization_id,
    reason === "user_deactivated" ? "" : item.organization,
    "wrong revocation scope",
  );
  assert.equal(
    revoked[0].trace_id,
    response.traceID,
    "revocation lost Gateway source trace",
  );
  assert.equal(disabled.length, 1, "missing or duplicate automatic Disable");
  const operation = await waitOperation(item, disabled[0].operation_request_id);
  assert.equal(operation.kind, "disable");
  assertUnchanged(
    before,
    events.filter((event) =>
      before.some((old) => old.event_id === event.event_id),
    ),
  );
  return verifyOffboardingTrace(
    "http://jaeger:16686",
    {
      sourceID: response.traceID,
      agentID: item.agent,
      requestID: operation.request_id,
    },
    secrets,
  );
}

export async function remainsDisabled(item) {
  const before = await agentEvents(item);
  // More than two default consumer ticks: activation must not create an Enable.
  await delay(4500);
  assertDisabled(
    await agentDetail(item),
    await inspectRuntime(item),
    item.agent,
  );
  assertUnchanged(before, await agentEvents(item));
}
