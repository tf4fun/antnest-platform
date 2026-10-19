import assert from "node:assert/strict";
import { inspect } from "node:util";
import * as v1 from "@agentclientprotocol/sdk";
import { createPrivateACPHTTP } from "../identity-closeout/private-acp-http.mjs";
import { observeStream } from "../acp-commands/transport.mjs";
import { requestWithin } from "../acp-closeout/connection.mjs";
import { assertV1Completion } from "./stage2-protocol.mjs";

function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Stage2 HTTP request, archive or cleanup failed",
    );
}

async function openTransport(agentId, browser, options) {
  const { secrets, service, principal, telemetry, signal } = options;
  assert(Array.isArray(secrets));
  assert(typeof browser.accessToken === "string" && browser.accessToken);
  secrets.push(browser.accessToken);
  const observed = [],
    rawFrames = [],
    updates = [],
    closed = new AbortController();
  const http = createPrivateACPHTTP(options.endpoint, {
    telemetry,
    signal,
    async headersFor({ method, signal: requestSignal }) {
      requestSignal.throwIfAborted();
      // dispatch appends this original receipt immediately before calling us.
      // Capture its index now, before another request can enter authorization.
      const receipt = http.snapshot().requests.at(-1);
      assert.equal(receipt.method, method);
      const issued = await service.workspaceContext(
        browser.accessToken,
        agentId,
        {
          signal: requestSignal,
          httpRequest: { index: receipt.index, method },
        },
      );
      secrets.push(issued.context);
      requestSignal.throwIfAborted();
      for (const key of ["organization_id", "user_id"])
        assert.equal(
          issued.principal?.[key],
          principal[key],
          "Stage2 HTTP authority changed",
        );
      const authorization = service.authorization("agent-ui-acp");
      const grant = authorization["Antnest-Service-Authorization"];
      assert(typeof grant === "string" && grant.startsWith("Bearer "));
      secrets.push(grant, grant.slice(7));
      return { ...authorization, "Antnest-Caller-Context": issued.context };
    },
  });
  const connection = v1
    .client()
    .onNotification(v1.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(v1.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(observeStream(http.stream, observed, rawFrames));
  http.bindConnection(connection);
  void connection.closed.then(() =>
    closed.abort(new Error("Stage2 HTTP connection closed")),
  );
  const close = () => {
    void http.closeAndWait().catch(() => {});
  };
  const transport = {
    updates,
    rawFrames,
    httpSnapshot: http.snapshot,
    closeAndWait: http.closeAndWait,
    async request(name, params, timeout) {
      const offset = observed.length;
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
      } finally {
        const sent = observed.slice(offset);
        if (sent.length) {
          assert.equal(sent.length, 1, "Stage2 HTTP wire request overlap");
          const receipts = http
            .snapshot()
            .requests.filter(
              (row) =>
                row.method === "POST" &&
                String(row.requestID) === sent[0].requestId,
            );
          assert.equal(
            receipts.length,
            1,
            "Stage2 HTTP original POST receipt missing",
          );
          const receipt = receipts[0];
          transport.lastRequest = {
            ...sent[0],
            boundary: "private-acp",
            agentId,
            protocolVersion: 1,
            transport: "http",
            inputSessionID: sent[0].sessionId ?? null,
            traceID: receipt.traceID,
            clientSpanID: receipt.clientSpanID,
            httpRequestIndex: receipt.index,
            connectionID: receipt.connectionID,
          };
        }
      }
    },
  };
  try {
    transport.initializationResult = await connection.agent.request(
      v1.methods.agent.initialize,
      { protocolVersion: v1.PROTOCOL_VERSION, clientCapabilities: {} },
    );
    signal?.throwIfAborted();
    http.completeInitialization();
    return transport;
  } catch (error) {
    const failures = [error];
    try {
      await http.closeAndWait();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    fail(failures);
  }
}

export async function openStage2HTTP(agentId, browser, options) {
  assert.equal(typeof options.preserve, "function");
  const transport = await openTransport(agentId, browser, options);
  const records = [],
    errors = [],
    claimed = new Set(),
    pending = new Set();
  let closing,
    closed = false,
    active = false,
    archiving = Promise.resolve();
  const snapshot = () =>
    structuredClone({
      agentId,
      version: 1,
      transport: "http",
      closed,
      initializationResult: transport.initializationResult,
      evidence: records,
      updates: transport.updates,
      raw_frames: transport.rawFrames,
      http: transport.httpSnapshot(),
      evidence_errors: errors.map((error) => inspect(error, { depth: 8 })),
    });
  function archive() {
    const value = snapshot();
    const task = archiving.then(() => options.preserve(value));
    archiving = task.catch((error) => errors.push(error));
    return task;
  }
  function track(task) {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  const client = Object.create(transport);
  client.snapshot = snapshot;
  client.request = (name, params, timeout = 30000) => {
    if (closing || options.signal?.aborted)
      return Promise.reject(
        options.signal?.reason ?? new Error("Stage2 HTTP is closing"),
      );
    if (active) return Promise.reject(new Error("Stage2 HTTP request overlap"));
    assert(["new", "list", "load", "prompt"].includes(name));
    active = true;
    const row = {
      method: "session/" + name,
      requestParams: structuredClone(params),
    };
    records.push(row);
    return track(
      (async () => {
        const failures = [];
        let result;
        try {
          result = await transport.request(name, row.requestParams, timeout);
          row.outcome = "succeeded";
          row.requestResult = structuredClone(result);
        } catch (error) {
          failures.push(error);
          row.outcome = "failed";
          row.failure = inspect(error, { depth: 8 });
          if (
            typeof error?.code === "number" &&
            typeof error.data?.code === "string" &&
            typeof error.data?.retryable === "boolean"
          )
            row.rejectionReceipt = {
              rpcCode: error.code,
              code: error.data.code,
              retryable: error.data.retryable,
            };
        }
        try {
          const actual = transport.lastRequest;
          assert.equal(actual?.method, row.method);
          assert.equal(actual.inputSessionID, params.sessionId ?? null);
          assert(
            !claimed.has(actual.requestId),
            "duplicate Stage2 HTTP wire ID",
          );
          claimed.add(actual.requestId);
          Object.assign(row, structuredClone(actual));
          row.sessionId = params.sessionId ?? result?.sessionId;
        } catch (error) {
          errors.push(error);
          failures.push(error);
        }
        try {
          await archive();
        } catch (error) {
          failures.push(error);
        }
        active = false;
        fail(failures);
        return result;
      })(),
    );
  };
  client.prompt = () =>
    track(
      (async () => {
        const { sessionId } = await client.request("new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        const start = transport.updates.length;
        const index = records.length;
        const result = await client.request("prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "Create the Stage 2 acceptance evidence file.",
            },
          ],
        });
        const events = transport.updates
          .slice(start)
          .filter((item) => item.sessionId === sessionId)
          .map((item) => item.update);
        assertV1Completion(result, events);
        records[index].completion = structuredClone({ result, events });
        await archive();
        return {
          session_id: sessionId,
          message: "Stage 2 Runtime Tool execution completed.",
        };
      })(),
    );
  client.closeAndWait = () => {
    if (!closing)
      closing = (async () => {
        const failures = [];
        try {
          await transport.closeAndWait();
          closed = true;
        } catch (error) {
          failures.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          await archive();
        } catch (error) {
          failures.push(error);
        }
        fail([...failures, ...errors]);
        return snapshot();
      })();
    void closing.catch(() => {});
    return closing;
  };
  client.close = client.closeAndWait;
  try {
    await archive();
    return client;
  } catch (error) {
    const failures = [error];
    try {
      await client.closeAndWait();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    fail(failures);
  }
}
