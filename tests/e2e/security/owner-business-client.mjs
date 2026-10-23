import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { transcript } from "../acp-commands/evidence.mjs";

// The caller owns and joins this initialized connection. Cancellation checks
// follow each original operation; a losing promise is never abandoned.
export async function exerciseOwnerBusiness({
  agentId,
  client,
  readModelStatus,
  signal,
}) {
  assert.match(agentId, /^agent_[a-f0-9]{32}$/u);
  signal?.throwIfAborted();
  const { sessionId } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  signal?.throwIfAborted();
  assert.match(sessionId, /^session_[a-f0-9]{32}$/u);
  const response = await client.request(
    "prompt",
    {
      sessionId,
      prompt: [{ type: "text", text: "foreground during review" }],
    },
    90_000,
  );
  signal?.throwIfAborted();
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(
    transcript(client.updates, sessionId).filter(
      (entry) => entry.role === "assistant",
    ),
    [
      {
        role: "assistant",
        content: [{ type: "text", text: "Foreground request completed." }],
      },
    ],
  );
  const model = await readModelStatus();
  signal?.throwIfAborted();
  assert.deepEqual(model.requests, ["foreground-preempt-reply"]);
  for (const field of ["errors", "pending", "cancelled"])
    assert.deepEqual(model[field], []);
  return { status: "passed", agent_id: agentId, session_id: sessionId };
}

export async function runOwnerClientSession({
  agentId,
  browser,
  open,
  telemetry,
  withResources,
  readModelStatus,
  signal,
}) {
  const { member } = await import("../workspace-closeout/c4-setup.mjs");
  const clients = new Set();
  const errors = [];
  let loggedIn = false,
    result;
  try {
    result = await withResources(clients, telemetry, async () => {
      signal?.throwIfAborted();
      const login = await browser.request("/api/session/login", {
        body: member,
      });
      loggedIn = true;
      signal?.throwIfAborted();
      const client = await open({ version: 1 }, agentId, browser, {
        principal: login.body.principal,
        telemetry,
        secrets: [browser.accessToken, browser.cookie, browser.csrf].filter(
          Boolean,
        ),
        signal,
      });
      clients.add(client);
      return exerciseOwnerBusiness({
        agentId,
        client,
        signal,
        readModelStatus,
      });
    });
  } catch (error) {
    errors.push(error);
  } finally {
    if (loggedIn) {
      try {
        await browser.request("/api/session", {
          method: "DELETE",
          status: 204,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Owner business or connection cleanup failed",
    );
  signal?.throwIfAborted();
  return result;
}

async function main() {
  // Resolve SDKs from the selected ACP image; pure business unit tests need no
  // second dependency installation. The existing resource owner joins clients.
  const { GatewayClient } = await import("../identity-closeout/support.mjs");
  const { openPrivateCommandConnection, withPrivateCommandResources } =
    await import("../acp-commands/connection.mjs");
  const { createPrivateACPTelemetry } =
    await import("../identity-closeout/private-acp-telemetry.mjs");
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Owner business client interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 120_000);
  try {
    const result = await runOwnerClientSession({
      agentId: process.env.ANTNEST_E2E_AGENT_ID,
      browser: new GatewayClient("http://edge-gateway:8080"),
      open: openPrivateCommandConnection,
      withResources: withPrivateCommandResources,
      telemetry: createPrivateACPTelemetry("http://jaeger:4318/v1/traces"),
      signal: abort.signal,
      readModelStatus: async () => {
        const response = await fetch("http://stage3-model:8080/status", {
          redirect: "manual",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        const body = await response.text();
        assert.equal(response.status, 200);
        assert(body.length < 65536);
        return JSON.parse(body);
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
