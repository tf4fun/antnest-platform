import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { z } from "zod";
import { executionConfiguration } from "../test/fixtures/execution-configuration.ts";

// Service-owned Docker E2E: the production image and its migrations execute
// against isolated PostgreSQL, with controlled HTTP model/MCP dependencies.
const execute = promisify(execFile);
const prefix = `antnest-acp-sdk-${randomUUID().slice(0, 8)}`;
const image = process.env.ANTNEST_ACP_AUDIT_IMAGE ?? "antnest/agent-acp-service:sdk-fixes";
const stop = new AbortController();
const interrupt = () => stop.abort(new Error("Docker SDK regression interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const deadline = setTimeout(() => stop.abort(new Error("Docker SDK regression deadline")), 90_000);
const cleanup = [];
const connections = [];
const modelRequests = [];
const toolStarted = Promise.withResolvers();
const toolRelease = Promise.withResolvers();
let toolCalls = 0;
let pool;
let handler;
let server;
let result;
const failures = [];

async function docker(args, cleaning = false) {
  return (
    await execute("docker", args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      ...(cleaning ? {} : { signal: stop.signal }),
    })
  ).stdout.trim();
}
async function bounded(operation) {
  stop.signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(stop.signal.reason);
  stop.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    stop.signal.removeEventListener("abort", onAbort);
  }
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    stop.signal.throwIfAborted();
    if (await check()) return;
    await delay(100, undefined, { signal: stop.signal });
  }
  throw new Error("Fixture condition did not become true");
}
async function hostPort(name, port) {
  return (await docker(["port", name, `${port}/tcp`])).split(":").at(-1);
}

try {
  handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: "sdk-regression-runtime", version: "1.0.0" });
      mcp.registerResource(
        "runtime-info",
        "antnest://runtime/info",
        { mimeType: "application/json" },
        (uri) => ({
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({
                execution_id: "runtime-execution-1",
                environment: {
                  os: "linux",
                  arch: "aarch64",
                  home: "/workspace",
                  workspace: "/workspace",
                },
                instructions: null,
                skills: [],
                warnings: [],
                truncated: false,
              }),
            },
          ],
        }),
      );
      mcp.registerTool("hold", { inputSchema: z.object({}) }, async () => {
        toolCalls += 1;
        toolStarted.resolve();
        await toolRelease.promise;
        return { content: [{ type: "text", text: "fixture released" }] };
      });
      return mcp;
    },
    { legacy: "reject" },
  );
  server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (request.url.startsWith("/mcp")) {
        const answer = await handler.fetch(
          new Request(`http://${request.headers.host}${request.url}`, {
            method: request.method,
            headers: request.headers,
            ...(body.length ? { body: new Uint8Array(body) } : {}),
          }),
        );
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        if (answer.body === null) response.end();
        else await pipeline(Readable.from(answer.body), response);
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      const input = JSON.parse(body.toString());
      modelRequests.push(input);
      const text = JSON.stringify(
        input.messages.filter((message) => message.role === "user").at(-1),
      );
      const choice = text.includes("refused-user-marker")
        ? {
            finish_reason: "stop",
            message: { role: "assistant", content: null, refusal: "refused-answer-marker" },
          }
        : text.includes("cancel-tool-marker")
          ? {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "held-call",
                    type: "function",
                    function: { name: "hold", arguments: "{}" },
                  },
                ],
              },
            }
          : { finish_reason: "stop", message: { role: "assistant", content: "safe-answer" } };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ choices: [choice], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      );
    })().catch((error) => {
      if (!stop.signal.aborted) response.destroy(error);
    });
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const fixtureOrigin = `http://host.docker.internal:${server.address().port}`;
  await docker(["network", "create", prefix]);
  cleanup.push(["network", "rm", prefix]);
  const postgres = `${prefix}-postgres`;
  cleanup.push(["rm", "--force", "--volumes", postgres]);
  await docker([
    "run",
    "--detach",
    "--name",
    postgres,
    "--network",
    prefix,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_USER=acp_audit",
    "-e",
    "POSTGRES_PASSWORD=fixture",
    "-e",
    "POSTGRES_DB=acp_audit",
    "postgres:17-bookworm",
  ]);
  await waitFor(async () => {
    try {
      await docker([
        "exec",
        postgres,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "acp_audit",
        "-d",
        "acp_audit",
      ]);
      return true;
    } catch {
      return false;
    }
  });
  pool = new Pool({
    connectionString: `postgres://acp_audit:fixture@127.0.0.1:${await hostPort(postgres, 5432)}/acp_audit`,
    max: 2,
  });
  const service = `${prefix}-service`;
  cleanup.push(["rm", "--force", "--volumes", service]);
  await docker([
    "run",
    "--detach",
    "--name",
    service,
    "--network",
    prefix,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1::8080",
    "-e",
    `ANTNEST_ACP_DATABASE_URL=postgres://acp_audit:fixture@${postgres}:5432/acp_audit`,
    "-e",
    "ANTNEST_ACP_CLIENT_MCP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "-e",
    "OTEL_SDK_DISABLED=true",
    image,
  ]);
  let origin = `http://127.0.0.1:${await hostPort(service, 8080)}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/status`, { signal: stop.signal })).ok;
    } catch {
      return false;
    }
  });
  const config = executionConfiguration();
  config.providers[0].base_url = `${fixtureOrigin}/v1`;
  config.agents[0].default_authorization.mode = "auto";
  config.agents[0].runtime.mcp_endpoint = `${fixtureOrigin}/mcp`;
  async function publish() {
    const response = await fetch(`${origin}/rpc/agent-acp/apply-execution-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
      signal: stop.signal,
    });
    assert.equal(response.status, 200, await response.text());
  }
  await publish();
  function connect() {
    const updates = [];
    const connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .connect(
        createHttpStream(`${origin}/v1/acp`, {
          headers: {
            "x-antnest-organization-id": "organization-1",
            "x-antnest-principal-id": "principal-1",
            "x-antnest-agent-id": "agent-1",
          },
        }),
      );
    connections.push(connection);
    return {
      updates,
      close: () => {
        connection.close();
        return connection.closed;
      },
      request: (method, params) =>
        bounded(connection.agent.request(method, params, { cancellationSignal: stop.signal })),
      notify: (method, params) => bounded(connection.agent.notify(method, params)),
    };
  }
  let client = connect();
  let observer = connect();
  for (const current of [client, observer])
    await current.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const setup = { cwd: "/workspace", mcpServers: [] };
  const { sessionId } = await client.request("session/new", setup);
  async function metadata(id, peers = [client, observer]) {
    const {
      rows: [stored],
    } = await pool.query("SELECT title, updated_at FROM acp_sessions WHERE id = $1", [id]);
    const expected = {
      sessionUpdate: "session_info_update",
      title: stored.title,
      updatedAt: stored.updated_at.toISOString(),
    };
    for (const peer of peers) {
      await waitFor(() => {
        const actual = peer.updates
          .filter(
            (item) => item.sessionId === id && item.update.sessionUpdate === "session_info_update",
          )
          .at(-1)?.update;
        return actual?.title === expected.title && actual?.updatedAt === expected.updatedAt;
      });
    }
    const listed = (await client.request("session/list", {})).sessions.find(
      (item) => item.sessionId === id,
    );
    assert.equal(listed.title ?? null, expected.title);
    assert.equal(listed.updatedAt, expected.updatedAt);
    return expected;
  }
  assert.equal((await metadata(sessionId, [client])).title, null);
  await observer.request("session/load", { ...setup, sessionId });
  const prompt = (id, text) =>
    client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] });
  assert.deepEqual(await prompt(sessionId, "safe-earlier"), { stopReason: "end_turn" });
  assert.equal((await metadata(sessionId)).title, "safe-earlier");
  assert.deepEqual(await prompt(sessionId, "refused-user-marker"), { stopReason: "refusal" });
  assert.deepEqual(await prompt(sessionId, "safe-next"), { stopReason: "end_turn" });
  const savedInfo = await metadata(sessionId);
  assert(!JSON.stringify(modelRequests.at(-1)).includes("refused-"));
  assert(JSON.stringify(modelRequests.at(-1)).includes("safe-earlier"));
  await observer.request("session/load", { ...setup, sessionId });
  assert(JSON.stringify(observer.updates).includes("refused-user-marker"));
  // Restore current metadata through the production process boundary. Merely
  // recreating a protocol connection must not change the stored activity time.
  const requestsBeforeRestart = modelRequests.length;
  await client.close();
  await observer.close();
  await docker(["restart", service]);
  // Docker may allocate a different ephemeral published port on restart.
  origin = `http://127.0.0.1:${await hostPort(service, 8080)}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/status`, { signal: stop.signal })).ok;
    } catch {
      return false;
    }
  });
  // Credentials are republished by Controller after a cold ACP start. The
  // same revision must restore readiness without changing Session activity.
  await publish();
  client = connect();
  observer = connect();
  for (const current of [client, observer])
    await current.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await client.request("session/resume", { ...setup, sessionId });
  await observer.request("session/load", { ...setup, sessionId });
  assert.deepEqual(await metadata(sessionId), savedInfo);
  assert.equal(modelRequests.length, requestsBeforeRestart);
  const fork = await client.request("session/fork", { ...setup, sessionId });
  assert.equal((await metadata(fork.sessionId, [client])).title, savedInfo.title);
  await client.request("session/close", { sessionId: fork.sessionId });
  const other = await client.request("session/new", setup);
  await client.request("session/close", { sessionId });
  // Close changes Session activity time. Its final metadata can reach a separate
  // observer after the caller receives the close response; establish delivery
  // on both connections before measuring later configuration notifications.
  await metadata(sessionId);
  const offsets = [client.updates.length, observer.updates.length];
  config.revision += 1;
  config.agents[0].default_authorization.mode = "chat";
  await publish();
  await waitFor(() =>
    client.updates
      .slice(offsets[0])
      .some(
        (item) =>
          item.sessionId === other.sessionId &&
          item.update.sessionUpdate === "config_option_update",
      ),
  );
  assert(!client.updates.slice(offsets[0]).some((item) => item.sessionId === sessionId));
  assert(
    !observer.updates.slice(offsets[1]).some((item) => item.sessionId === sessionId),
    `Observer updates after close: ${JSON.stringify(
      observer.updates
        .slice(offsets[1])
        .filter((item) => item.sessionId === sessionId)
        .map((item) => item.update.sessionUpdate),
    )}`,
  );
  await client.request("session/load", { ...setup, sessionId });
  await client.request("session/set_mode", { sessionId, modeId: "auto" });
  const active = prompt(sessionId, "cancel-tool-marker");
  await bounded(toolStarted.promise);
  await observer.notify("session/cancel", { sessionId });
  assert.deepEqual(await active, { stopReason: "cancelled" });
  assert.equal(toolCalls, 1);
  const unknown = await pool.query(
    "SELECT state, tool_effect_state FROM runs WHERE error_class = 'cancelled_tool_outcome_unknown'",
  );
  assert.deepEqual(unknown.rows, [{ state: "unresolved", tool_effect_state: "unknown" }]);
  await assert.rejects(
    prompt(sessionId, "must-remain-protected"),
    (error) => error.data?.code === "runtime_barrier_required",
  );
  assert.equal(toolCalls, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0008_refused_context.sql'",
      )
    ).rows[0].n,
    1,
  );
  result = {
    status: "passed",
    image,
    scenarios: [
      "session-metadata-observers-list-fork-and-process-restart",
      "refusal-context-with-retained-transcript",
      "close-all-observers-and-reload",
      "cancel-unknown-tool-with-runtime-protection",
    ],
    modelRequests: modelRequests.length,
    toolCalls,
  };
} catch (error) {
  failures.push(error);
} finally {
  clearTimeout(deadline);
  stop.abort(new Error("Fixture finished"));
  toolRelease.resolve();
  const release = [
    async () => {
      for (const connection of connections) connection.close();
      await Promise.allSettled(connections.map((connection) => connection.closed));
    },
    async () => pool?.end(),
    async () => handler?.close(),
    async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  ];
  for (const close of release) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const args of cleanup.reverse()) {
    try {
      await docker(args, true);
    } catch (error) {
      failures.push(error);
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failures.length) throw new AggregateError(failures, "Docker SDK regression or cleanup failed");
console.log(JSON.stringify({ ...result, cleanup: "completed" }));
