import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { observeStream, observeFetch } from "./transport.mjs";
import { openBrowserPrivateACP } from "../identity-closeout/private-acp-browser.mjs";
import { createPrivateACPHTTP } from "../identity-closeout/private-acp-http.mjs";
import { serviceClient } from "../../support/service-grants.mjs";

const gateway = process.env.TEST_GATEWAY_URL ?? "http://edge-gateway:8080";

async function finishCommandAction(action, cleanups) {
  const errors = [];
  let result;
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Command business and resource cleanup failed",
    );
  return result;
}

// The complete original connection is the receipt owner, including requests
// whose response arrived before the HTTP ACK or notification stream closed.
export function withPrivateCommandConnection(client, records, action) {
  return finishCommandAction(action, [
    () => client.closeAndWait(),
    () => {
      if (client.transport !== "http") return;
      const snapshot = client.httpSnapshot();
      for (const record of records) record.httpConnection = snapshot;
    },
  ]);
}

export function withPrivateCommandResources(clients, telemetry, action) {
  return finishCommandAction(action, [
    async () => {
      const errors = [];
      for (const client of clients) {
        try {
          await client.closeAndWait();
        } catch (error) {
          errors.push(error);
        } finally {
          clients.delete(client);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Command connection cleanup failed");
    },
    () => telemetry.shutdown(),
  ]);
}

export function commandConnection(profile, agentId, browser) {
  const sdk = profile.version === 1 ? v1 : v2;
  const connectionTraceID = randomBytes(16).toString("hex");
  const updates = [],
    observed = [];
  const closed = new AbortController();
  const url = `${gateway}/api/app/agents/${agentId}/v${profile.version}/acp`;
  const headers = { Cookie: browser.cookie, Origin: gatewayOrigin(gateway) };
  const stream = profile.http
    ? createHttpStream(url, {
        headers: {
          ...headers,
          "X-Antnest-CSRF-Token": browser.csrf,
        },
        // Let Gateway create a fresh root; do not invent an unexported HTTP parent.
        fetch: observeFetch(fetch, observed),
      })
    : observeStream(
        createWebSocketStream(url.replace("http:", "ws:"), {
          WebSocket: observeSocket(WebSocket, closed, () => undefined),
          headers: {
            ...headers,
            traceparent: `00-${connectionTraceID}-${randomBytes(8).toString("hex")}-01`,
          },
        }),
        observed,
      );
  const connection = sdk
    .client()
    .onNotification(sdk.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(sdk.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(stream);
  const client = {
    updates,
    agentId,
    transport: profile.http ? "http" : "websocket",
    connectionTraceID,
    close: () => connection.close(),
    initialize: () =>
      request(
        sdk.methods.agent.initialize,
        profile.version === 1
          ? { protocolVersion: sdk.PROTOCOL_VERSION, clientCapabilities: {} }
          : {
              protocolVersion: sdk.PROTOCOL_VERSION,
              info: { name: "command-acceptance", version: "1" },
              capabilities: {},
            },
      ),
    request: (name, params, timeout) =>
      request(sdk.methods.agent.session[name], params, timeout),
  };
  async function request(method, params, timeout = 15000) {
    const offset = observed.length;
    try {
      return await requestWithin(
        (options) => connection.agent.request(method, params, options),
        closed.signal,
        client.close,
        timeout,
      );
    } finally {
      await until(
        () => observed.length > offset,
        "actual outgoing SDK request",
        5000,
      );
      assert.equal(
        observed.length - offset,
        1,
        "missing or duplicated outgoing SDK request",
      );
      client.lastRequest = {
        ...observed[offset],
        agentId,
        transport: client.transport,
        ...(profile.http ? {} : { connectionTraceID }),
      };
    }
  }
  return client;
}

// Opt-in owning consumer. Existing callers retain commandConnection until their
// own private/Bridge migration and integration gates have passed.
function commandRejectionReceipt(error) {
  if (
    error?.code !== -32020 ||
    typeof error.data?.retryable !== "boolean" ||
    ![
      "access_denied",
      "session_access_denied",
      "unsupported_resource_content",
      "unsupported_audio_content",
    ].includes(error.data?.code)
  )
    return undefined;
  return {
    rpcCode: error.code,
    code: error.data.code,
    retryable: error.data.retryable,
  };
}

export async function openPrivateCommandConnection(
  profile,
  agentId,
  browser,
  options = {},
) {
  assert(
    [1, 2].includes(profile.version) &&
      (!profile.http || profile.version === 1),
    "unsupported private command protocol",
  );
  assert(
    options.captureRawFrames === undefined ||
      typeof options.captureRawFrames === "boolean",
    "captureRawFrames must be a boolean",
  );
  assert(
    options.captureNotifications === undefined ||
      typeof options.captureNotifications === "boolean",
    "captureNotifications must be a boolean",
  );
  assert(
    !options.captureNotifications || !profile.http,
    "notification capture requires private WebSocket ACP",
  );
  options.signal?.throwIfAborted();
  const principal = {};
  for (const field of ["organization_id", "user_id"]) {
    assert(
      typeof options.principal?.[field] === "string" &&
        options.principal[field].length > 0,
      "original browser Principal required",
    );
    principal[field] = options.principal[field];
  }
  if (!profile.http) {
    const transport = await openBrowserPrivateACP(
      profile.version,
      agentId,
      browser,
      { ...options, principal },
    );
    const client = Object.create(transport);
    client.request = async (name, params, timeout) => {
      const offset = transport.requests.length;
      let rejectionReceipt;
      try {
        return await transport.request(name, params, timeout);
      } catch (error) {
        rejectionReceipt = commandRejectionReceipt(error);
        throw error;
      } finally {
        const observed = transport.requests.slice(offset);
        if (observed.length) {
          assert.equal(observed.length, 1, "private command request overlap");
          client.lastRequest = {
            ...observed[0],
            inputSessionID: observed[0].sessionId ?? null,
            boundary: "private-acp",
            agentId,
            version: profile.version,
            protocolVersion: profile.version,
            transport: "websocket",
            connectionTraceID: transport.connectionTraceID,
            clientSpanID: transport.clientSpanID,
            ...(rejectionReceipt ? { rejectionReceipt } : {}),
          };
        }
      }
    };
    return client;
  }

  const { telemetry, secrets, signal } = options;
  assert(Array.isArray(secrets), "private command secret inventory required");
  const accessToken = browser.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "original browser session required",
  );
  secrets.push(accessToken);
  const service = options.service ?? serviceClient();
  const transport = createPrivateACPHTTP(
    options.endpoint ?? "http://agent-acp-service:8080/v1/acp",
    {
      telemetry,
      signal,
      async headersFor({ signal: requestSignal }) {
        requestSignal.throwIfAborted();
        const issued = await service.workspaceContext(accessToken, agentId, {
          signal: requestSignal,
        });
        secrets.push(issued.context);
        requestSignal.throwIfAborted();
        for (const field of ["organization_id", "user_id"])
          assert(
            issued.principal[field] === principal[field],
            "workspace authority changed",
          );
        const authorization = service.authorization("agent-ui-acp");
        const grant = authorization["Antnest-Service-Authorization"];
        assert(
          typeof grant === "string",
          "private command workload grant required",
        );
        secrets.push(issued.context, grant, grant.slice("Bearer ".length));
        return { ...authorization, "Antnest-Caller-Context": issued.context };
      },
    },
  );
  const rawFrames = options.captureRawFrames ? [] : undefined;
  const observed = [],
    updates = [],
    closed = new AbortController();
  const connection = v1
    .client()
    .onNotification(v1.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(v1.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(observeStream(transport.stream, observed, rawFrames));
  transport.bindConnection(connection);
  void connection.closed.then(() =>
    closed.abort(new Error("private command connection closed")),
  );
  const close = () => {
    void transport.closeAndWait().catch(() => {});
  };
  const client = {
    boundary: "private-acp",
    version: 1,
    agentId,
    transport: "http",
    updates,
    ...(rawFrames ? { rawFrames } : {}),
    close,
    closeAndWait: transport.closeAndWait,
    httpSnapshot: transport.snapshot,
    async request(name, params, timeout = 15000) {
      const offset = observed.length;
      let rejectionReceipt;
      try {
        return await requestWithin(
          (requestOptions) =>
            connection.agent.request(
              v1.methods.agent.session[name],
              params,
              requestOptions,
            ),
          closed.signal,
          close,
          timeout,
        );
      } catch (error) {
        rejectionReceipt = commandRejectionReceipt(error);
        throw error;
      } finally {
        const sent = observed.slice(offset);
        if (sent.length) {
          assert.equal(sent.length, 1, "private command request overlap");
          const receipts = transport
            .snapshot()
            .requests.filter(
              (item) =>
                item.method === "POST" &&
                String(item.requestID) === sent[0].requestId,
            );
          assert.equal(
            receipts.length,
            1,
            "missing or duplicated actual HTTP request",
          );
          const receipt = receipts[0];
          client.lastRequest = {
            ...sent[0],
            inputSessionID: sent[0].sessionId ?? null,
            boundary: "private-acp",
            agentId,
            version: 1,
            protocolVersion: 1,
            transport: "http",
            traceID: receipt.traceID,
            clientSpanID: receipt.clientSpanID,
            httpRequestIndex: receipt.index,
            connectionID: receipt.connectionID,
            ...(rejectionReceipt ? { rejectionReceipt } : {}),
          };
        }
      }
    },
  };
  try {
    const initializationResult = await connection.agent.request(
      v1.methods.agent.initialize,
      {
        protocolVersion: v1.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
    );
    signal?.throwIfAborted();
    transport.completeInitialization();
    client.initializationResult = initializationResult;
    return client;
  } catch (error) {
    const original = signal?.aborted ? signal.reason : error;
    try {
      await transport.closeAndWait();
    } catch (cleanup) {
      // eslint-disable-next-line preserve-caught-error -- Both failures are retained in errors.
      throw new AggregateError(
        [original, cleanup],
        "private command initialization and cleanup failed",
      );
    }
    throw original;
  }
}
