import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { until } from "../acp-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { withAgentCleanup } from "../../support/verification/agent-cleanup.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import {
  withPrivateCommandConnection,
  withPrivateCommandResources,
} from "../acp-commands/connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  openPrivatePlanConnection,
  planRequestIdentity,
  runPlanPrompt,
} from "./connection.mjs";
import { requestPlanRuntimeInspection } from "./runtime-inspection.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { seedPlans } from "./setup.mjs";
import {
  collectPrivatePlanTrace,
  privatePlanStrictOutcome,
} from "./collector.mjs";
import {
  planPromptInputs,
  relevantUpdates,
  appendRunEvidence,
} from "./evidence.mjs";
import { phases, marker, stepsFor } from "./model.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const setup = { cwd: "/workspace", mcpServers: [] };
const outcomes = [],
  agents = [],
  executionRequests = [],
  replayRequests = [],
  setupRequests = [],
  initializationRequests = [],
  connectionInventory = [];
const clients = new Set(),
  issuedSessions = new WeakMap();
const secrets = [
  marker,
  "plan-model-test",
  "stage3-admin-password",
  "plan-owner-password",
  "plan-stranger-password",
  ...planPromptInputs,
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(process.env.ANTNEST_PLAN_EVIDENCE_DIR);
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
let stage = "setup";
const login = async (browser, email, password) => {
  const result = await browser.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  issuedSessions.set(browser, result.body);
  secrets.push(...browser.cookies.values());
  return result;
};
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(result.state, "running", "Agent operation failed");
    },
    "Agent operation",
    120000,
  );
}
async function connect(version, agent, browser = member) {
  const issued = issuedSessions.get(browser);
  assert(issued, "original browser login receipt missing");
  const client = await openPrivatePlanConnection(version, agent, browser, {
    principal: issued.principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  initializationRequests.push(client.initializationRequest);
  return client;
}
async function use(client, action) {
  try {
    return await withPrivateCommandConnection(client, [], action);
  } finally {
    connectionInventory.push({
      version: client.version,
      agent_id: client.agentId,
      connection_trace_id: client.connectionTraceID,
      client_span_id: client.clientSpanID,
      requests: structuredClone(client.requests),
    });
    clients.delete(client);
  }
}
async function replay(client, version, sessionId, expected) {
  client.updates.length = 0;
  await client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  replayRequests.push(
    planRequestIdentity(
      client,
      version === 1 ? "session/load" : "session/resume",
      sessionId,
    ),
  );
  assert(
    client.updates.every((frame) => frame.sessionId === sessionId),
    "foreign replay Session",
  );
  assert.deepEqual(relevantUpdates(client.updates), expected);
  for (const frame of client.updates)
    assert(validators[version - 1](frame.update), "invalid replay schema");
}
async function roundtrip(version, agent, sessionId, expected) {
  const client = await connect(version, agent);
  return use(client, async () => {
    assert(expected.length > 0, "empty replay evidence");
    await replay(client, version, sessionId, expected);
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    replayRequests.push(
      planRequestIdentity(client, "session/fork", fork.sessionId),
    );
    await replay(client, version, fork.sessionId, expected);
    return fork.sessionId;
  });
}
async function prompt(client, version, sessionId, phase) {
  stage = phase;
  const result = await runPlanPrompt(client, version, sessionId, phase, {
    release: async (selected) => {
      const released = await fetch(
        `http://plan-model:8080/release/${selected}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(5000),
        },
      );
      await released.arrayBuffer();
      assert.equal(released.status, 200);
    },
  });
  for (const frame of result.updates)
    assert(validators[version - 1](frame.update), "invalid live schema");
  executionRequests.push(result.request);
  outcomes.push({ phase, ...result.outcome });
  console.log(asciiJSON({ status: "scenario_passed", ...outcomes.at(-1) }));
  return relevantUpdates(result.updates);
}

async function exercise(version, agent) {
  const client = await connect(version, agent);
  const { sessionId, forkId, beforeClear, history } = await use(
    client,
    async () => {
      const { sessionId } = await client.request("new", setup);
      setupRequests.push(planRequestIdentity(client, "session/new", sessionId));
      const history = [];
      for (const id of ["create", "execute", "invalid"])
        appendRunEvidence(
          history,
          await prompt(client, version, sessionId, `v${version}-${id}`),
        );
      const beforeClear = structuredClone(history);
      const forkId = await roundtrip(version, agent, sessionId, beforeClear);
      for (const id of ["clear", "recall"])
        appendRunEvidence(
          history,
          await prompt(client, version, sessionId, `v${version}-${id}`),
        );
      return { sessionId, forkId, beforeClear, history };
    },
  );
  await roundtrip(version, agent, sessionId, history);
  await roundtrip(version, agent, forkId, beforeClear);
  const fork = await connect(version, agent);
  await use(fork, async () => {
    await replay(fork, version, forkId, beforeClear);
    await prompt(fork, version, forkId, `v${version}-fork`);
  });
  return sessionId;
}

async function modelStatus() {
  const response = await fetch("http://plan-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  const observed = await response.json();
  writeEvidenceFile(
    directory,
    "model-status.private.json",
    JSON.stringify(observed) + "\n",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(observed.errors, []);
  assert.equal(outcomes.length, phases.length * 2);
  assert.equal(observed.requests.length, 22);
  for (const { phase } of outcomes)
    assert.deepEqual(
      observed.requests
        .filter((request) => request.phase === phase)
        .map((request) => request.stage),
      Array.from({ length: stepsFor(phase).length + 1 }, (_, index) => index),
    );
  assert.equal(executionRequests.length, outcomes.length);
  assert.equal(
    new Set(observed.requests.map((request) => request.trace_id)).size,
    outcomes.length,
    "one independent execution trace per prompt",
  );
  return observed;
}

async function main() {
  shellStoragePreflight(directory);
  shellStoragePreflight(process.env.ANTNEST_PLAN_RUNTIME_CHECKPOINT_DIR);
  const image = process.env.TEST_RUNTIME_IMAGE;
  assert(image, "test Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "plan-owner@example.com",
    display_name: "Plan owner",
    password: "plan-owner-password",
    role: "member",
  });
  await api("/api/admin/directory/users", {
    email: "plan-stranger@example.com",
    display_name: "Another user",
    password: "plan-stranger-password",
    role: "member",
  });
  await login(member, "plan-owner@example.com", "plan-owner-password");
  await login(stranger, "plan-stranger@example.com", "plan-stranger-password");
  const template = await seedPlans(api, image);
  const { runtimeInspection, observed } = await withAgentCleanup(
    agents,
    api,
    async () => {
      const sessions = [];
      for (const version of [1, 2]) {
        stage = `create-v${version}`;
        const created = await api(
          "/api/admin/agents",
          {
            owner_user_id: user.user.id,
            name: `Plans v${version}`,
            template_id: template.template_id,
            template_revision: template.revision,
          },
          202,
        );
        agents.push(created.agent.agent_id);
        await operation(created.operation.request_id);
        await waitForAgentReady(() =>
          api(`/api/admin/agents/${agents.at(-1)}`),
        );
        const foreign = await connect(version, agents.at(-1), stranger);
        await use(foreign, async () => {
          await assertAgentDenied(foreign);
          replayRequests.push(
            planRequestIdentity(foreign, "session/new", undefined, {
              denial: "access_denied",
            }),
          );
        });
        sessions.push(await exercise(version, agents.at(-1)));
      }
      stage = "cross-agent-rejection";
      for (const version of [1, 2]) {
        const client = await connect(version, agents[1]);
        await use(client, async () => {
          for (const method of [version === 1 ? "load" : "resume", "fork"]) {
            await assert.rejects(
              client.request(method, {
                ...setup,
                sessionId: sessions[0],
                ...(version === 2 && method === "resume"
                  ? { replayFrom: { type: "start" } }
                  : {}),
              }),
              (error) => {
                assertDeniedSessionError(error, "Agent");
                return true;
              },
            );
            replayRequests.push(
              planRequestIdentity(client, `session/${method}`, sessions[0], {
                denial: "session_access_denied",
              }),
            );
          }
          assert.equal(
            client.updates.length,
            0,
            "foreign Session leaked updates",
          );
        });
      }
      assert.equal(
        clients.size,
        0,
        "join all Plan connections before inspection",
      );
      assert.equal(setupRequests.length, 2);
      assert.equal(replayRequests.length, 26);
      assert.equal(
        replayRequests.filter((request) => !request.denial).length,
        20,
      );
      assert.equal(
        replayRequests.filter((request) => request.denial).length,
        6,
      );
      assert.equal(initializationRequests.length, 14);
      assert.equal(connectionInventory.length, initializationRequests.length);
      const observed = await modelStatus();
      for (const [name, value] of [
        ["model-requests.private.json", observed.requests],
        [
          "request-inventory.private.json",
          [...setupRequests, ...executionRequests, ...replayRequests],
        ],
        ["initialization-inventory.private.json", initializationRequests],
        ["connection-inventory.private.json", connectionInventory],
      ])
        writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
      stage = "runtime-inspection";
      const runtimeInspection = await requestPlanRuntimeInspection(agents);
      return { runtimeInspection, observed };
    },
  );
  stage = "trace-verification";
  const checked = [];
  for (const expected of [
    ...setupRequests,
    ...executionRequests,
    ...replayRequests,
    ...initializationRequests,
  ]) {
    stage = `trace:${expected.phase ?? expected.method}`;
    checked.push(
      await collectPrivatePlanTrace("http://jaeger:16686", expected, {
        directory,
        flush: () => telemetry.flush(),
        secrets,
        requests: observed.requests,
      }),
    );
  }
  const setups = checked.slice(0, setupRequests.length);
  const traces = checked.slice(
    setupRequests.length,
    setupRequests.length + executionRequests.length,
  );
  const replays = checked.slice(
    setupRequests.length + executionRequests.length,
    40,
  );
  const auxiliary = checked.slice(40);
  assert.equal(
    new Set(checked.slice(0, 40).map((trace) => trace.trace_id)).size,
    40,
  );
  assert.deepEqual(
    new Set(traces.map((trace) => trace.trace_id)),
    new Set(observed.requests.map((request) => request.trace_id)),
  );
  assert.equal(
    new Set(traces.map((trace) => trace.run_id)).size,
    outcomes.length,
  );
  assert.equal(
    traces.reduce((sum, trace) => sum + trace.runtime_tool_calls, 0),
    2,
  );
  assert.equal(replays.length, 26);
  assert.equal(replays.filter((trace) => !trace.denial).length, 20);
  assert.equal(replays.filter((trace) => trace.denial).length, 6);
  assert.equal(auxiliary.length, 14);
  const { exit_code: exitCode, ...strict } = privatePlanStrictOutcome(checked);
  console.log(
    asciiJSON({
      status: "business_passed",
      ...strict,
      scenarios: outcomes.length,
      model_requests: observed.requests.length,
      plan_commits: outcomes.reduce((sum, outcome) => sum + outcome.plans, 0),
      invalid_plan_rejections: outcomes.filter((outcome) =>
        outcome.phase.endsWith("-invalid"),
      ).length,
      outcomes,
      traces,
      replay_traces: replays,
      setup_traces: setups,
      auxiliary_traces: auxiliary,
      runtime_inspection: runtimeInspection,
      cross_user_rejections: 2,
      cross_agent_rejections: 4,
    }),
  );
  process.exitCode = exitCode;
}
try {
  await withPrivateCommandResources(clients, telemetry, main);
} catch (error) {
  console.error(
    asciiJSON({
      status: "failed",
      stage,
      ...summarizeFailure(error),
    }),
  );
  process.exitCode = 1;
}
