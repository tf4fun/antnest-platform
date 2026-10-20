import assert from "node:assert/strict";
import * as acp from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { createHttpStream } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/http-stream.js";

// Real production receiver and official SDK. Hold the client's automatic
// DELETE before sending it, so a prior server close cannot be hidden by timing.
export async function remoteCloseReceipt({
  origin,
  headersFor,
  claims,
  configuration,
  publish,
  sessionId,
  snapshot,
  signal,
}) {
  const stop = new AbortController();
  const deadline = setTimeout(
    () => stop.abort(new Error("Remote close receipt deadline")),
    20_000,
  );
  const lifetime = AbortSignal.any([signal, stop.signal]);
  const ready = Promise.withResolvers();
  const deleting = Promise.withResolvers();
  const releaseDelete = Promise.withResolvers();
  const deleted = Promise.withResolvers();
  void deleted.promise.catch(() => undefined);
  const pending = new Set();
  let connectionId;
  let deleteCount = 0;
  function track(operation) {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  // SQL/publication operations must finish before cleanup can reuse their
  // resources. Cancellation still prevents the next operation or a pass.
  async function complete(operation) {
    lifetime.throwIfAborted();
    const result = await operation();
    lifetime.throwIfAborted();
    return result;
  }
  async function wait(operation) {
    lifetime.throwIfAborted();
    const aborted = Promise.withResolvers();
    const onAbort = () => aborted.reject(lifetime.reason);
    lifetime.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([operation, aborted.promise]);
      lifetime.throwIfAborted();
      return result;
    } finally {
      lifetime.removeEventListener("abort", onAbort);
    }
  }
  function trackBody(response, signal) {
    if (!response.body) return response;
    const body = new TransformStream();
    track(response.body.pipeTo(body.writable, { signal }));
    return new Response(body.readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const transport = createHttpStream(`${origin}/v1/acp`, {
    headers: headersFor(claims),
    fetch: (input, init) => {
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const requestHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const inputSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const sent = (async () => {
        if (method === "DELETE") {
          deleteCount++;
          assert.equal(requestHeaders.get("acp-connection-id"), connectionId);
          deleting.resolve();
          await wait(releaseDelete.promise);
        }
        const requestSignal = AbortSignal.any([
          lifetime,
          ...(inputSignal ? [inputSignal] : []),
        ]);
        const response = trackBody(
          await fetch(input, { ...init, signal: requestSignal }),
          requestSignal,
        );
        if (method === "POST" && response.status === 200)
          connectionId ??= response.headers.get("acp-connection-id");
        if (
          method === "GET" &&
          !requestHeaders.has("acp-session-id") &&
          response.status === 200
        )
          ready.resolve();
        if (method === "DELETE") {
          const body = await response.text();
          deleted.resolve({ status: response.status, body });
          return new Response(body || null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      })();
      if (method === "DELETE") void sent.catch(deleted.reject);
      return track(sent);
    },
  });
  // Public stream pumps join in-flight SDK writes, including initialization
  // that discovers its connection ID and schedules DELETE during cancellation.
  const incoming = new TransformStream();
  const outgoing = new TransformStream();
  const pumps = [
    track(transport.readable.pipeTo(incoming.writable, { signal: lifetime })),
    track(outgoing.readable.pipeTo(transport.writable, { signal: lifetime })),
  ];
  const connection = acp.client().connect({
    readable: incoming.readable,
    writable: outgoing.writable,
  });
  async function probe(
    method,
    status,
    overrides = {},
    body,
    id = connectionId,
  ) {
    lifetime.throwIfAborted();
    const response = await fetch(`${origin}/v1/acp`, {
      method,
      headers: {
        ...headersFor({ ...claims, ...overrides }),
        "Acp-Connection-Id": id,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      ...(body === undefined ? {} : { body }),
      signal: lifetime,
    });
    await response.arrayBuffer();
    lifetime.throwIfAborted();
    assert.equal(
      response.status,
      status,
      "Retired connection admission changed",
    );
  }
  let result;
  try {
    await wait(
      track(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: { session: { notices: {} } },
        }),
      ),
    );
    assert.equal(typeof connectionId, "string");
    assert(connectionId.length > 0);
    await wait(
      track(
        connection.agent.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/workspace",
          mcpServers: [],
        }),
      ),
    );
    await wait(ready.promise);
    const before = await complete(snapshot);
    assert(before.sessions.length > 0 && before.runs.length > 0);
    const revoked = structuredClone(configuration);
    revoked.revision++;
    revoked.agents.find(
      (agent) => agent.agent_id === claims.agt,
    ).principal_ids = [];
    await complete(() => publish(revoked));
    await wait(deleting.promise);
    await wait(connection.closed);
    assert(
      connection.signal.aborted,
      "Server revocation did not close the SDK connection",
    );
    for (const field of ["org", "sub", "agt"])
      await probe("DELETE", 403, { [field]: "another-scope" });
    await probe("GET", 404);
    await probe(
      "POST",
      404,
      {},
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/list",
        params: {},
      }),
    );
    await probe("DELETE", 400, {}, "{}");
    await probe("DELETE", 404, {}, undefined, "unknown-connection");
    assert.deepEqual(
      await complete(snapshot),
      before,
      "Revocation changed persisted Sessions or Runs",
    );
    releaseDelete.resolve();
    assert.deepEqual(await wait(deleted.promise), { status: 202, body: "" });
    assert.equal(
      deleteCount,
      1,
      "SDK cleanup issued duplicate DELETE requests",
    );
    await probe("DELETE", 404);
    assert.deepEqual(
      await complete(snapshot),
      before,
      "Transport cleanup changed persisted Sessions or Runs",
    );
    configuration.revision = revoked.revision + 1;
    await complete(() => publish(configuration));
    assert.deepEqual(
      await complete(snapshot),
      before,
      "Access restoration changed persisted Sessions or Runs",
    );
    lifetime.throwIfAborted();
    result = {
      trigger: "execution-publication-access-revocation",
      serverClosedBeforeDelete: true,
      automaticDelete: {
        count: deleteCount,
        status: 202,
        completeEmptyBody: true,
      },
      foreignBindingsRejected: 3,
      retiredGetPostRejected: true,
      invalidBodyRejectedWithoutConsumingReceipt: true,
      unknownAndAcknowledgedIdsRejected: true,
      sessionsAndRunsUnchanged: true,
    };
  } finally {
    clearTimeout(deadline);
    releaseDelete.resolve();
    stop.abort(new Error("Remote close receipt fixture finished"));
    connection.close();
    await connection.closed;
    await Promise.allSettled(pumps);
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }
  // The caller may cancel while the final cleanup is joining. Our own stop
  // signal is always aborted above, so only the caller decides this last check.
  signal.throwIfAborted();
  return result;
}
