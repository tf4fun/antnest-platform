import assert from "node:assert/strict";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";

function fail(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Stage3 request, evidence or cleanup failed",
    );
}

// The business inventory keeps its original 29/34 rows. This owning connection
// inventory additionally retains every initialize and both Logout session/new.
export async function openStage3Connection(profile, agentId, browser, options) {
  const transport = await openPrivateCommandConnection(
    profile,
    agentId,
    browser,
    {
      ...options,
      captureRawFrames: true,
    },
  );
  const client = Object.create(transport),
    records = [],
    pending = new Set();
  const preserve = options.preserve;
  let closing,
    closed = false;
  client.records = records;
  client.snapshot = () =>
    structuredClone({
      version: profile.version,
      agent_id: agentId,
      transport: transport.transport,
      initialization: client.initializationRequest,
      evidence: records,
      raw_frames: transport.rawFrames,
      closed,
      ...(profile.http
        ? { http_connection: transport.httpSnapshot() }
        : {
            connection_trace_id: transport.connectionTraceID,
            client_span_id: transport.clientSpanID,
            requests: transport.requests,
          }),
    });
  const save = async () => {
    await preserve(client.snapshot());
  };
  client.closeAndWait = () => {
    if (!closing)
      closing = (async () => {
        const errors = [];
        try {
          await transport.closeAndWait();
          closed = true;
        } catch (error) {
          errors.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          if (profile.http) {
            const snapshot = transport.httpSnapshot();
            for (const row of [client.initializationRequest, ...records])
              row.httpConnection = snapshot;
          }
          await save();
        } catch (error) {
          errors.push(error);
        }
        fail(errors);
      })();
    void closing.catch(() => {});
    return closing;
  };
  client.close = client.closeAndWait;
  client.request = (name, params, timeout) => {
    if (closing)
      return Promise.reject(new Error("Stage3 connection is closing"));
    if (pending.size)
      return Promise.reject(new Error("Stage3 request overlap"));
    const task = request(name, structuredClone(params), timeout);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  async function request(name, params, timeout) {
    const previous = transport.lastRequest,
      errors = [];
    let result,
      succeeded = false;
    try {
      result = await transport.request(name, params, timeout);
      succeeded = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      if (transport.lastRequest && transport.lastRequest !== previous) {
        client.lastRequest = {
          ...transport.lastRequest,
          sessionId:
            name === "new" && succeeded ? result.sessionId : params.sessionId,
          kind: "request",
          label: profile.name + ":" + name,
          outcome: succeeded ? "succeeded" : "failed",
          ...(succeeded
            ? {
                requestReceipt: structuredClone({
                  requestId: transport.lastRequest.requestId,
                  params,
                  result,
                }),
              }
            : {}),
        };
        records.push(client.lastRequest);
      }
      await save();
    } catch (error) {
      errors.push(error);
    }
    fail(errors);
    return result;
  }
  try {
    assert.equal(
      typeof preserve,
      "function",
      "durable Stage3 connection archive required",
    );
    let actual;
    if (profile.http) {
      const posts = transport
        .httpSnapshot()
        .requests.filter((row) => row.method === "POST");
      assert.equal(posts.length, 1);
      const row = posts[0];
      actual = {
        method: row.rpcMethod,
        requestId: String(row.requestID),
        traceID: row.traceID,
        clientSpanID: row.clientSpanID,
        httpRequestIndex: row.index,
        connectionID: row.connectionID,
      };
    } else {
      assert.equal(transport.requests.length, 1);
      actual = {
        ...transport.requests[0],
        connectionTraceID: transport.connectionTraceID,
        clientSpanID: transport.clientSpanID,
      };
    }
    assert.equal(actual.method, "initialize");
    client.initializationRequest = {
      ...actual,
      boundary: "private-acp",
      version: profile.version,
      protocolVersion: profile.version,
      agentId,
      transport: transport.transport,
      inputSessionID: null,
      kind: "request",
      outcome: "succeeded",
      label: profile.name + ":initialize",
      initializationResult: structuredClone(transport.initializationResult),
    };
    await save();
    return client;
  } catch (error) {
    return withPrivateCommandConnection(client, [], async () => {
      throw error;
    });
  }
}
