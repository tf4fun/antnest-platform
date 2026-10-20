import assert from "node:assert/strict";
import { withPermissionAgentCleanup } from "./cleanup-evidence.mjs";
import { requestPermissionRuntimeInspection } from "./runtime-inspection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { assertApprovalPending } from "./expectations.mjs";
import { cancelPermissionPrompt } from "./cancel.mjs";
import { openPrivatePermissionConnection } from "./connection.mjs";
import {
  capturePermissionConnection,
  indexPermissionRequests,
} from "./client-evidence.mjs";
import {
  collectPrivatePermissionTrace,
  collectPrivatePermissionNotificationTrace,
  privatePermissionStrictOutcome,
} from "./collector.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import {
  withPrivateCommandConnection,
  withPrivateCommandResources,
} from "../acp-commands/connection.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";

import { seedPermissions } from "./setup.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const suffix = process.env.TEST_PERMISSION_RUN_ID,
  agents = [],
  outcomes = [],
  connections = [],
  checked = [];
const clients = new Set(),
  issuedSessions = new WeakMap(),
  connectionMeta = new WeakMap();
const secrets = [
  "permission-model-test",
  "read_only",
  "stage3-admin-password",
  "permission-owner-password",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(
  process.env.ANTNEST_PERMISSION_EVIDENCE_DIR,
);
const email = `permission-owner-${suffix}@example.com`;
assert.match(suffix ?? "", /^[0-9a-f-]{36}$/);
const setup = { cwd: "/workspace", mcpServers: [] };
let stage = "setup";
async function login(client, email, password) {
  const result = await client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  issuedSessions.set(client, result.body);
  secrets.push(client.accessToken, ...client.cookies.values());
  return result.body;
}
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(result.state, "running");
    },
    "Agent operation",
    120000,
  );
}
async function connect(version, agentId, browser = member, role = "owner") {
  stage = `v${version}-connect-${role}`;
  const principal = issuedSessions.get(browser)?.principal;
  assert(principal, "original Permissions login Principal required");
  const client = await openPrivatePermissionConnection(
    version,
    agentId,
    browser,
    { principal, telemetry, secrets },
  );
  clients.add(client);
  connectionMeta.set(client, { version, agentId, role });
  return client;
}
async function use(client, action) {
  const errors = [];
  let result;
  try {
    result = await withPrivateCommandConnection(client, [], action);
  } catch (error) {
    errors.push(error);
  }
  try {
    connections.push(
      await capturePermissionConnection({
        client,
        ...connectionMeta.get(client),
      }),
    );
  } catch (error) {
    errors.push(error);
  }
  clients.delete(client);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Permissions business and connection cleanup failed",
    );
  return result;
}
async function session(client, mode) {
  stage = `v${client.version}-configure-${mode}`;
  const created = await client.request("new", setup);
  assert(created.configOptions.length >= 2);
  const changed = await client.request("setConfigOption", {
    sessionId: created.sessionId,
    configId: "mode",
    value: mode,
    ...(client.version === 2 ? { type: "id" } : {}),
  });
  assert.equal(
    changed.configOptions.find((item) => (item.id ?? item.configId) === "mode")
      .currentValue,
    mode,
  );
  return created.sessionId;
}
async function done(client, version, promise, sessionId, phase) {
  const result = await promise;
  if (version === 1) assert.equal(result.stopReason, "end_turn");
  else
    await until(
      () =>
        client.updates.some(
          (frame) =>
            frame.sessionId === sessionId &&
            frame.update.sessionUpdate === "state_update" &&
            frame.update.state === "idle" &&
            frame.update.stopReason === "end_turn",
        ),
      "Run idle",
    );
  await until(
    () =>
      client.updates.some(
        (frame) =>
          frame.sessionId === sessionId &&
          JSON.stringify(frame.update).includes(`${phase} verified`),
      ),
    "final output",
  );
  assert(
    !JSON.stringify(client.updates).includes("read_only"),
    "judge text leaked to chat",
  );
  assert.equal(client.pendingPermissions.length, 0);
  outcomes.push(phase);
}
async function prompt(client, version, sessionId, phase, decision) {
  stage = phase;
  client.updates.length = 0;
  const pending = client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text: phase }] },
    120000,
  );
  const observed = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (decision) {
    await until(
      () => client.pendingPermissions.length === 1,
      "approval request",
    );
    if (process.env.TEST_PERMISSION_CRASH === "true") {
      console.log(asciiJSON({ status: "crash_ready" }));
      await new Promise(() => {});
    }
    const request = client.pendingPermissions[0];
    assertApprovalPending(request.params, client.updates, sessionId, decision);
    request.answer(decision);
  }
  const result = await observed;
  if (result.error) throw result.error;
  await done(client, version, Promise.resolve(result.value), sessionId, phase);
}
async function exercise(version, agent, modelID) {
  const client = await connect(version, agent);
  const { sessionId, originalApproval } = await use(client, async () => {
    let sid = await session(client, "approve");
    const config = await client.request("setConfigOption", {
      sessionId: sid,
      configId: "model",
      value: `profile:${modelID}`,
      ...(version === 2 ? { type: "id" } : {}),
    });
    assert.equal(
      config.configOptions.find(
        (item) => (item.id ?? item.configId) === "model",
      ).currentValue,
      `profile:${modelID}`,
    );
    for (const [phase, decision] of [
      ["once", "allow_once"],
      ["once-again", "allow_once"],
      ["deny", "reject_once"],
      ["always", "allow_always"],
      ["follow", null],
    ])
      await prompt(client, version, sid, `v${version}-${phase}`, decision);
    sid = await session(client, "approve");
    await prompt(client, version, sid, `v${version}-reject`, "reject_always");
    await prompt(client, version, sid, `v${version}-reject-follow`, null);
    sid = await session(client, "chat");
    await prompt(client, version, sid, `v${version}-chat`, null);
    sid = await session(client, "smart_approve");
    await prompt(client, version, sid, `v${version}-read-hint`, null);
    await prompt(client, version, sid, `v${version}-judge-safe`, null);
    await prompt(client, version, sid, `v${version}-judge-ask`, "allow_once");
    sid = await session(client, "approve");
    client.updates.length = 0;
    stage = `v${version}-cancel`;
    await cancelPermissionPrompt(client, version, sid);
    outcomes.push(`v${version}-cancel`);
    sid = await session(client, "approve");
    client.updates.length = 0;
    stage = `v${version}-reconnect`;
    const disconnected = client
      .request(
        "prompt",
        {
          sessionId: sid,
          prompt: [{ type: "text", text: `v${version}-reconnect` }],
        },
        120000,
      )
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    await until(() => client.pendingPermissions.length === 1, "old approval");
    const originalApproval = structuredClone(
      client.pendingPermissions[0].params,
    );
    assertApprovalPending(originalApproval, client.updates, sid, "allow_once");
    if (version === 2) {
      const acknowledged = await disconnected;
      if (acknowledged.error) throw acknowledged.error;
      assert(acknowledged.result.messageId);
    }
    await client.disconnectForReplay();
    const original = await disconnected;
    if (version === 1)
      assert.equal(client.isLocalCloseError(original.error), true);
    else assert.equal(original.error, undefined);
    return { sessionId: sid, originalApproval };
  });
  const resumed = await connect(version, agent, member, "replay");
  await use(resumed, async () => {
    const client = resumed,
      sid = sessionId;
    await client.request(version === 1 ? "load" : "resume", {
      ...setup,
      sessionId: sid,
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    await until(
      () => client.pendingPermissions.length === 1,
      "reissued approval",
    );
    const reissued = client.pendingPermissions[0];
    assert.deepEqual(
      reissued.params,
      originalApproval,
      "reconnect changed the pending approval",
    );
    assertApprovalPending(reissued.params, client.updates, sid, "allow_once");
    reissued.answer("allow_once");
    await until(
      () =>
        client.updates.some(
          (frame) =>
            frame.sessionId === sid &&
            JSON.stringify(frame.update).includes(
              `v${version}-reconnect verified`,
            ),
        ),
      "resumed result",
    );
    if (version === 2)
      await until(
        () =>
          client.updates.some(
            (frame) =>
              frame.sessionId === sid &&
              frame.update.sessionUpdate === "state_update" &&
              frame.update.state === "idle" &&
              frame.update.stopReason === "end_turn",
          ),
        "reconnected Run idle",
      );
    assert.equal(client.pendingPermissions.length, 0);
    assert(
      !JSON.stringify(client.updates).includes("read_only"),
      "judge text leaked to chat",
    );
    outcomes.push(`v${version}-reconnect`);
  });
}
async function main() {
  assert(directory, "Permissions private evidence directory required");
  shellStoragePreflight(directory);
  assert(
    process.env.TEST_RUNTIME_IMAGE,
    "candidate Permissions Runtime image required",
  );
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const owner = await api("/api/admin/directory/users", {
    email,
    display_name: "Permission owner",
    password: "permission-owner-password",
    role: "member",
  });
  const foreign = `permission-stranger-${suffix}@example.com`;
  await api("/api/admin/directory/users", {
    email: foreign,
    display_name: "Another owner",
    password: "permission-owner-password",
    role: "member",
  });
  await login(member, email, "permission-owner-password");
  await login(stranger, foreign, "permission-owner-password");
  const { template, alternateModelID } = await seedPermissions(
    api,
    process.env.TEST_RUNTIME_IMAGE,
    suffix,
  );
  const { inventory, modelStatus, runtimeInspection } =
    await withPermissionAgentCleanup(
      agents,
      admin,
      async (consumed) => {
        for (const version of [1, 2]) {
          const created = await api(
            "/api/admin/agents",
            {
              owner_user_id: owner.user.id,
              name: `Permissions v${version} ${suffix}`,
              template_id: template.template_id,
              template_revision: template.revision,
            },
            202,
          );
          agents.push(created.agent.agent_id);
          await operation(created.operation.request_id);
          const agent = agents.at(-1);
          await waitForAgentReady(() => api(`/api/admin/agents/${agent}`));
          const denied = await connect(version, agent, stranger, "foreign");
          await use(denied, () => assertAgentDenied(denied));
          await exercise(version, agent, alternateModelID);
        }
        const modelResponse = await fetch(
          "http://permission-model:8080/status",
          {
            signal: AbortSignal.timeout(5000),
          },
        );
        assert(modelResponse.ok);
        const modelRaw = await modelResponse.text();
        writeEvidenceFile(directory, "model-status.private.json", modelRaw);
        const modelStatus = JSON.parse(modelRaw);
        assert.deepEqual(modelStatus.errors, []);
        assert.equal(outcomes.length, 26);
        assert.equal(
          clients.size,
          0,
          "Permissions connections were not joined",
        );
        const inventory = indexPermissionRequests({
          agents,
          connections,
          outcomes,
          models: modelStatus.requests,
          alternateModelID,
          defaultModel: `permission-model-${suffix}`,
          alternateModel: `alternate-model-${suffix}`,
        });
        for (const [file, value] of [
          ["connection-inventory.private.json", connections],
          ["request-inventory.private.json", inventory.requests],
          ["initialization-inventory.private.json", inventory.initializations],
          ["notification-inventory.private.json", inventory.notifications],
          ["permission-inventory.private.json", inventory.permissions],
        ])
          writeEvidenceFile(directory, file, JSON.stringify(value) + "\n");
        if (process.env.TEST_BROWSER === "true") {
          stage = "browser-validation";
          console.log(
            asciiJSON({ status: "browser_ready", email, agent_id: agents[0] }),
          );
          await until(
            async () => {
              const status = await fetch(
                "http://permission-model:8080/status",
                {
                  signal: AbortSignal.timeout(5000),
                },
              );
              return (await status.json()).browserReleased;
            },
            "browser release",
            600000,
          );
        }
        stage = "runtime-inspection";
        const runtimeInspection = await requestPermissionRuntimeInspection(
          agents,
          { consumed },
        );
        return { inventory, modelStatus, runtimeInspection };
      },
      { directory },
    );
  // The original two-Runtime ACK and both completed delete operations are
  // recorded before shutdown-flushed Trace evidence is admitted.
  stage = "trace-validation";
  secrets.push(...outcomes);
  const options = {
    directory,
    secrets,
    requests: modelStatus.requests,
    flush: () => telemetry.flush(),
  };
  for (const expected of [
    ...inventory.requests,
    ...inventory.initializations,
  ]) {
    stage = `trace-${expected.label}`;
    checked.push(
      await collectPrivatePermissionTrace(
        "http://jaeger:16686",
        expected,
        options,
      ),
    );
  }
  for (const { phase, receipt } of inventory.notifications) {
    stage = `cancel-trace-${phase}`;
    checked.push(
      await collectPrivatePermissionNotificationTrace(
        "http://jaeger:16686",
        receipt,
        options,
      ),
    );
  }
  assert.equal(checked.length, 64);
  assert.equal(new Set(checked.map((row) => row.trace_id)).size, 64);
  const traces = checked.filter((row) => row.run_id);
  assert.equal(traces.length, 26);
  assert.equal(new Set(traces.map((row) => row.run_id)).size, 26);
  assert.deepEqual(
    new Set(traces.map((row) => row.trace_id)),
    new Set(modelStatus.requests.map((row) => row.trace_id)),
  );
  assert.equal(
    traces.reduce((sum, row) => sum + row.runtime_tool_calls, 0),
    16,
  );
  assert.equal(
    traces.reduce((sum, row) => sum + row.permission_waits, 0),
    16,
  );
  const { exit_code, ...strict } = privatePermissionStrictOutcome(checked);
  assert.equal(strict.accepted, true);
  console.log(
    asciiJSON({
      status: "business_passed",
      scenarios: outcomes.length,
      model_requests: modelStatus.requests.length,
      outcomes,
      connections: connections.length,
      request_traces: inventory.requests.length,
      initialization_requests: inventory.initializations.length,
      cancel_notifications: inventory.notifications.length,
      permission_deliveries: inventory.permissions.length,
      traces: checked,
      cross_user_rejections: 2,
      runtime_containers_verified: runtimeInspection.runtimes.length,
      ...strict,
    }),
  );
  process.exitCode = exit_code;
}
try {
  await withPrivateCommandResources(clients, telemetry, main);
} catch (error) {
  console.error(
    asciiJSON(
      await preserveFileFailure({
        directory,
        error,
        stage,
        inventory: { agents, connections, outcomes, checked },
        fetchStatus: () =>
          fetch("http://permission-model:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
}
