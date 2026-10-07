import { assertResourceId } from "./contracts.mjs";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { commandConnection } from "../acp-commands/connection.mjs";
import {
  assertCatalog,
  assertOrdinaryTool,
  assertTranscript,
  transcript,
} from "../acp-commands/evidence.mjs";
import { until } from "../acp-closeout/support.mjs";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
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
  traces.push({ ...client.lastRequest, kind, label, ...extra });
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
) {
  const client = commandConnection(profile, agentId, member);
  let sessionId, history, terminal;
  try {
    await client.initialize();
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
  } finally {
    client.close();
  }
  await restoreWorkspace(
    { profile, agentId, member, phase, sessionId, history, terminal },
    traces,
  );
  return { profile, agentId, member, phase, sessionId, history, terminal };
}
export async function restoreWorkspace(saved, traces) {
  const { profile, agentId, member, phase, sessionId, history, terminal } =
    saved;
  const before = await modelStatus(),
    client = commandConnection(profile, agentId, member);
  try {
    await client.initialize();
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
  } finally {
    client.close();
  }
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
) {
  const before = await modelStatus(),
    browser = new GatewayClient(gateway);
  await login(browser);
  secrets.push(...browser.cookies.values());
  const client = connectACP(version, agentId, browser.cookie);
  let sessionId;
  try {
    await client.initialize();
    ({ sessionId } = await client.request("new", setup));
    await catalog(client, sessionId, skillCommands({ version, skills }));
    assertTranscript(client.updates, sessionId, []);
    assert.deepEqual(tools(client.updates), []);
    const updates = structuredClone(client.updates);
    await browser.request("/api/session", { method: "DELETE", status: 204 });
    assert.equal(browser.cookie, "");
    await assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "revoked-work-must-not-run" }],
      }),
    );
    assert.equal(client.closeCode, 1008);
    assert.deepEqual(client.updates, updates);
  } finally {
    client.close();
  }
  await login(browser);
  secrets.push(...browser.cookies.values());
  await restoreWorkspace(
    {
      profile: { name: `v${version}-ws`, version, skills },
      agentId,
      member: browser,
      phase: `logout-v${version}`,
      sessionId,
      history: [],
      terminal: [],
    },
    traces,
  );
  assert.deepEqual(await modelStatus(), before);
  await browser.request("/api/session", { method: "DELETE", status: 204 });
  return { version, rejected: true, close_code: 1008, recovered_empty: true };
}
