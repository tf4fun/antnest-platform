import assert from "node:assert/strict";
import { withAgentCleanup } from "../../support/verification/agent-cleanup.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
  withPrivateCommandResources,
} from "./connection.mjs";
import {
  collectPrivateCommandTrace,
  privateCommandStrictOutcome,
} from "./collector.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { seedCommands } from "./setup.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  assertCatalog,
  assertOrdinaryTool,
  assertTranscript,
  transcript,
} from "./evidence.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { requestCommandRuntimeInspection } from "./runtime-inspection.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const setup = { cwd: "/workspace", mcpServers: [] };
const agents = [],
  traces = [],
  outcomes = [];
const marker = "F08_PRIVATE_ATTACHMENT";
const clients = new Set(),
  issuedSessions = new WeakMap(),
  recordings = new WeakMap();
const secrets = [
  marker,
  "acp-closeout-model",
  "stage3-admin-password",
  "commands-owner-password",
  "commands-stranger-password",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(process.env.ANTNEST_COMMAND_EVIDENCE_DIR);
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
let stage = "setup";
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const login = async (client, email, password) => {
  const result = await client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  issuedSessions.set(client, result.body);
  secrets.push(...client.cookies.values());
  return result;
};

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

function record(client, label, kind = "request", extra = {}) {
  assert(
    client.lastRequest?.method.startsWith("session/"),
    "actual SDK request missing",
  );
  const recorded = { ...client.lastRequest, label, kind, ...extra };
  assert(clients.has(client), "command connection is not active");
  recordings.get(client).push(recorded);
  traces.push(recorded);
}
async function connect(profile, agent, browser = member) {
  const issued = issuedSessions.get(browser);
  assert(issued, "original browser login receipt missing");
  const client = await openPrivateCommandConnection(profile, agent, browser, {
    principal: issued.principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  recordings.set(client, []);
  return client;
}
async function use(client, action) {
  try {
    return await withPrivateCommandConnection(
      client,
      recordings.get(client),
      action,
    );
  } finally {
    clients.delete(client);
  }
}

async function catalog(client, sessionId, version) {
  await until(
    () =>
      client.updates.some(
        ({ update }) => update.sessionUpdate === "available_commands_update",
      ),
    "command catalog",
  );
  assertCatalog(client.updates, sessionId);
  validate(client, version);
}

function validate(client, version) {
  for (const { update } of client.updates)
    assert(
      validators[version - 1](update),
      "invalid official SessionUpdate schema",
    );
}

async function prompt(client, version, sessionId, content) {
  client.updates.length = 0;
  const response = await client.request(
    "prompt",
    { sessionId, prompt: content },
    120000,
  );
  if (version === 1) {
    assert.equal(response.stopReason, "end_turn");
    // Streamable HTTP delivers notifications on an independent SSE request.
    await until(
      () =>
        transcript(client.updates, sessionId).some(
          (message) => message.role === "assistant",
        ),
      "assistant reply",
    );
  } else {
    await until(
      () =>
        client.updates.some(
          ({ update }) =>
            update.sessionUpdate === "state_update" &&
            update.state === "idle" &&
            update.stopReason === "end_turn",
        ),
      "Run idle",
    );
  }
  validate(client, version);
  return transcript(client.updates, sessionId).filter(
    ({ role }) => role === "assistant",
  );
}

async function modelStatus() {
  const response = await fetch("http://commands-model-peer:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(
    status.errors,
    [],
    "model fixture rejected an unexpected request",
  );
  return status.requests;
}

async function restore(profile, agent, sessionId, history) {
  const client = await connect(profile, agent);
  const method = profile.version === 1 ? "load" : "resume";
  const replay = async (id) => {
    client.updates.length = 0;
    await client.request(method, {
      ...setup,
      sessionId: id,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    record(client, `${profile.name}:replay`);
    await catalog(client, id, profile.version);
    assertTranscript(client.updates, id, history);
  };
  await use(client, async () => {
    await replay(sessionId);
    client.updates.length = 0;
    await client.request("resume", { ...setup, sessionId });
    record(client, `${profile.name}:resume-without-replay`);
    await catalog(client, sessionId, profile.version);
    assertTranscript(client.updates, sessionId, []);
    client.updates.length = 0;
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    record(client, `${profile.name}:fork`, "request", {
      sessionId: fork.sessionId,
    });
    await catalog(client, fork.sessionId, profile.version);
    await replay(fork.sessionId);
  });
}

async function rejectForeign(profile, sessionId) {
  const client = await connect(profile, agents[1]);
  const method = profile.version === 1 ? "load" : "resume";
  await use(client, async () => {
    for (const name of [method, "fork", "prompt"]) {
      await assert.rejects(
        client.request(
          name,
          name === "prompt"
            ? { sessionId, prompt: [{ type: "text", text: "/help" }] }
            : { ...setup, sessionId },
        ),
        (error) => {
          assertDeniedSessionError(error, "Agent");
          return true;
        },
      );
      record(client, `${profile.name}:foreign-session:${name}`, "request", {
        rejection: "session_access_denied",
      });
    }
    assert.equal(
      client.updates.length,
      0,
      "foreign Session leaked notifications",
    );
  });
}

async function exercise(profile) {
  stage = `${profile.name}:commands`;
  const before = await modelStatus(),
    history = [];
  const client = await connect(profile, agents[0]);
  let sessionId;
  await use(client, async () => {
    ({ sessionId } = await client.request("new", setup));
    record(client, `${profile.name}:new`, "request", { sessionId });
    await catalog(client, sessionId, profile.version);
    stage = `${profile.name}:unsupported-binary-context`;
    client.updates.length = 0;
    await assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [
          { type: "text", text: "/help" },
          {
            type: "resource",
            resource: {
              uri: "attachment:///notes.zip",
              mimeType: "application/zip",
              blob: "UEsDBA==",
            },
          },
        ],
      }),
      (error) => {
        assert.equal(error.code, -32020);
        assert.equal(error.data?.code, "unsupported_resource_content");
        assert.equal(error.data?.retryable, false);
        return true;
      },
    );
    record(client, `${profile.name}:unsupported-binary`, "request", {
      rejection: "unsupported_resource_content",
    });
    assert.equal(
      client.updates.length,
      0,
      "unsupported content created output",
    );
    for (const text of ["/help", "/帮助"]) {
      stage = `${profile.name}:${text}`;
      const content = [{ type: "text", text }];
      if (text === "/help") {
        content.push({
          type: "resource_link",
          uri: `file:///${marker}.txt`,
          name: "notes.txt",
          mimeType: "text/plain",
        });
        content.push({
          type: "resource",
          resource: {
            uri: "attachment:///notes.txt",
            mimeType: "text/plain",
            text: marker,
          },
        });
      }
      const replies = await prompt(client, profile.version, sessionId, content);
      record(client, `${profile.name}:${text}`, "command");
      assert.equal(replies.length, 1, "command must reply once");
      assert.equal(replies[0].content.length, 1);
      assert.equal(replies[0].content[0].type, "text");
      assert(
        replies[0].content[0].text.includes(
          text === "/help" ? "Available commands" : "可用命令",
        ),
      );
      assert(
        !client.updates.some(({ update }) =>
          ["usage_update", "tool_call", "tool_call_update"].includes(
            update.sessionUpdate,
          ),
        ),
        "command used a model or Tool",
      );
      history.push({ role: "user", content }, ...replies);
    }
  });
  stage = `${profile.name}:restore`;
  await restore(profile, agents[0], sessionId, history);
  stage = `${profile.name}:isolation`;
  await rejectForeign(profile, sessionId);
  assert.deepEqual(
    await modelStatus(),
    before,
    "help or replay called the model",
  );
  outcomes.push({
    transport: profile.name,
    commands: 2,
    replayed_messages: history.length,
    foreign_session_rejections: 3,
    unsupported_binary_rejections: 1,
  });
  console.log(asciiJSON({ status: "transport_passed", ...outcomes.at(-1) }));
  if (profile.http) return;
  stage = `${profile.name}:ordinary-run`;
  const ordinary = await connect(profile, agents[0]);
  await use(ordinary, async () => {
    await ordinary.request("resume", { ...setup, sessionId });
    record(ordinary, `${profile.name}:ordinary-resume`);
    await catalog(ordinary, sessionId, profile.version);
    const phase = `v${profile.version}-baseline`;
    const replies = await prompt(ordinary, profile.version, sessionId, [
      { type: "text", text: phase },
    ]);
    assert.equal(
      replies
        .flatMap(({ content }) => content)
        .map((block) => block.text ?? "")
        .join(""),
      `${phase} verified`,
    );
    assertOrdinaryTool(ordinary.updates, profile.version, phase);
    record(ordinary, `${profile.name}:ordinary-run`, "ordinary", { phase });
  });
}

async function main() {
  assert(directory, "command evidence directory required");
  shellStoragePreflight(directory);
  shellStoragePreflight(process.env.ANTNEST_COMMAND_RUNTIME_CHECKPOINT_DIR);
  assert(process.env.TEST_RUNTIME_IMAGE, "test Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "commands-owner@example.com",
    display_name: "Commands owner",
    password: "commands-owner-password",
    role: "member",
  });
  await api("/api/admin/directory/users", {
    email: "commands-stranger@example.com",
    display_name: "Another user",
    password: "commands-stranger-password",
    role: "member",
  });
  await login(member, "commands-owner@example.com", "commands-owner-password");
  await login(
    stranger,
    "commands-stranger@example.com",
    "commands-stranger-password",
  );
  const template = await seedCommands(api, process.env.TEST_RUNTIME_IMAGE);
  const runtimeInspection = await withAgentCleanup(agents, api, async () => {
    for (const name of ["Commands", "Other agent"]) {
      const created = await api(
        "/api/admin/agents",
        {
          owner_user_id: user.user.id,
          name,
          template_id: template.template_id,
          template_revision: template.revision,
        },
        202,
      );
      agents.push(created.agent.agent_id);
      await operation(created.operation.request_id);
      await waitForAgentReady(() => api(`/api/admin/agents/${agents.at(-1)}`));
    }
    for (const profile of [
      { name: "v1-ws", version: 1 },
      { name: "v2-ws", version: 2 },
      { name: "v1-http", version: 1, http: true },
    ]) {
      const foreign = await connect(profile, agents[0], stranger);
      await use(foreign, async () => {
        await assertAgentDenied(foreign);
        record(foreign, `${profile.name}:foreign-user`, "request", {
          rejection: "access_denied",
        });
      });
      await exercise(profile);
    }
    stage = "runtime-inspection";
    assert.equal(
      clients.size,
      0,
      "join all command connections before Runtime inspection",
    );
    return requestCommandRuntimeInspection(agents);
  });
  stage = "trace-verification";
  const requests = await modelStatus();
  assert.equal(requests.length, 4);
  for (const phase of ["v1-baseline", "v2-baseline"])
    assert.deepEqual(
      requests
        .filter((request) => request.phase === phase)
        .map((request) => request.stage),
      ["tool", "reply"],
    );
  assert.equal(new Set(requests.map((request) => request.trace_id)).size, 2);
  assert.equal(traces.length, 40);
  assert.equal(traces.filter((trace) => trace.kind === "command").length, 6);
  assert.equal(traces.filter((trace) => trace.kind === "request").length, 32);
  assert.equal(traces.filter((trace) => trace.kind === "ordinary").length, 2);
  assert.equal(
    clients.size,
    0,
    "all original connections must be joined before collection",
  );
  for (const [profile, count] of [
    ["v1-ws", 14],
    ["v2-ws", 14],
    ["v1-http", 12],
  ])
    assert.equal(
      traces.filter((item) => item.label.startsWith(profile + ":")).length,
      count,
    );
  writeEvidenceFile(
    directory,
    "model-requests.private.json",
    JSON.stringify(requests) + "\n",
  );
  writeEvidenceFile(
    directory,
    "request-inventory.private.json",
    JSON.stringify(traces) + "\n",
  );
  const checked = [];
  for (const expected of traces) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectPrivateCommandTrace("http://jaeger:16686", expected, {
        directory,
        flush: () => telemetry.flush(),
        secrets,
        requests,
      }),
    );
  }
  assert.equal(new Set(checked.map((trace) => trace.trace_id)).size, 40);
  const normal = checked.filter((trace) => trace.kind === "ordinary");
  assert.deepEqual(
    new Set(normal.map((trace) => trace.trace_id)),
    new Set(requests.map((request) => request.trace_id)),
  );
  assert.equal(
    new Set(checked.map((trace) => trace.run_id).filter(Boolean)).size,
    8,
  );
  const { exit_code: exitCode, ...strict } =
    privateCommandStrictOutcome(checked);
  console.log(
    asciiJSON({
      status: "business_passed",
      ...strict,
      scenarios: outcomes.length,
      outcomes,
      model_requests: requests.length,
      runtime_inspection: runtimeInspection,
      cross_user_rejections: 3,
      traces: checked.filter((trace) => trace.kind !== "ordinary"),
      normal_traces: normal,
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
