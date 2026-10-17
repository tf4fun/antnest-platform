import assert from "node:assert/strict";
import { applyPatch, parsePatch } from "diff";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { toolUpdates } from "../acp-progress/evidence.mjs";
import { withAgentCleanup } from "../../support/verification/agent-cleanup.mjs";
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
  openPrivateFileConnection,
  fileRequestIdentity,
} from "./connection.mjs";
import { requestFilesRuntimeInspection } from "./runtime-inspection.mjs";
import { fileStateExpectations } from "./file-state.mjs";
import { preserveFileFailure } from "./failure-evidence.mjs";
import {
  collectPrivateFileTrace,
  privateFileStrictOutcome,
} from "./collector.mjs";
import { assertFileEvents } from "./evidence.mjs";
import { seedFiles, assertAgentDenied } from "./setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { cases, contentMarker } from "./model.mjs";
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
  connectionInventory = [],
  liveUpdates = [];
const clients = new Set(),
  issuedSessions = new WeakMap();
const secrets = [
  contentMarker,
  "file-model-test",
  "stage3-admin-password",
  "file-owner-password",
  "file-stranger-password",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(process.env.ANTNEST_FILES_EVIDENCE_DIR);
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
  const client = await openPrivateFileConnection(version, agent, browser, {
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
      updates: structuredClone(client.updates),
    });
    clients.delete(client);
  }
}
function inspectFrames(version, sessionId, frames) {
  assert(
    frames.every((frame) => frame.sessionId === sessionId),
    "foreign Files Session update",
  );
  for (const { update } of frames)
    assert(
      validators[version - 1](update),
      "official SDK schema rejected Files update",
    );
}
async function replay(client, version, sessionId, expected) {
  client.updates.length = 0;
  await client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  replayRequests.push(
    fileRequestIdentity(
      client,
      version === 1 ? "session/load" : "session/resume",
      sessionId,
    ),
  );
  inspectFrames(version, sessionId, client.updates);
  assert.deepEqual(toolUpdates(client.updates), expected);
}
async function scenario(version, item, agent) {
  const phase = `v${version}-${item.id}`;
  stage = phase + ":connect";
  const original = await connect(version, agent);
  const { sessionId, updates } = await use(original, async () => {
    stage = phase + ":new";
    const { sessionId } = await original.request("new", setup);
    setupRequests.push(fileRequestIdentity(original, "session/new", sessionId));
    original.updates.length = 0;
    stage = phase + ":prompt";
    const response = await original.request(
      "prompt",
      { sessionId, prompt: [{ type: "text", text: phase }] },
      120000,
    );
    const execution = fileRequestIdentity(
      original,
      "session/prompt",
      sessionId,
      { phase },
    );
    executionRequests.push(execution);
    stage = phase + ":live-evidence";
    if (version === 1) assert.equal(response.stopReason, "end_turn");
    else
      await until(
        () =>
          original.updates.some(
            ({ sessionId: selected, update }) =>
              selected === sessionId &&
              update.sessionUpdate === "state_update" &&
              update.state === "idle" &&
              update.stopReason === "end_turn",
          ),
        `${phase} idle`,
      );
    assert(
      JSON.stringify(original.updates).includes(`${phase} verified`),
      "verified final model response missing",
    );
    inspectFrames(version, sessionId, original.updates);
    const patch = assertFileEvents(version, item, original.updates);
    const updates = structuredClone(toolUpdates(original.updates));
    assert.equal(updates.length, 2);
    const toolCallId = updates[0].toolCallId;
    assert.match(toolCallId ?? "", /^[a-f0-9]{64}$/u);
    assert(
      updates.every((update) => update.toolCallId === toolCallId),
      "foreign actual file Tool call ID",
    );
    execution.toolCallId = toolCallId;
    if (patch !== undefined) {
      const parsed = parsePatch(patch);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].newFileName, item.path);
      assert.equal(
        parsed[0].oldFileName,
        item.change.before === null ? "/dev/null" : item.path,
      );
      assert.equal(
        applyPatch(item.change.before ?? "", patch),
        item.change.after,
      );
    }
    liveUpdates.push({
      phase,
      agent_id: agent,
      session_id: sessionId,
      frames: structuredClone(original.updates),
    });
    return { sessionId, updates };
  });
  // The original connection and telemetry must be joined before fresh replay.
  stage = phase + ":replay";
  const reader = await connect(version, agent);
  await use(reader, async () => {
    await replay(reader, version, sessionId, updates);
    const fork = await reader.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    replayRequests.push(
      fileRequestIdentity(reader, "session/fork", fork.sessionId),
    );
    await replay(reader, version, fork.sessionId, updates);
  });
  outcomes.push({
    status: "file_case_passed",
    phase,
    file_facts: true,
    replay_and_fork: true,
    tool_status: item.error ? "failed" : "completed",
  });
  console.log(asciiJSON(outcomes.at(-1)));
}
async function modelStatus() {
  const response = await fetch("http://file-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  const raw = await response.text();
  writeEvidenceFile(directory, "model-status.private.json", raw);
  assert.equal(response.status, 200);
  const observed = JSON.parse(raw);
  assert.deepEqual(observed.errors, []);
  assert.equal(outcomes.length, 16);
  assert.equal(observed.requests.length, 32);
  return observed;
}
async function main() {
  shellStoragePreflight(directory);
  shellStoragePreflight(process.env.ANTNEST_FILES_RUNTIME_CHECKPOINT_DIR);
  const image = process.env.TEST_RUNTIME_IMAGE;
  assert(image, "test Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "file-owner@example.com",
    display_name: "File owner",
    password: "file-owner-password",
    role: "member",
  });
  await api("/api/admin/directory/users", {
    email: "file-stranger@example.com",
    display_name: "Another user",
    password: "file-stranger-password",
    role: "member",
  });
  await login(member, "file-owner@example.com", "file-owner-password");
  await login(stranger, "file-stranger@example.com", "file-stranger-password");
  const template = await seedFiles(api, image);
  const { observed, runtimeInspection } = await withAgentCleanup(
    agents,
    api,
    async () => {
      for (const version of [1, 2]) {
        stage = `create-v${version}`;
        const created = await api(
          "/api/admin/agents",
          {
            owner_user_id: user.user.id,
            name: `Files v${version}`,
            template_id: template.template_id,
            template_revision: template.revision,
          },
          202,
        );
        const agent = created.agent.agent_id;
        agents.push(agent);
        await operation(created.operation.request_id);
        await waitForAgentReady(() => api(`/api/admin/agents/${agent}`));
        const foreign = await connect(version, agent, stranger);
        await use(foreign, async () => {
          await assertAgentDenied(foreign);
          setupRequests.push(
            fileRequestIdentity(foreign, "session/new", undefined, {
              denial: "access_denied",
            }),
          );
        });
        for (const item of cases) await scenario(version, item, agent);
      }
      assert.equal(
        clients.size,
        0,
        "join all Files connections before host inspection",
      );
      assert.equal(setupRequests.length, 18);
      assert.equal(setupRequests.filter((request) => request.denial).length, 2);
      assert.equal(executionRequests.length, 16);
      assert.equal(replayRequests.length, 48);
      assert.equal(initializationRequests.length, 34);
      assert.equal(connectionInventory.length, 34);
      const observed = await modelStatus();
      const files = fileStateExpectations(
        agents,
        observed.requests,
        executionRequests,
      );
      for (const [name, value] of [
        ["model-requests.private.json", observed.requests],
        [
          "request-inventory.private.json",
          [...setupRequests, ...executionRequests, ...replayRequests],
        ],
        ["initialization-inventory.private.json", initializationRequests],
        ["connection-inventory.private.json", connectionInventory],
        ["live-updates.private.json", liveUpdates],
      ])
        writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
      stage = "runtime-and-file-inspection";
      const runtimeInspection = await requestFilesRuntimeInspection(agents, {
        files,
      });
      return { observed, runtimeInspection };
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
      await collectPrivateFileTrace("http://jaeger:16686", expected, {
        directory,
        flush: () => telemetry.flush(),
        secrets,
        requests: observed.requests,
      }),
    );
  }
  const setups = checked.slice(0, 18),
    traces = checked.slice(18, 34),
    replays = checked.slice(34, 82),
    auxiliary = checked.slice(82);
  assert.equal(checked.length, 116);
  assert.equal(
    new Set(checked.slice(0, 82).map((trace) => trace.trace_id)).size,
    82,
  );
  assert.equal(new Set(traces.map((trace) => trace.run_id)).size, 16);
  assert.deepEqual(
    new Set(traces.map((trace) => trace.trace_id)),
    new Set(observed.requests.map((request) => request.trace_id)),
  );
  for (const trace of traces) {
    assert.equal(trace.phases.length, 1);
    assert.equal(trace.tool_calls, 1);
    assert.equal(trace.runtime_tool_calls, 1);
    const runtime = runtimeInspection.runtimes.find(
      (row) => row.agent_id === trace.agent_id,
    );
    assert(runtime, "Files Trace belongs to an uninspected Runtime");
    assert.equal(trace.runtime_generation, String(runtime.generation));
  }
  assert.equal(replays.length, 48);
  assert.equal(auxiliary.length, 34);
  const { exit_code: exitCode, ...strict } = privateFileStrictOutcome(checked);
  console.log(
    asciiJSON({
      status: "business_passed",
      ...strict,
      scenarios: outcomes.length,
      model_requests: observed.requests.length,
      outcomes,
      traces,
      replay_traces: replays,
      setup_traces: setups,
      auxiliary_traces: auxiliary,
      cross_user_rejections: 2,
      runtime_inspection: {
        status: runtimeInspection.status,
        raw_sha256: runtimeInspection.raw_sha256,
        runtimes: runtimeInspection.runtimes,
        files: runtimeInspection.files.map((file) => ({
          agent_id: file.agent_id,
          protocol_version: file.protocol_version,
          path: file.path,
          read_sha256: file.read.sha256,
          final: file.final,
          claim: file.claim,
        })),
      },
    }),
  );
  process.exitCode = exitCode;
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
        inventory: {
          connectionInventory,
          initializationRequests,
          setupRequests,
          executionRequests,
          replayRequests,
          liveUpdates,
        },
      }),
    ),
  );
  process.exitCode = 1;
}
