import { assertResourceId } from "./contracts.mjs";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { withPrivateCommandConnection } from "../acp-commands/connection.mjs";
import { openStage3Connection } from "./connection.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { observeBrowserSession } from "../identity-closeout/bridge-session-observer.mjs";
import { logoutSession } from "../identity-closeout/session-fault-lifecycle.mjs";
import {
  assertCatalog,
  assertOrdinaryTool,
  assertTranscript,
  transcript,
} from "../acp-commands/evidence.mjs";
import { until } from "../acp-closeout/support.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway, login } from "./identity.mjs";

const setup = { cwd: "/workspace", mcpServers: [] };
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
export async function modelStatus() {
  const response = await fetch("http://stage3-model-peer:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.errors, []);
  return result.requests;
}
function record(traces, client, label, kind = "request", extra = {}) {
  assert(client.lastRequest?.method.startsWith("session/"));
  Object.assign(client.lastRequest, { kind, label, ...extra });
  traces.push(client.lastRequest);
}
async function connect(profile, agentId, browser, options) {
  const index = options.connections.length;
  const client = await openStage3Connection(profile, agentId, browser, {
    principal: options.principal,
    telemetry: options.telemetry,
    secrets: options.secrets,
    preserve: (snapshot) =>
      writeEvidenceFile(
        options.directory,
        `connection-${index}.json`,
        JSON.stringify(snapshot, null, 2),
      ),
  });
  options.clients.add(client);
  options.connections.push(client);
  return client;
}
async function issuedLogin(browser) {
  const startedMono = performance.now();
  const response = await login(browser);
  return {
    ...response.body,
    observation: {
      startedMono,
      completedMono: performance.now(),
      traceID: response.traceID,
    },
  };
}
// v1 lists delivered Skills after the built-in commands; v2 does not.
const skillCommands = (profile) =>
  profile.version === 1 ? (profile.skills ?? []) : [];
async function catalog(client, sessionId, skills) {
  await until(
    () =>
      client.updates.some(
        (f) => f.update.sessionUpdate === "available_commands_update",
      ),
    "catalog",
  );
  assertCatalog(client.updates, sessionId, skills);
}
function validate(client, version) {
  for (const frame of client.updates)
    assert(
      validators[version - 1](frame.update),
      "official SessionUpdate schema rejected output",
    );
}
const tools = (frames) =>
  frames
    .filter(
      (f) =>
        f.update.status === "completed" &&
        ["tool_call", "tool_call_update"].includes(f.update.sessionUpdate),
    )
    .map((f) => ({ id: f.update.toolCallId, content: f.update.content }));
export async function exerciseWorkspace(
  profile,
  agentId,
  member,
  phase,
  traces,
  options,
) {
  const client = await connect(profile, agentId, member, options);
  let sessionId, history, terminal;
  await withPrivateCommandConnection(client, [], async () => {
    ({ sessionId } = await client.request("new", setup));
    assertResourceId("session", sessionId);
    record(traces, client, `${phase}:new`, "request", { sessionId });
    await catalog(client, sessionId, skillCommands(profile));
    client.updates.length = 0;
    const content = [{ type: "text", text: phase }];
    const result = await client.request(
      "prompt",
      { sessionId, prompt: content },
      120000,
    );
    if (profile.version === 1) assert.equal(result.stopReason, "end_turn");
    await until(
      () =>
        profile.version === 1
          ? transcript(client.updates, sessionId).some(
              (m) => m.role === "assistant",
            )
          : client.updates.some(
              (f) =>
                f.update.sessionUpdate === "state_update" &&
                f.update.state === "idle" &&
                f.update.stopReason === "end_turn",
            ),
      "completed Run",
    );
    record(traces, client, `${phase}:prompt`, "ordinary", { phase });
    validate(client, profile.version);
    assertOrdinaryTool(client.updates, profile.version, phase);
    history = [
      { role: "user", content },
      {
        role: "assistant",
        content: [{ type: "text", text: `${phase} verified` }],
      },
    ];
    assert.deepEqual(
      transcript(client.updates, sessionId).filter(
        (m) => m.role === "assistant",
      ),
      history.slice(1),
    );
    terminal = tools(client.updates);
    assert.equal(terminal.length, 1);
  });
  await restoreWorkspace(
    { profile, agentId, member, phase, sessionId, history, terminal, options },
    traces,
  );
  return {
    profile,
    agentId,
    member,
    phase,
    sessionId,
    history,
    terminal,
    options,
  };
}
export async function restoreWorkspace(saved, traces) {
  const {
    profile,
    agentId,
    member,
    phase,
    sessionId,
    history,
    terminal,
    options,
  } = saved;
  const before = await modelStatus(),
    client = await connect(profile, agentId, member, options);
  await withPrivateCommandConnection(client, [], async () => {
    const listed = await client.request("list", {});
    record(traces, client, `${phase}:list`);
    assert(
      listed.sessions.some((s) => s.sessionId === sessionId),
      "durable Session not listed",
    );
    await client.request(profile.version === 1 ? "load" : "resume", {
      ...setup,
      sessionId,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    record(traces, client, `${phase}:replay`);
    await catalog(client, sessionId, skillCommands(profile));
    await until(
      () =>
        transcript(client.updates, sessionId).length === history.length &&
        tools(client.updates).length === terminal.length,
      "full history replay",
    );
    assertTranscript(client.updates, sessionId, history);
    assert.deepEqual(tools(client.updates), terminal);
    validate(client, profile.version);
    client.updates.length = 0;
    await client.request("resume", { ...setup, sessionId });
    record(traces, client, `${phase}:resume`);
    await catalog(client, sessionId, skillCommands(profile));
    assertTranscript(client.updates, sessionId, []);
    assert.deepEqual(tools(client.updates), []);
  });
  assert.deepEqual(
    await modelStatus(),
    before,
    "replay executed Provider work",
  );
}
export async function logoutRevocation(
  agentId,
  version,
  traces,
  secrets,
  skills = [],
  options,
) {
  const before = await modelStatus(),
    browser = new GatewayClient(gateway);
  const issued = await issuedLogin(browser);
  secrets.push(...browser.cookies.values());
  const profile = { name: `v${version}-ws`, version, skills };
  const client = await connect(profile, agentId, browser, {
    ...options,
    principal: issued.principal,
  });
  let sessionId, closure;
  await withPrivateCommandConnection(client, [], async () => {
    ({ sessionId } = await client.request("new", setup));
    assertResourceId("session", sessionId);
    Object.assign(client.lastRequest, {
      label: `logout-v${version}:new`,
      sessionId,
    });
    await catalog(client, sessionId, skillCommands(profile));
    assertTranscript(client.updates, sessionId, []);
    assert.deepEqual(tools(client.updates), []);
    const updates = structuredClone(client.updates);
    const observer = await observeBrowserSession(browser, client, {
      agentId,
      sessionId,
      issued,
    });
    await withPrivateCommandConnection(observer, [], async () => {
      const checkpoint = observer.checkpoint("revoked");
      const cause = await logoutSession(
        browser,
        observer,
        checkpoint,
        issued.principal,
      );
      const closed = await observer.waitForClose(checkpoint);
      const denial = await observer.rejectPrompt();
      assert.equal(denial.status, 401);
      assert.deepEqual(client.updates, updates);
      closure = {
        ...closed,
        protocolVersion: version,
        principal: issued.principal,
        cause,
        denial,
        protocolClientClosedLocally: false,
      };
      options.logouts.push(closure);
      writeEvidenceFile(
        options.directory,
        "logout-observations.json",
        JSON.stringify(options.logouts, null, 2),
      );
    });
  });
  closure.protocolClientClosedLocally = true;
  writeEvidenceFile(
    options.directory,
    "logout-observations.json",
    JSON.stringify(options.logouts, null, 2),
  );
  const recovered = await issuedLogin(browser);
  secrets.push(...browser.cookies.values());
  await restoreWorkspace(
    {
      profile,
      agentId,
      member: browser,
      phase: `logout-v${version}`,
      sessionId,
      history: [],
      terminal: [],
      options: { ...options, principal: recovered.principal },
    },
    traces,
  );
  assert.deepEqual(await modelStatus(), before);
  await browser.request("/api/session", { method: "DELETE", status: 204 });
  return {
    version,
    rejected: true,
    transport: "http-sse",
    denial_status: 401,
    recovered_empty: true,
  };
}
