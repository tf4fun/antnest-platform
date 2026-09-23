import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import inventory from "../../../../services/agent-acp-service/docs/acp-v1-sdk-audit.json" with { type: "json" };
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../../../services/agent-acp-service/src/ports/model.js";
import type { AcpWireClient, WireFrame } from "../support/acp-wire-client.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "audit-answer" }],
  thought: [{ type: "text", text: "audit-thought" }],
  stopReason: "end_turn",
  usage: { inputTokens: 2, outputTokens: 3 },
};
const definitions = schema.$defs as Record<
  string,
  { "x-method"?: string; "x-side"?: string; description?: string }
>;
const validators = new Map<string, ValidateFunction>();
function validate(definition: string, value: unknown) {
  let validator = validators.get(definition);
  if (validator === undefined) {
    validator = new Ajv2020({ strict: false, validateFormats: false }).compile({
      $ref: `#/$defs/${definition}`,
      $defs: schema.$defs,
    });
    validators.set(definition, validator);
  }
  expect(
    validator(value),
    `${definition}: ${JSON.stringify(validator.errors)}`,
  ).toBe(true);
}
async function request(
  client: AcpWireClient,
  method: string,
  params: Record<string, unknown>,
) {
  const definitionsForMethod = Object.entries(definitions).filter(
    ([, definition]) =>
      definition["x-method"] === method && definition["x-side"] === "agent",
  );
  const input = definitionsForMethod.find(([name]) => name.endsWith("Request"));
  const output = definitionsForMethod.find(([name]) =>
    name.endsWith("Response"),
  );
  if (input === undefined || output === undefined)
    throw new Error(`Unknown request: ${method}`);
  validate(input[0], params);
  const response = await client.request(method, params);
  expect(response.error, JSON.stringify(response.error)).toBeUndefined();
  validate(output[0], response.result);
  return response;
}
function updates(client: AcpWireClient) {
  return client.frames.filter((frame) => frame.method === "session/update");
}
function validateUpdates(client: AcpWireClient) {
  for (const frame of updates(client))
    validate("SessionNotification", frame.params);
}
function prompt(client: AcpWireClient, sessionId: string, text: string) {
  return request(client, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

it("SDK-00: every SDK v1 method has an audit disposition and the oracle is pinned", () => {
  const methods = [
    ...new Set(
      Object.values(definitions)
        .map((d) => d["x-method"])
        .filter(Boolean),
    ),
  ];
  expect(inventory.methods.map((row) => row.method).sort()).toEqual(
    methods.sort(),
  );
  expect(new Set(inventory.methods.map((row) => row.method)).size).toBe(
    methods.length,
  );
  const bytes = readFileSync(
    createRequire(
      new URL(
        "../../../../services/agent-acp-service/package.json",
        import.meta.url,
      ),
    ).resolve("@agentclientprotocol/sdk/schema/schema.json"),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    inventory.schemaSha256,
  );
});

const databaseUrl = process.env.ANTNEST_ACP_AUDIT_DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.endsWith("_audit")
) {
  throw new Error(
    "Set ANTNEST_ACP_AUDIT_DATABASE_URL to a disposable database whose name ends in _audit; this suite drops its public schema",
  );
}

describe("ACP v1 SDK conformance audit against real service and PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let release = () => {};
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue(answer);
    release = () => {};
  });
  afterEach(async () => {
    release();
    await app.close();
  });
  afterAll(async () => pool.end());

  it("SDK-01: lifecycle responses, reverse permission and all 11 non-experimental update variants match SDK schemas", async () => {
    const client = await app.connect(1);
    validate("InitializeResponse", client.frames[0]?.result);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    await request(client, "session/set_config_option", {
      sessionId,
      configId: "mode",
      value: "approve",
    });
    await request(client, "session/set_mode", { sessionId, modeId: "approve" });
    app.model.complete
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        calls: [
          {
            id: "plan",
            name: "update_plan",
            arguments: {
              entries: [
                { content: "inspect", priority: "high", status: "in_progress" },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        calls: [
          { id: "read", name: "read", arguments: { path: "private.txt" } },
        ],
      });
    const pending = prompt(client, sessionId, "SDK audit conversation");
    for (let index = 0; index < 2; index += 1) {
      let permission: WireFrame | undefined;
      await expect
        .poll(() => {
          permission = client.frames.filter(
            (frame) => frame.method === "session/request_permission",
          )[index];
          return permission !== undefined;
        })
        .toBe(true);
      validate("RequestPermissionRequest", permission!.params);
      const decision = {
        outcome: { outcome: "selected", optionId: "allow_once" },
      };
      validate("RequestPermissionResponse", decision);
      client.respond(permission!.id!, decision);
    }
    await pending;
    expect(app.tools.call).toHaveBeenCalledOnce();
    await request(client, "session/load", { ...setup, sessionId });
    const updateKinds = new Set(
      updates(client).map((frame) => frame.params?.update?.sessionUpdate),
    );
    const stableKinds = schema.$defs.SessionUpdate.oneOf
      .filter((variant) => !variant.description.includes("UNSTABLE"))
      .map((variant) => variant.properties.sessionUpdate.const);
    expect([...updateKinds].sort()).toEqual(stableKinds.sort());
    validateUpdates(client);
    await request(client, "session/list", {});
    const cursor = client.frames.length;
    await request(client, "session/resume", { ...setup, sessionId });
    expect(
      client.frames
        .slice(cursor)
        .some((frame) =>
          [
            "user_message_chunk",
            "agent_message_chunk",
            "agent_thought_chunk",
          ].includes(String(frame.params?.update?.sessionUpdate)),
        ),
    ).toBe(false);
    const forked = await request(client, "session/fork", {
      ...setup,
      sessionId,
    });
    expect(forked.result?.sessionId).not.toBe(sessionId);
    await request(client, "session/close", { sessionId });
    await request(client, "session/delete", { sessionId });
    await request(client, "session/delete", { sessionId });
  });

  it("SDK-02: changing mode during generation affects the next Run and preserves the current snapshot", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    release = () => gate.resolve();
    app.model.complete.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      return answer;
    });
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    const pending = prompt(client, sessionId, "first");
    await started.promise;
    await request(client, "session/set_mode", { sessionId, modeId: "chat" });
    expect(
      app.model.complete.mock.calls[0]?.[0].snapshot.executionSpec.configuration
        ?.authorization.mode,
    ).toBe("auto");
    release();
    await pending;
    await prompt(client, sessionId, "second");
    expect(app.model.complete.mock.calls[1]?.[0].tools).toEqual([]);
    validateUpdates(client);
  });

  it("SDK-03: close waits for execution cancellation and the active Prompt returns cancelled", async () => {
    const started = Promise.withResolvers<void>();
    app.model.complete.mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return answer;
    });
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    const pending = prompt(client, sessionId, "cancel on close");
    await started.promise;
    await request(client, "session/close", { sessionId });
    expect((await pool.query("SELECT state FROM runs")).rows).toEqual([
      { state: "cancelled" },
    ]);
    const cancelled = await pending;
    expect(cancelled.result).toEqual({ stopReason: "cancelled" });
  });

  it("SDK-04: protocol request cancellation yields one response and does not become session cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    release = () => gate.resolve();
    const list = app.sessions.list.bind(app.sessions);
    vi.spyOn(app.sessions, "list").mockImplementationOnce(async (input) => {
      started.resolve();
      await gate.promise;
      return list(input);
    });
    const client = await app.connect(1);
    const pending = request(client, "session/list", {}); // initialize is id 1; list is id 2
    await started.promise;
    client.notify("$/cancel_request", { requestId: 2 });
    client.notify("$/cancel_request", { requestId: "unknown" });
    release();
    await pending;
    await request(client, "session/new", setup);
    expect(
      client.frames.filter(
        (frame) => frame.id === 2 && frame.method === undefined,
      ),
    ).toHaveLength(1);
    expect(app.cancel).not.toHaveBeenCalled();
  });

  it("GAP-01: refusal excludes the refused user turn and its response from subsequent model context", async () => {
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    await prompt(client, sessionId, "keep-this-earlier-turn");
    app.model.complete.mockResolvedValueOnce({
      ...answer,
      stopReason: "refusal",
      content: [{ type: "text", text: "refused-answer-marker" }],
    });
    expect(
      (await prompt(client, sessionId, "refused-user-marker")).result,
    ).toEqual({
      stopReason: "refusal",
    });
    await prompt(client, sessionId, "new-allowed-turn");
    const context = JSON.stringify(
      app.model.complete.mock.calls.at(-1)?.[0].messages,
    );
    expect(context).toContain("keep-this-earlier-turn");
    expect(context).toContain("new-allowed-turn");
    expect(context).not.toContain("refused-user-marker");
    expect(context).not.toContain("refused-answer-marker");
  });

  it("SDK-05: token exhaustion and request exhaustion retain distinct wire stop reasons", async () => {
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    app.model.complete.mockResolvedValueOnce({
      ...answer,
      stopReason: "max_tokens",
    });
    expect((await prompt(client, sessionId, "token limit")).result).toEqual({
      stopReason: "max_tokens",
    });
    app.model.complete.mockResolvedValue({
      kind: "tool_calls",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      calls: [{ id: "read", name: "read", arguments: { path: "private.txt" } }],
    });
    expect((await prompt(client, sessionId, "request limit")).result).toEqual({
      stopReason: "max_turn_requests",
    });
    expect(app.tools.call).toHaveBeenCalledTimes(4);
    validateUpdates(client);
  });

  it("GAP-02: close frees the Session output subscription while keeping the connection usable", async () => {
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    await request(client, "session/close", { sessionId });
    const readsAfterClose = app.readOutput.mock.calls.length;
    await app.publishConfiguration();
    await request(client, "session/list", {});
    expect(app.readOutput).toHaveBeenCalledTimes(readsAfterClose);
  });

  it("GAP-03: session/cancel returns cancelled even if Tool stopping leaves an unknown effect", async () => {
    const started = Promise.withResolvers<void>();
    app.model.complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      calls: [{ id: "read", name: "read", arguments: { path: "private.txt" } }],
    });
    app.tools.call.mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("Audit Tool outcome unknown"), {
        effectState: "unknown",
        runtimeCallStopped: true,
      });
    });
    const client = await app.connect(1);
    const sessionId = String(
      (await request(client, "session/new", setup)).result?.sessionId,
    );
    const pending = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "cancel unknown tool" }],
    });
    await started.promise;
    client.notify("session/cancel", { sessionId });
    const response = await pending;
    // Preserve the existing conservative internal state. It is not a wire stop reason.
    expect((await pool.query("SELECT state FROM runs")).rows).toEqual([
      { state: "unresolved" },
    ]);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ stopReason: "cancelled" });
  });
});
