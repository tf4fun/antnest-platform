import assert from "node:assert/strict";
import { withMultimodalAgentCleanup } from "./cleanup-evidence.mjs";
import { preserveFileFailure as preserveNativeFailure } from "../acp-files/failure-evidence.mjs";
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
  openPrivateNativeConnection,
  nativeRequestIdentity,
  nativeRequestKey,
  nativePromptReceipt,
} from "./connection.mjs";
import { requestMultimodalRuntimeInspection } from "./runtime-inspection.mjs";
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
import { collectNativeTraceDiagnostics } from "./diagnostics.mjs";
import {
  collectNativeRunBusiness,
  inspectNativeRunBusiness,
} from "./run-business.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const agents = [],
  traces = [],
  initializationRequests = [],
  connectionInventory = [],
  outcomes = [];
const clients = new Set(),
  issuedSessions = new WeakMap(),
  recordings = new WeakMap();
const secrets = [
  marker,
  audioData,
  pdfData,
  imageData,
  "native-model-test",
  "stage3-admin-password",
  "native-owner-password",
  "native-stranger-password",
  "F09_PRIVATE_PDF",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(
  process.env.ANTNEST_MULTIMODAL_EVIDENCE_DIR,
);
const diagnostics = createTraceDiagnostics({ directory });
let modelStatusCount = 0;
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
const login = async (client, email, password) => {
  const result = await client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  issuedSessions.set(client, result.body);
  secrets.push(client.accessToken, ...client.cookies.values());
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
  assert(clients.has(client), "native connection is not active");
  const recorded = nativeRequestIdentity(client, label, kind, extra);
  recordings.get(client).push(recorded);
  traces.push(recorded);
}
async function connect(profile, agent = agents[0], browser = member) {
  const issued = issuedSessions.get(browser);
  assert(issued, "original browser login receipt missing");
  const client = await openPrivateNativeConnection(profile, agent, browser, {
    principal: issued.principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  initializationRequests.push(client.initializationRequest);
  recordings.set(client, [client.initializationRequest]);
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
    connectionInventory.push({
      version: client.version,
      agent_id: client.agentId,
      transport: client.transport,
      initialization_result: structuredClone(client.initializationResult),
      updates: structuredClone(client.updates),
      ...(client.transport === "http"
        ? { http_connection: client.httpSnapshot() }
        : {
            connection_trace_id: client.connectionTraceID,
            client_span_id: client.clientSpanID,
            requests: structuredClone(client.requests),
          }),
    });
    clients.delete(client);
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
  const status = await response.json();
  writeEvidenceFile(
    directory,
    `model-status-${String(++modelStatusCount).padStart(3, "0")}.private.json`,
    JSON.stringify(status) + "\n",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(status.errors, [], "model fixture rejected request");
  assert.equal(status.referenceRequests, 0, "resource link was fetched");
  return status.requests;
}
async function send(client, profile, sessionId, prompt, fails = false) {
  client.updates.length = 0;
  const request = client.request("prompt", { sessionId, prompt }, 120000);
  let result = null,
    failure = null;
  if (fails && profile.version === 1) {
    await assert.rejects(request, (error) => {
      failure = error;
      assert.equal(error.code, -32022);
      assert.equal(error.data?.code, "model_unsupported_content");
      assert.equal(error.data?.retryable, false);
      return true;
    });
  } else {
    result = await request;
    if (profile.version === 1) assert.equal(result.stopReason, "end_turn");
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
    {
      phase: prompt[0].text,
      promptReceipt: nativePromptReceipt(client, sessionId, {
        result,
        error: failure,
        failed: fails,
      }),
    },
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
  return use(client, async () => {
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
  });
}
async function rejectForeign(profile, sessionId) {
  const client = await connect(profile, agents[1]);
  return use(client, async () => {
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
  });
}
async function exercise(profile) {
  stage = `${profile.name}:native`;
  const before = (await modelStatus()).length,
    client = await connect(profile),
    history = [];
  let sessionId;
  await use(client, async () => {
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
  });
}

async function main() {
  shellStoragePreflight(directory);
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
  const { requests, runtimeInspection, runBusiness } =
    await withMultimodalAgentCleanup(
      agents,
      admin,
      async (consumed) => {
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
          await waitForAgentReady(() =>
            api(`/api/admin/agents/${agents.at(-1)}`),
          );
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
        const requests = await modelStatus();
        assert.equal(requests.length, 9);
        assert.deepEqual(
          requests.map((item) => item.phase),
          ["v1-ws", "v2-ws", "v1-http"].flatMap((profile) =>
            ["native", "continue", "restored"].map(
              (phase) => `${profile} ${phase}`,
            ),
          ),
        );
        assert.equal(traces.length, 48);
        assert.equal(
          traces.filter((trace) => trace.kind === "request").length,
          36,
        );
        assert.equal(traces.filter((trace) => trace.rejection).length, 18);
        assert.equal(
          traces.filter((trace) => trace.kind === "request" && !trace.rejection)
            .length,
          18,
        );
        assert.equal(
          traces.filter((trace) => trace.kind === "native").length,
          9,
        );
        assert.equal(
          traces.filter((trace) => trace.kind === "local-failure").length,
          3,
        );
        secrets.push(
          ...requests.map((item) => item.phase),
          ...admin.cookies.values(),
          ...member.cookies.values(),
          ...stranger.cookies.values(),
        );
        assert.equal(
          clients.size,
          0,
          "all original native connections must be joined",
        );
        assert.equal(initializationRequests.length, 12);
        assert.equal(connectionInventory.length, 12);
        for (const profile of ["v1-ws", "v2-ws", "v1-http"]) {
          assert.equal(
            traces.filter((item) => item.label.startsWith(profile + ":"))
              .length,
            16,
          );
          assert.equal(
            initializationRequests.filter((item) =>
              item.label.startsWith(profile + ":"),
            ).length,
            4,
          );
        }
        const wire = connectionInventory.flatMap((connection) =>
          connection.transport === "http"
            ? connection.http_connection.requests.filter(
                (item) => item.method === "POST",
              )
            : connection.requests,
        );
        assert.equal(
          wire.length,
          60,
          "all actual SDK requests must be inventoried",
        );
        const identities = [...traces, ...initializationRequests].map(
          nativeRequestKey,
        );
        assert.equal(
          new Set(identities).size,
          60,
          "duplicate native request inventory",
        );
        for (const [name, value] of [
          ["model-requests.private.json", requests],
          ["request-inventory.private.json", traces],
          ["initialization-inventory.private.json", initializationRequests],
          ["connection-inventory.private.json", connectionInventory],
        ])
          writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
        stage = "run-business";
        let auditResponseCount = 0;
        const runEvidence = await collectNativeRunBusiness({
          agentIds: agents,
          requests: traces,
          principalId: issuedSessions.get(member).principal.user_id,
          read: async (path) => {
            const file = `run-audit-response-${String(++auditResponseCount).padStart(3, "0")}.private.json`;
            let archiveFailure,
              captured = false,
              result;
            try {
              result = await admin.request(path, {
                onResponse: (response) => {
                  captured = true;
                  try {
                    assert(
                      directory,
                      "native business evidence directory required",
                    );
                    writeEvidenceFile(
                      directory,
                      file,
                      JSON.stringify({
                        method: "GET",
                        path,
                        ...response,
                      }) + "\n",
                    );
                  } catch (error) {
                    archiveFailure = error;
                  }
                },
              });
            } catch (error) {
              if (archiveFailure)
                throw new AggregateError(
                  [error, archiveFailure],
                  "Native audit request and archive failed",
                );
              throw error;
            }
            if (archiveFailure) throw archiveFailure;
            assert(captured, "actual native audit response was not observed");
            return result.body;
          },
          preserve: (value) => {
            assert(directory, "native business evidence directory required");
            writeEvidenceFile(
              directory,
              "run-business.private.json",
              JSON.stringify(value) + "\n",
            );
          },
        });
        const runBusiness = inspectNativeRunBusiness(runEvidence);
        stage = "runtime-inspection";
        const runtimeInspection = await requestMultimodalRuntimeInspection(
          agents,
          { consumed },
        );
        return { requests, runtimeInspection, runBusiness };
      },
      { directory },
    );
  // Both physical Runtime receipts and Agent delete operations have completed
  // before auxiliary Trace collection begins.
  stage = "trace-diagnostics";
  const observed = await collectNativeTraceDiagnostics(
    "http://jaeger:16686",
    { requests: traces, initializations: initializationRequests },
    {
      directory,
      diagnostics,
      flush: () => telemetry.flush(),
      secrets,
      requests,
    },
  );
  return {
    scenarios: outcomes.length,
    outcomes,
    model_requests: requests.length,
    business_requests: traces.length,
    initialization_requests: initializationRequests.length,
    connections: connectionInventory.length,
    runtime_inspection: runtimeInspection,
    run_business: runBusiness,
    run_business_receipt: "run-business.private.json",
    cross_user_rejections: 3,
    traces: observed.checked.slice(0, traces.length),
    initialization_traces: observed.checked.slice(traces.length),
    observability: observed.strict,
  };
}
try {
  // Exhausting collection's budget cannot skip the actual telemetry shutdown.
  const shutdownDiagnostics = createTraceDiagnostics({
    directory,
    budgetMs: 30_000,
  });
  const result = await withPrivateCommandResources(
    clients,
    {
      shutdown: () =>
        shutdownDiagnostics.run("telemetry-shutdown", () =>
          telemetry.shutdown(),
        ),
    },
    main,
  );
  console.log(
    asciiJSON({
      ...result,
      status: "business_passed",
      trace_diagnostics: diagnostics.summary(),
    }),
  );
  console.log(asciiJSON({ trace_diagnostics: shutdownDiagnostics.summary() }));
  process.exitCode = 0;
} catch (error) {
  console.error(
    asciiJSON(
      await preserveNativeFailure({
        directory,
        error,
        stage,
        inventory: {
          connectionInventory,
          initializationRequests,
          traces,
          outcomes,
        },
        fetchStatus: () =>
          fetch("http://acp-closeout-model:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
}
