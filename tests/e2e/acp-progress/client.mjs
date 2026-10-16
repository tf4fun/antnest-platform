import assert from "node:assert/strict";
import { seedProgress } from "./setup.mjs";
import { runtimeGate } from "./gate.mjs";
import { createProgressScenario } from "./scenario.mjs";
import { openPrivateProgressConnection } from "./connection.mjs";
import {
  captureProgressConnection,
  indexProgressRequests,
} from "./client-evidence.mjs";
import { requestProgressRuntimeInspection } from "./runtime-inspection.mjs";
import {
  collectPrivateProgressTrace,
  collectPrivateProgressNotificationTrace,
  privateProgressStrictOutcome,
} from "./collector.mjs";
import { cancelDiagnostics } from "./cancel-diagnostics.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { withPrivateCommandResources } from "../acp-commands/connection.mjs";
// The four-Agent ACK/deletion lifecycle is identical; retain its actual raw
// response/operation recording and failure cleanup instead of a weaker copy.
import { withCostAgentCleanup as withProgressAgentCleanup } from "../acp-cost/cleanup-evidence.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway);
const image = process.env.TEST_RUNTIME_IMAGE;
const directory = evidenceDirectory(process.env.ANTNEST_PROGRESS_EVIDENCE_DIR);
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const agents = [],
  connections = [],
  scenarios = [],
  outcomes = [],
  checked = [];
const clients = new Set();
const secrets = [
  "progress-payload-canary",
  "progress-model-test",
  "stage3-admin-password",
  "progress-member-password",
];
let principal,
  stage = "setup";
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
async function login(browser, email, password) {
  const result = await browser.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  secrets.push(browser.accessToken, ...browser.cookies.values());
  return result.body;
}
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(result.state, "running", "Agent operation failed");
      return false;
    },
    "Agent operation",
    120000,
  );
}
async function connect(version, agent) {
  assert(principal, "original Progress browser login Principal required");
  const client = await openPrivateProgressConnection(version, agent, member, {
    principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  return client;
}
const setup = { cwd: "/workspace", mcpServers: [] };
const replay = (client, version, sessionId) =>
  client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
const scenario = createProgressScenario({
  connect,
  replay,
  until,
  outcomes,
  onConnectionClosed: async (context) => {
    connections.push(await captureProgressConnection(context));
    clients.delete(context.client);
  },
  diagnose: async (context) => {
    console.log(
      asciiJSON(
        await cancelDiagnostics({
          ...context,
          jaeger: "http://jaeger:16686",
          directory,
          secrets,
          flush: () => telemetry.flush(),
        }),
      ),
    );
  },
});
async function main() {
  assert(image, "candidate Progress Runtime image required");
  assert(directory, "Progress evidence directory required");
  shellStoragePreflight(directory);
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "progress-member@example.com",
    display_name: "Tool progress owner",
    password: "progress-member-password",
    role: "member",
  });
  ({ principal } = await login(
    member,
    "progress-member@example.com",
    "progress-member-password",
  ));
  const template = await seedProgress(api, image);
  const { inventory, models, runtimeInspection } =
    await withProgressAgentCleanup(
      agents,
      admin,
      async (consumed) => {
        for (const version of [1, 2])
          for (const source of ["bash", "managed"]) {
            stage = `create:v${version}-${source}`;
            const created = await api(
              "/api/admin/agents",
              {
                owner_user_id: user.user.id,
                name: `Progress v${version} ${source}`,
                template_id: template.template_id,
                template_revision: template.revision,
              },
              202,
            );
            const agent = created.agent.agent_id;
            agents.push(agent);
            await operation(created.operation.request_id);
            await waitForAgentReady(() => api(`/api/admin/agents/${agent}`));
            const gate = await runtimeGate(agent);
            for (const ending of ["success", "failure", "cancel"]) {
              stage = `v${version}-${source}-${ending}`;
              scenarios.push(
                await scenario(version, source, ending, agent, gate),
              );
              console.log(asciiJSON(outcomes.at(-1)));
            }
          }
        assert.equal(clients.size, 0, "Progress connection cleanup incomplete");
        stage = "model-inventory";
        const response = await fetch("http://progress-model:8080/status", {
          signal: AbortSignal.timeout(5000),
        });
        const raw = await response.text();
        writeEvidenceFile(directory, "model-status.private.json", raw);
        assert.equal(response.status, 200);
        const observed = JSON.parse(raw);
        assert.deepEqual(observed.errors, []);
        const models = observed.requests;
        const inventory = indexProgressRequests({
          agents,
          connections,
          scenarios,
          outcomes,
          models,
        });
        for (const [file, value] of [
          ["connection-inventory.private.json", connections],
          ["request-inventory.private.json", inventory.requests],
          ["initialization-inventory.private.json", inventory.initializations],
          ["notification-inventory.private.json", inventory.notifications],
          ["scenario-inventory.private.json", { scenarios, outcomes }],
        ])
          writeEvidenceFile(directory, file, JSON.stringify(value) + "\n");
        stage = "runtime-inspection";
        const runtimeInspection = await requestProgressRuntimeInspection(
          agents,
          { consumed },
        );
        return { inventory, models, runtimeInspection };
      },
      { directory },
    );
  // The cleanup wrapper has consumed the original four-Runtime ACK and joined
  // all four complete delete operations before Trace admission can succeed.
  const options = {
    directory,
    secrets,
    requests: models,
    flush: () => telemetry.flush(),
  };
  for (const expected of [
    ...inventory.requests,
    ...inventory.initializations,
  ]) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectPrivateProgressTrace(
        "http://jaeger:16686",
        expected,
        options,
      ),
    );
  }
  for (const { phase, receipt } of inventory.notifications) {
    stage = `notification:${phase}`;
    checked.push(
      await collectPrivateProgressNotificationTrace(
        "http://jaeger:16686",
        receipt,
        options,
      ),
    );
  }
  assert.equal(checked.length, 76);
  assert.equal(new Set(checked.map((row) => row.trace_id)).size, 76);
  const runs = checked.filter((row) => row.run_id);
  assert.equal(runs.length, 12);
  assert.equal(new Set(runs.map((row) => row.run_id)).size, 12);
  assert.deepEqual(
    new Set(runs.map((row) => row.trace_id)),
    new Set(models.map((row) => row.trace_id)),
  );
  const { exit_code, ...strict } = privateProgressStrictOutcome(checked);
  assert.equal(strict.accepted, true);
  console.log(
    asciiJSON({
      status: "business_passed",
      scenarios: outcomes.length,
      outcomes,
      connections: connections.length,
      request_traces: inventory.requests.length,
      initialization_requests: inventory.initializations.length,
      cancel_notifications: inventory.notifications.length,
      model_requests: models.length,
      runtime_inspection: runtimeInspection,
      traces: checked,
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
        inventory: { agents, connections, scenarios, outcomes, checked },
        fetchStatus: () =>
          fetch("http://progress-model:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
}
