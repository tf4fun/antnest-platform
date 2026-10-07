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
  assertCatalog,
  assertTranscript,
  transcript,
} from "../acp-commands/evidence.mjs";
import { commandConnection } from "../acp-commands/connection.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { seedNative } from "./setup.mjs";
import {
  nativePrompt,
  storedPrompt,
  audioData,
  pdfData,
  imageData,
  marker,
} from "./fixtures.mjs";
import { collectNativeTrace, nativeStrictOutcome } from "./trace.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const agents = [],
  traces = [],
  outcomes = [];
const setup = { cwd: "/workspace", mcpServers: [] };
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
let stage = "setup",
  textModelID;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const login = (client, email, password) =>
  client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });

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
  traces.push({ ...client.lastRequest, label, kind, ...extra });
}
async function connect(profile, agent = agents[0], browser = member) {
  const client = commandConnection(profile, agent, browser);
  try {
    const result = await client.initialize();
    const capabilities =
      profile.version === 1
        ? result.agentCapabilities.promptCapabilities
        : result.capabilities.session.prompt;
    for (const name of ["image", "audio", "embeddedContext"])
      assert(capabilities[name], `missing ${name} capability`);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
function validate(client, profile) {
  for (const { update } of client.updates)
    assert(
      validators[profile.version - 1](update),
      "invalid official SessionUpdate schema",
    );
}
async function modelStatus() {
  const response = await fetch("http://acp-closeout-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status.errors, [], "model fixture rejected request");
  assert.equal(status.referenceRequests, 0, "resource link was fetched");
  return status.requests;
}
async function send(client, profile, sessionId, prompt, fails = false) {
  client.updates.length = 0;
  const request = client.request("prompt", { sessionId, prompt }, 120000);
  if (fails && profile.version === 1) {
    await assert.rejects(request, (error) => {
      assert.equal(error.code, -32022);
      assert.equal(error.data?.code, "model_unsupported_content");
      assert.equal(error.data?.retryable, false);
      return true;
    });
  } else {
    const response = await request;
    if (profile.version === 1) assert.equal(response.stopReason, "end_turn");
    else {
      await until(
        () =>
          client.updates.some(
            ({ update }) =>
              update.sessionUpdate === "state_update" &&
              update.state === "idle",
          ),
        "Run idle",
        120000,
      );
      const terminal = client.updates.filter(
        ({ update }) =>
          update.sessionUpdate === "state_update" && update.state === "idle",
      );
      assert.equal(terminal.length, 1, "duplicate terminal notification");
      assert.equal(
        terminal[0].update.stopReason,
        fails ? "_failed" : "end_turn",
      );
    }
  }
  if (!fails) {
    await until(
      () =>
        transcript(client.updates, sessionId).some(
          (m) => m.role === "assistant",
        ),
      "assistant response",
    );
    assert.equal(
      transcript(client.updates, sessionId)
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content)
        .map((c) => c.text ?? "")
        .join(""),
      `${profile.name} native input verified`,
    );
  }
  record(
    client,
    `${profile.name}:${fails ? "mismatch" : prompt[0].text.split(" ").at(-1)}`,
    fails ? "local-failure" : "native",
    { phase: prompt[0].text, version: profile.version },
  );
  validate(client, profile);
  assert(
    !client.updates.some(({ update }) =>
      ["tool_call", "tool_call_update"].includes(update.sessionUpdate),
    ),
    "unexpected Tool call",
  );
  return transcript(client.updates, sessionId).filter(
    (m) => m.role === "assistant",
  );
}
async function setModel(client, profile, sessionId, value) {
  const result = await client.request("setConfigOption", {
    sessionId,
    configId: "model",
    value,
    ...(profile.version === 2 ? { type: "id" } : {}),
  });
  record(client, `${profile.name}:model-selection`);
  assert.equal(
    result.configOptions.find((o) => (o.id ?? o.configId) === "model")
      .currentValue,
    value,
  );
}

async function rejectInputs(client, profile, sessionId) {
  const before = (await modelStatus()).length;
  for (const content of [
    {
      type: "resource",
      resource: {
        uri: "attachment:///bad.zip",
        mimeType: "application/zip",
        blob: "UEsDBA==",
      },
    },
    {
      type: "audio",
      mimeType: "audio/wav",
      data: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
    },
  ]) {
    client.updates.length = 0;
    await assert.rejects(
      client.request("prompt", { sessionId, prompt: [content] }),
      (error) => {
        assert.equal(error.code, -32020);
        assert.equal(
          error.data?.code,
          content.type === "audio"
            ? "unsupported_audio_content"
            : "unsupported_resource_content",
        );
        assert.equal(error.data?.retryable, false);
        return true;
      },
    );
    record(client, `${profile.name}:invalid-${content.type}`, "request", {
      rejection:
        content.type === "audio"
          ? "unsupported_audio_content"
          : "unsupported_resource_content",
    });
    assert.equal(client.updates.length, 0, "invalid input created output");
  }
  assert.equal((await modelStatus()).length, before);
}

async function restore(profile, sessionId, history) {
  const client = await connect(profile);
  const catalog = async (id) => {
    await until(
      () =>
        client.updates.some(
          ({ update }) => update.sessionUpdate === "available_commands_update",
        ),
      "Session catalog",
    );
    assertCatalog(client.updates, id);
    validate(client, profile);
  };
  const replay = async (id) => {
    client.updates.length = 0;
    await client.request(profile.version === 1 ? "load" : "resume", {
      ...setup,
      sessionId: id,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    record(client, `${profile.name}:replay`);
    await catalog(id);
    assertTranscript(client.updates, id, history);
    validate(client, profile);
  };
  try {
    await replay(sessionId);
    client.updates.length = 0;
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    record(client, `${profile.name}:fork`, "request", {
      sessionId: fork.sessionId,
    });
    await catalog(fork.sessionId);
    assertTranscript(client.updates, fork.sessionId, []);
    await replay(fork.sessionId);
  } finally {
    client.close();
  }
}
async function rejectForeign(profile, sessionId) {
  const client = await connect(profile, agents[1]);
  try {
    for (const name of [
      profile.version === 1 ? "load" : "resume",
      "fork",
      "prompt",
    ]) {
      await assert.rejects(
        client.request(
          name,
          name === "prompt"
            ? { sessionId, prompt: nativePrompt(profile.name) }
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
    assert.equal(client.updates.length, 0, "foreign Session leaked data");
  } finally {
    client.close();
  }
}
async function exercise(profile) {
  stage = `${profile.name}:native`;
  const before = (await modelStatus()).length,
    client = await connect(profile),
    history = [];
  let sessionId;
  try {
    ({ sessionId } = await client.request("new", setup));
    record(client, `${profile.name}:new`, "request", { sessionId });
    await until(
      () =>
        client.updates.some(
          ({ update }) => update.sessionUpdate === "available_commands_update",
        ),
      "Session initialization",
    );
    await rejectInputs(client, profile, sessionId);
    const reply = await send(
      client,
      profile,
      sessionId,
      nativePrompt(profile.name),
    );
    history.push(
      { role: "user", content: storedPrompt(profile.name) },
      ...reply,
    );
    const continuation = [{ type: "text", text: `${profile.name} continue` }];
    history.push(
      { role: "user", content: continuation },
      ...(await send(client, profile, sessionId, continuation)),
    );
    assert.equal((await modelStatus()).length, before + 2);
    // History is checked before deliberately adding a failed Run to this Session.
    stage = `${profile.name}:replay`;
    await restore(profile, sessionId, history);
    await rejectForeign(profile, sessionId);
    assert.equal(
      (await modelStatus()).length,
      before + 2,
      "replay or denial called Provider",
    );
    stage = `${profile.name}:model-mismatch`;
    await setModel(client, profile, sessionId, `profile:${textModelID}`);
    await send(
      client,
      profile,
      sessionId,
      [{ type: "text", text: `${profile.name} mismatch` }],
      true,
    );
    assert.equal(
      (await modelStatus()).length,
      before + 2,
      "unsupported model reached Provider",
    );
    await setModel(client, profile, sessionId, "agent_default");
    await send(client, profile, sessionId, [
      { type: "text", text: `${profile.name} restored` },
    ]);
    assert.equal((await modelStatus()).length, before + 3);
    outcomes.push({
      transport: profile.name,
      successful_runs: 3,
      local_failed_runs: 1,
      invalid_inputs: 2,
      replayed_messages: history.length,
      foreign_session_rejections: 3,
    });
    console.log(asciiJSON({ status: "transport_passed", ...outcomes.at(-1) }));
  } finally {
    client.close();
  }
}

async function main() {
  assert(process.env.TEST_RUNTIME_IMAGE, "test Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "native-owner@example.com",
    display_name: "Native owner",
    password: "native-owner-password",
    role: "member",
  });
  await api("/api/admin/directory/users", {
    email: "native-stranger@example.com",
    display_name: "Other user",
    password: "native-stranger-password",
    role: "member",
  });
  await login(member, "native-owner@example.com", "native-owner-password");
  await login(
    stranger,
    "native-stranger@example.com",
    "native-stranger-password",
  );
  const seeded = await seedNative(api, process.env.TEST_RUNTIME_IMAGE);
  const template = seeded.template;
  textModelID = seeded.textModelID;
  await withAgentCleanup(agents, api, async () => {
    for (const name of ["Native", "Other Agent"]) {
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
      try {
        await assertAgentDenied(foreign);
        record(foreign, `${profile.name}:foreign-user`, "request", {
          rejection: "access_denied",
        });
      } finally {
        foreign.close();
      }
      await exercise(profile);
    }
  });
  const requests = await modelStatus();
  assert.equal(requests.length, 9);
  assert.deepEqual(
    requests.map((item) => item.phase),
    ["v1-ws", "v2-ws", "v1-http"].flatMap((profile) =>
      ["native", "continue", "restored"].map((phase) => `${profile} ${phase}`),
    ),
  );
  assert.equal(new Set(requests.map((item) => item.trace_id)).size, 9);
  assert.equal(traces.length, 48);
  assert.equal(traces.filter((trace) => trace.kind === "request").length, 36);
  assert.equal(traces.filter((trace) => trace.kind === "native").length, 9);
  assert.equal(
    traces.filter((trace) => trace.kind === "local-failure").length,
    3,
  );
  const secrets = [
    marker,
    audioData,
    pdfData,
    imageData,
    "native-model-test",
    "native-owner-password",
    "native-stranger-password",
    "F09_PRIVATE_PDF",
    ...requests.map((item) => item.phase),
    ...admin.cookies.values(),
    ...member.cookies.values(),
    ...stranger.cookies.values(),
  ];
  const checked = [];
  for (const expected of traces) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectNativeTrace(
        "http://jaeger:16686",
        expected,
        secrets,
        requests,
      ),
    );
  }
  assert.equal(new Set(checked.map((trace) => trace.trace_id)).size, 48);
  assert.equal(
    new Set(checked.map((trace) => trace.run_id).filter(Boolean)).size,
    12,
  );
  assert.deepEqual(
    new Set(
      checked
        .filter((trace) => trace.kind === "native")
        .map((trace) => trace.trace_id),
    ),
    new Set(requests.map((item) => item.trace_id)),
  );
  const { accepted, ...strict } = nativeStrictOutcome(checked);
  console.log(
    asciiJSON({
      status: "business_passed",
      ...strict,
      outcomes,
      model_requests: requests.length,
      cross_user_rejections: 3,
      traces: checked,
    }),
  );
  if (!accepted) process.exitCode = 1;
}
try {
  await main();
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
