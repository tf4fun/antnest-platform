import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { rejectedUpgrade, until } from "../acp-closeout/support.mjs";
import {
  assertCatalog,
  assertTranscript,
  transcript,
} from "../acp-commands/evidence.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  nativePrompt,
  storedPrompt,
  audioData,
  pdfData,
  imageData,
  marker,
} from "./fixtures.mjs";
import { inspectNativeTrace } from "./evidence.mjs";

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
  textModel;
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

function httpClient(agent) {
  const traceID = randomBytes(16).toString("hex"),
    updates = [];
  const connection = v1
    .client()
    .onNotification(v1.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .connect(
      createHttpStream(`${gateway}/api/app/agents/${agent}/v1/acp`, {
        headers: {
          Cookie: member.cookie,
          Origin: gateway,
          "X-Antnest-CSRF-Token": member.cookies.get("antnest_csrf"),
          traceparent: `00-${traceID}-${randomBytes(8).toString("hex")}-01`,
        },
      }),
    );
  const request = (method, params, timeout = 15000) =>
    connection.agent.request(method, params, {
      signal: AbortSignal.timeout(timeout),
    });
  return {
    traceID,
    updates,
    close: () => connection.close(),
    initialize: () =>
      request(v1.methods.agent.initialize, {
        protocolVersion: v1.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    request: (name, params, timeout) =>
      request(v1.methods.agent.session[name], params, timeout),
  };
}
async function connect(profile, agent = agents[0]) {
  const client = profile.http
    ? httpClient(agent)
    : connectACP(profile.version, agent, member.cookie);
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
  assert.equal(
    result.configOptions.find((o) => (o.id ?? o.configId) === "model")
      .currentValue,
    value,
  );
}

async function rejectInputs(client, sessionId) {
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
    await catalog(id);
    assertTranscript(client.updates, id, history);
    validate(client, profile);
  };
  try {
    await replay(sessionId);
    client.updates.length = 0;
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    await catalog(fork.sessionId);
    assertTranscript(client.updates, fork.sessionId, []);
    await replay(fork.sessionId);
    traces.push({
      id: client.traceID,
      runs: 0,
      label: `${profile.name}:replay`,
      methods: ["acp.session.resume", "acp.session.fork"],
    });
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
          assertDeniedSessionError(error);
          return true;
        },
      );
    }
    assert.equal(client.updates.length, 0, "foreign Session leaked data");
    traces.push({
      id: client.traceID,
      runs: 0,
      label: `${profile.name}:isolation`,
      methods: ["acp.session.resume", "acp.session.fork", "acp.session.prompt"],
    });
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
    await until(
      () =>
        client.updates.some(
          ({ update }) => update.sessionUpdate === "available_commands_update",
        ),
      "Session initialization",
    );
    await rejectInputs(client, sessionId);
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
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${textModel.model_profile_id}`,
    );
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
    traces.push({
      id: client.traceID,
      runs: 4,
      localFailures: 1,
      label: `${profile.name}:execution`,
    });
    outcomes.push({
      transport: profile.name,
      successful_runs: 3,
      local_failed_runs: 1,
      invalid_inputs: 2,
      replayed_messages: history.length,
      foreign_session_rejections: 3,
    });
  } finally {
    client.close();
  }
}

async function createModel(native) {
  const model = {
    base_url: "http://acp-closeout-model:8080/v1",
    model: native ? "native-model" : "text-model",
    context_window: 64000,
    max_output_tokens: 4096,
    supports_images: native,
    supports_audio: native,
    supports_pdf: native,
  };
  const created = await api(
    "/api/admin/model-profiles",
    {
      display_name: native ? "Native fixture" : "Text fixture",
      api_key: "native-model-test",
      model,
    },
    201,
  );
  const projected = await api(
    `/api/admin/model-profile-revisions/${created.revision_id}`,
  );
  for (const key of ["supports_images", "supports_audio", "supports_pdf"])
    assert.equal(projected.model[key] ?? false, native, `BFF lost ${key}`);
  assert(
    !JSON.stringify(projected).includes("native-model-test"),
    "BFF exposed credential",
  );
  return created;
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
  const model = await createModel(true);
  textModel = await createModel(false);
  const template = await api(
    "/api/admin/templates",
    {
      name: "Native acceptance",
      model_profile_revision_id: model.revision_id,
      system_prompt: "Summarize native attachments.",
      max_model_requests: 5,
      runtime: { image_ref: process.env.TEST_RUNTIME_IMAGE },
    },
    201,
  );
  try {
    for (const name of ["Native", "Other Agent"]) {
      const created = await api(
        "/api/admin/agents",
        {
          owner_user_id: user.user.id,
          name,
          template_id: template.template_id,
          template_revision: 1,
        },
        202,
      );
      agents.push(created.agent.agent_id);
      await operation(created.operation.request_id);
    }
    for (const version of [1, 2])
      await rejectedUpgrade(version, agents[0], stranger);
    await stranger.request(`/api/app/agents/${agents[0]}/v1/acp`, {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: v1.PROTOCOL_VERSION },
      },
      status: 404,
    });
    for (const profile of [
      { name: "v1-ws", version: 1 },
      { name: "v2-ws", version: 2 },
      { name: "v1-http", version: 1, http: true },
    ])
      await exercise(profile);
  } finally {
    const failures = [];
    for (const agent of agents) {
      try {
        await operation(
          (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Agent fixture cleanup failed");
  }
  const requests = await modelStatus();
  assert.equal(requests.length, 9);
  const secrets = [
    marker,
    audioData,
    pdfData,
    imageData,
    "native-model-test",
    ...admin.cookies.values(),
    ...member.cookies.values(),
    ...stranger.cookies.values(),
  ];
  const checked = [];
  for (const { id, ...expected } of traces) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectNativeTrace(
          trace,
          {
            ...expected,
            modelRequests: requests.filter((r) => r.trace_id === id),
          },
          secrets,
        ),
      ),
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      outcomes,
      model_requests: requests.length,
      cross_user_rejections: 3,
      traces: checked,
    }),
  );
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      stage,
      error_type: error.name,
      code: error.code,
      locations: error.stack
        ?.split("\n")
        .filter((s) => s.trim().startsWith("at "))
        .slice(0, 6),
    }),
  );
  process.exitCode = 1;
}
