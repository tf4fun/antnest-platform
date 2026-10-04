import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { createHttpStream } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/http-stream.js";
import {
  createMcpHandler,
  McpServer,
} from "../../../services/agent-acp-service/node_modules/@modelcontextprotocol/server/dist/index.mjs";
import { Pool } from "../../../services/agent-acp-service/node_modules/pg/esm/index.mjs";
import { z } from "../../../services/agent-acp-service/node_modules/zod/index.js";
import { executionConfiguration } from "../../../services/agent-acp-service/test/fixtures/execution-configuration.ts";
import {
  createFixture,
  headers as authenticatedHeaders,
} from "../service-authentication/acp/auth-fixture.mjs";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { providerPolicyChecks } from "../service-authentication/acp/provider-policy-docker.mjs";

// Service-owned Docker E2E: the production image and its migrations execute
// against isolated PostgreSQL, with controlled HTTP model/MCP dependencies.
const execute = promisify(execFile);
const prefix = `antnest-acp-sdk-${randomUUID().slice(0, 8)}`;
const credentials = resolve(
  "artifacts/verification/acp-authentication",
  prefix,
  "credentials",
);
const authentication = createFixture(credentials);
const image =
  process.env.ANTNEST_ACP_AUDIT_IMAGE ?? "antnest/agent-acp-service:sdk-fixes";
const stop = new AbortController();
const interrupt = () =>
  stop.abort(new Error("Docker SDK regression interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const deadline = setTimeout(
  () => stop.abort(new Error("Docker SDK regression deadline")),
  180_000,
);
const cleanup = [];
const connections = [];
const modelRequests = [];
const runtimeRequests = [];
const runtimeReference = {
  runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
  runtime_execution_id: "runtime-execution-1",
  connection_id: "rci_" + randomBytes(16).toString("hex"),
  credential: {
    caller: "agent-acp-service",
    token: randomBytes(32).toString("base64url"),
  },
};
let runtimeChecks = 0;
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
      const mcp = new McpServer({
        name: "sdk-regression-runtime",
        version: "1.0.0",
      });
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
    if (request.url === "/rpc/identity/jwks") {
      assert.equal(
        request.headers["antnest-service-authorization"],
        `Bearer ${authentication.outgoing}`,
      );
      assert.equal(request.headers["antnest-caller-context"], undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(authentication.jwks));
      return;
    }
    if (request.url.startsWith("/mcp")) {
      if (
        request.headers["antnest-service-authorization"] !==
        "Bearer " + runtimeReference.credential.token
      ) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="antnest-service"',
        });
        response.end(
          JSON.stringify({
            code: "runtime_unauthorized",
            message: "Runtime request rejected",
            retryable: false,
          }),
        );
        return;
      }
    }
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (request.url.startsWith("/mcp")) {
        assert.equal(
          request.headers["x-antnest-expected-execution-id"],
          runtimeReference.runtime_execution_id,
        );
        for (const header of [
          "authorization",
          "antnest-caller-context",
          "cookie",
          "baggage",
        ])
          assert.equal(request.headers[header], undefined);
        runtimeRequests.push(request.method);
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
            message: {
              role: "assistant",
              content: null,
              refusal: "refused-answer-marker",
            },
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
          : {
              finish_reason: "stop",
              message: { role: "assistant", content: "safe-answer" },
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [choice],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
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
    "postgres:17.11-bookworm",
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
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--volume",
    `${credentials}:/run/auth:ro`,
    "-p",
    "127.0.0.1::8080",
    "-p",
    "127.0.0.1::8081",
    "-e",
    `ANTNEST_ACP_DATABASE_URL=postgres://acp_audit:fixture@${postgres}:5432/acp_audit`,
    "-e",
    "ANTNEST_SERVICE_AUTH_MODE=token",
    "-e",
    "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true",
    "-e",
    "ANTNEST_SERVICE_AUTH_CALLERS_FILE=/run/auth/callers.json",
    "-e",
    "ANTNEST_SERVICE_AUTH_TOKEN_DIR=/run/auth/outgoing",
    "-e",
    `ANTNEST_ACP_IDENTITY_URL=${fixtureOrigin}`,
    "-e",
    "ANTNEST_ACP_CLIENT_MCP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "-e",
    "OTEL_SDK_DISABLED=true",
    "-e",
    "ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS=true",
    image,
  ]);
  let origin = `http://127.0.0.1:${await hostPort(service, 8080)}`;
  let controlOrigin = `http://127.0.0.1:${await hostPort(service, 8081)}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/status`, { signal: stop.signal })).ok;
    } catch {
      return false;
    }
  });
  const provider = await providerPolicyChecks({
    docker,
    service,
    prefix,
    cleanup,
    signal: stop.signal,
    fixtureOrigin,
  });
  const config = executionConfiguration();
  config.providers[0].base_url = provider.baseUrl;
  config.providers[0].credential.secret = "synthetic-provider-secret";
  config.agents[0].default_authorization.mode = "auto";
  config.agents[0].runtime = {
    ...runtimeReference,
    mcp_endpoint: `${fixtureOrigin}/mcp`,
  };
  let authenticationChecks = 0;
  for (const operation of ["apply-execution-snapshot", "settle-agent"]) {
    for (const base of [origin, controlOrigin]) {
      const response = await fetch(`${base}/rpc/agent-acp/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: stop.signal,
      });
      assert.equal(response.status, base === origin ? 404 : 401);
      await response.text();
      authenticationChecks++;
    }
    const hidden = await fetch(`${origin}/rpc/agent-acp/${operation}`, {
      method: "POST",
      headers: {
        ...authenticatedHeaders(authentication, "agent-controller"),
        "content-type": "application/json",
      },
      body: "{}",
      signal: stop.signal,
    });
    assert.equal(hidden.status, 404);
    await hidden.text();
    authenticationChecks++;
  }
  for (const [headers, status, code] of [
    [{}, 401, "service_unauthenticated"],
    [
      authenticatedHeaders(authentication, "runtime-controller"),
      403,
      "caller_not_allowed",
    ],
    [
      authenticatedHeaders(authentication, "edge-gateway"),
      401,
      "caller_context_invalid",
    ],
    [
      authenticatedHeaders(authentication, "edge-gateway", {
        agt: "agent-1",
        aud: ["agent-ui"],
      }),
      401,
      "caller_context_invalid",
    ],
    [
      authenticatedHeaders(authentication, "edge-gateway", {
        agt: "agent-1",
        iat: 1,
        exp: 61,
      }),
      401,
      "caller_context_invalid",
    ],
  ]) {
    const response = await fetch(
      `${origin}/rpc/agent-acp/get-agent-execution-state`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-antnest-agent-id": "agent-1",
          "x-antnest-organization-id": "organization-1",
          "x-antnest-principal-id": "principal-1",
        },
        body: "{}",
        signal: stop.signal,
      },
    );
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    authenticationChecks++;
  }
  const denied = await fetch(
    `${controlOrigin}/rpc/agent-acp/apply-execution-snapshot`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(authentication, "edge-gateway", {
          agt: "agent-1",
        }),
        "content-type": "application/json",
      },
      body: JSON.stringify(config),
      signal: stop.signal,
    },
  );
  assert.equal(denied.status, 403);
  await denied.text();
  authenticationChecks++;
  for (const [body, media, status] of [
    ['{"organization_id":"a","organization_id":"b"}', "application/json", 400],
    ["{}", "application/json; charset=latin1", 415],
  ]) {
    const response = await fetch(
      `${controlOrigin}/rpc/agent-acp/apply-execution-snapshot`,
      {
        method: "POST",
        headers: {
          ...authenticatedHeaders(authentication, "agent-controller"),
          "content-type": media,
        },
        body,
        signal: stop.signal,
      },
    );
    assert.equal(response.status, status);
    await response.text();
    authenticationChecks++;
  }
  async function publish(publication = config, status = 200) {
    const response = await fetch(
      `${controlOrigin}/rpc/agent-acp/apply-execution-snapshot`,
      {
        method: "POST",
        headers: {
          ...authenticatedHeaders(authentication, "agent-controller"),
          "content-type": "application/json",
        },
        body: JSON.stringify(publication),
        signal: stop.signal,
      },
    );
    assert.equal(response.status, status, await response.text());
  }
  const missingConnection = structuredClone(config);
  delete missingConnection.agents[0].runtime.connection_id;
  await publish(missingConnection, 400);
  const wrongCaller = structuredClone(config);
  wrongCaller.agents[0].runtime.credential.caller = "runtime-controller";
  await publish(wrongCaller, 400);
  const closedWithCredential = structuredClone(config);
  closedWithCredential.agents[0].accepting_runs = false;
  await publish(closedWithCredential, 400);
  runtimeChecks += 3;
  await publish();
  await publish();
  for (const revision of [config.revision, config.revision + 1]) {
    const changedToken = structuredClone(config);
    changedToken.revision = revision;
    changedToken.agents[0].runtime.credential.token =
      randomBytes(32).toString("base64url");
    await publish(changedToken, 409);
    runtimeChecks++;
  }
  async function privateFiles() {
    // Report only metadata and hashes; never move a sender bearer into exec argv.
    return JSON.parse(
      await docker([
        "exec",
        service,
        "node",
        "--input-type=module",
        "-e",
        `import {readdirSync,statSync,readFileSync} from "node:fs";
       import {createHash} from "node:crypto";
       const roots=readdirSync("/tmp").filter(n=>n.startsWith("antnest-acp-runtime-"));
       const records=roots.map(n=>{const root="/tmp/"+n;
         return {root,mode:statSync(root).mode&0o7777,uid:statSync(root).uid,
           files:readdirSync(root).map(id=>{const directory=root+"/"+id;const path=directory+"/antnest-runtime";
             const file=statSync(path);return {id,mode:file.mode&0o7777,uid:file.uid,
               directoryMode:statSync(directory).mode&0o7777,
               digest:createHash("sha256").update(readFileSync(path)).digest("hex")};})};});
       process.stdout.write(JSON.stringify(records));`,
      ]),
    );
  }
  function verifyPrivateFiles(records, populated) {
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.mode, 0o700);
    assert.equal(record.uid, process.getuid());
    assert.equal(record.files.length, populated ? 1 : 0);
    if (populated) {
      const file = record.files[0];
      assert.equal(file.id, runtimeReference.connection_id);
      assert.equal(file.mode, 0o600);
      assert.equal(file.uid, process.getuid());
      assert.equal(file.directoryMode, 0o700);
      assert.equal(
        file.digest,
        createHash("sha256")
          .update(runtimeReference.credential.token)
          .digest("hex"),
      );
    }
    runtimeChecks++;
    return record.root;
  }
  const originalPrivateRoot = verifyPrivateFiles(await privateFiles(), true);
  async function assertPublicStorage() {
    const rows = (
      await pool.query(
        "SELECT revision, configuration FROM execution_configurations",
      )
    ).rows;
    assert.equal(rows.length, 1);
    const storedRuntime = rows[0].configuration.agents[0].runtime;
    assert(!("credential" in storedRuntime));
    assert(!JSON.stringify(rows).includes(runtimeReference.credential.token));
    assert(
      !JSON.stringify(modelRequests).includes(
        runtimeReference.credential.token,
      ),
    );
    assert(
      !JSON.stringify(
        await pool
          .query("SELECT execution_snapshot FROM runs")
          .then((r) => r.rows),
      ).includes(runtimeReference.credential.token),
    );
    const logs = await docker(["logs", service]);
    assert(!logs.includes(runtimeReference.credential.token));
    runtimeChecks++;
  }
  await assertPublicStorage();
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
            ...authenticatedHeaders(authentication, "agent-ui", {
              agt: "agent-1",
            }),
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
        bounded(
          connection.agent.request(method, params, {
            cancellationSignal: stop.signal,
          }),
        ),
      notify: (method, params) =>
        bounded(connection.agent.notify(method, params)),
    };
  }
  let client = connect();
  let observer = connect();
  for (const current of [client, observer])
    await current.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
  const setup = { cwd: "/workspace", mcpServers: [] };
  const { sessionId } = await client.request("session/new", setup);
  async function metadata(id, peers = [client, observer]) {
    const {
      rows: [stored],
    } = await pool.query(
      "SELECT title, updated_at FROM acp_sessions WHERE id = $1",
      [id],
    );
    const expected = {
      sessionUpdate: "session_info_update",
      title: stored.title,
      updatedAt: stored.updated_at.toISOString(),
    };
    for (const peer of peers) {
      await waitFor(() => {
        const actual = peer.updates
          .filter(
            (item) =>
              item.sessionId === id &&
              item.update.sessionUpdate === "session_info_update",
          )
          .at(-1)?.update;
        return (
          actual?.title === expected.title &&
          actual?.updatedAt === expected.updatedAt
        );
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
    client.request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text }],
    });
  assert.deepEqual(await prompt(sessionId, "safe-earlier"), {
    stopReason: "end_turn",
  });
  const storedRun = (
    await pool.query(
      "SELECT execution_snapshot FROM runs ORDER BY created_at LIMIT 1",
    )
  ).rows[0].execution_snapshot;
  assert.deepEqual(storedRun.runtime, {
    revision: runtimeReference.runtime_revision,
    executionId: runtimeReference.runtime_execution_id,
    mcpEndpoint: config.agents[0].runtime.mcp_endpoint,
    connectionId: runtimeReference.connection_id,
  });
  runtimeChecks++;
  assert.equal((await metadata(sessionId)).title, "safe-earlier");
  assert.deepEqual(await prompt(sessionId, "refused-user-marker"), {
    stopReason: "refusal",
  });
  assert.deepEqual(await prompt(sessionId, "safe-next"), {
    stopReason: "end_turn",
  });
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
  controlOrigin = `http://127.0.0.1:${await hostPort(service, 8081)}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/status`, { signal: stop.signal })).ok;
    } catch {
      return false;
    }
  });
  // Credentials are republished by Controller after a cold ACP start. The
  // same revision must restore readiness without changing Session activity.
  const coldPrivateRoot = verifyPrivateFiles(await privateFiles(), false);
  assert.notEqual(coldPrivateRoot, originalPrivateRoot);
  const unavailable = await fetch(
    `${origin}/rpc/agent-acp/get-agent-execution-state`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(authentication, "agent-ui", { agt: "agent-1" }),
        "content-type": "application/json",
      },
      body: "{}",
      signal: stop.signal,
    },
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "execution_state_unavailable");
  runtimeChecks++;
  await publish();
  verifyPrivateFiles(await privateFiles(), true);
  client = connect();
  observer = connect();
  for (const current of [client, observer])
    await current.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
  await client.request("session/resume", { ...setup, sessionId });
  await observer.request("session/load", { ...setup, sessionId });
  assert.deepEqual(await metadata(sessionId), savedInfo);
  assert.equal(modelRequests.length, requestsBeforeRestart);
  const fork = await client.request("session/fork", { ...setup, sessionId });
  assert.equal(
    (await metadata(fork.sessionId, [client])).title,
    savedInfo.title,
  );
  await client.request("session/close", { sessionId: fork.sessionId });
  const other = await client.request("session/new", setup);
  const bridgeClient = connect();
  const bridgePeer = connect();
  for (const peer of [bridgeClient, bridgePeer]) {
    const negotiated = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      _meta: {
        "antnest.dev/bridge": {
          intentReceipt: 1,
          targetCancel: 1,
          deliveryMark: 1,
        },
      },
    });
    assert.equal(negotiated._meta?.["antnest.dev/bridge"]?.configurationCas, 1);
    await peer.request("session/load", {
      ...setup,
      sessionId: other.sessionId,
    });
  }
  const configurationRevision = String(
    (
      await pool.query(
        "SELECT configuration_revision FROM acp_sessions WHERE id = $1",
        [other.sessionId],
      )
    ).rows[0].configuration_revision,
  );
  const expectedRevision = createHash("sha256")
    .update(JSON.stringify([other.sessionId, configurationRevision]))
    .digest("hex");
  const conditional = (peer, value) =>
    peer.request("session/set_config_option", {
      sessionId: other.sessionId,
      configId: "mode",
      value,
      _meta: { "antnest.dev/configuration": { expectedRevision } },
    });
  const attempts = await Promise.allSettled([
    conditional(bridgeClient, "auto"),
    conditional(bridgePeer, "chat"),
  ]);
  const winner = attempts.findIndex(
    (attempt) => attempt.status === "fulfilled",
  );
  assert(winner === 0 || winner === 1, JSON.stringify(attempts));
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  const loser = attempts[1 - winner];
  assert.equal(loser.status, "rejected");
  assert.equal(loser.reason?.data?.code, "configuration_conflict");
  await assert.rejects(
    conditional(bridgeClient, "approve"),
    (error) => error.data?.code === "configuration_conflict",
  );
  const committed = (
    await pool.query(
      "SELECT configuration_revision, configuration FROM acp_sessions WHERE id = $1",
      [other.sessionId],
    )
  ).rows[0];
  assert.equal(committed.configuration_revision, "1");
  assert.equal(
    committed.configuration.authorizationMode,
    winner === 0 ? "auto" : "chat",
  );
  const winningMode = winner === 0 ? "auto" : "chat";
  await waitFor(() =>
    [bridgeClient, bridgePeer].every((peer) =>
      peer.updates.some(
        (update) =>
          update.sessionId === other.sessionId &&
          update.update.sessionUpdate === "config_option_update" &&
          update.update.configOptions.some(
            (option) =>
              option.id === "mode" && option.currentValue === winningMode,
          ),
      ),
    ),
  );
  await bridgeClient.close();
  await bridgePeer.close();
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
  assert(
    !client.updates
      .slice(offsets[0])
      .some((item) => item.sessionId === sessionId),
  );
  assert(
    !observer.updates
      .slice(offsets[1])
      .some((item) => item.sessionId === sessionId),
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
  const closed = structuredClone(config);
  closed.revision++;
  closed.agents[0].accepting_runs = false;
  delete closed.agents[0].runtime.credential;
  delete closed.agents[0].runtime.connection_id;
  await publish(closed);
  verifyPrivateFiles(await privateFiles(), true);
  await observer.notify("session/cancel", { sessionId });
  assert.deepEqual(await active, { stopReason: "cancelled" });
  assert.equal(toolCalls, 1);
  const unknown = await pool.query(
    "SELECT state, tool_effect_state FROM runs WHERE error_class = 'cancelled_tool_outcome_unknown'",
  );
  assert.deepEqual(unknown.rows, [
    { state: "unresolved", tool_effect_state: "unknown" },
  ]);
  await assert.rejects(
    prompt(sessionId, "closed-must-not-start"),
    (error) => error.data?.code === "agent_unavailable",
  );
  runtimeChecks++;
  config.revision = closed.revision + 1;
  await publish();
  await assert.rejects(
    prompt(sessionId, "must-remain-protected"),
    (error) => error.data?.code === "runtime_barrier_required",
  );
  assert.equal(toolCalls, 1);
  await assertPublicStorage();
  assert(
    runtimeRequests.length > 0,
    "No authenticated official MCP request reached the peer",
  );
  runtimeChecks++;
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0008_refused_context.sql'",
      )
    ).rows[0].n,
    1,
  );
  // The unresolved Run keeps its original authority until the owning process
  // closes. Normal shutdown must still delete those volatile sender files.
  for (const connection of connections) connection.close();
  await Promise.allSettled(connections.map((connection) => connection.closed));
  toolRelease.resolve();
  const beforeShutdown = verifyPrivateFiles(await privateFiles(), true);
  await docker(["stop", "--time", "10", service]);
  await docker(["start", service]);
  origin = `http://127.0.0.1:${await hostPort(service, 8080)}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/status`, { signal: stop.signal })).ok;
    } catch {
      return false;
    }
  });
  assert.notEqual(
    verifyPrivateFiles(await privateFiles(), false),
    beforeShutdown,
  );
  runtimeChecks++;
  result = {
    status: "passed",
    image,
    scenarios: [
      "session-metadata-observers-list-fork-and-process-restart",
      "refusal-context-with-retained-transcript",
      "close-all-observers-and-reload",
      "cancel-unknown-tool-with-runtime-protection",
      "concurrent-conditional-session-configuration-has-one-winner",
    ],
    modelRequests: modelRequests.length,
    toolCalls,
    authenticationChecks,
    providerChecks: provider.checks,
    runtimeChecks,
    runtimeRequests: runtimeRequests.length,
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
      await Promise.allSettled(
        connections.map((connection) => connection.closed),
      );
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
  rmSync(credentials, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failures.length)
  throw new AggregateError(failures, "Docker SDK regression or cleanup failed");
console.log(JSON.stringify({ ...result, cleanup: "completed" }));
