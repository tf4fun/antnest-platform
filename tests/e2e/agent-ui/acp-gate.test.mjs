import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAcpGate } from "./acp-gate.mjs";

test("ACP gate withholds only the selected Prompt and forwards the rest", async () => {
  const seen = [];
  const upstream = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(202).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = createAcpGate(`http://127.0.0.1:${upstream.address().port}`);
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  const origin = `http://127.0.0.1:${gate.address().port}`;
  const prompt = (intentId) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { _meta: { "antnest.dev/intent": { intentId } } },
    });
  try {
    assert.equal(
      (
        await fetch(`${origin}/__fault/arm`, {
          method: "POST",
          body: JSON.stringify({ intentId: "held" }),
        })
      ).status,
      200,
    );
    const interrupted = new AbortController();
    const blocked = fetch(origin, {
      method: "POST",
      body: prompt("held"),
      signal: interrupted.signal,
    }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(`${origin}/__fault/state`)).json();
      if (state.heldIntent === "held") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      (await (await fetch(`${origin}/__fault/state`)).json()).heldIntent,
      "held",
    );
    assert.equal(seen.length, 0);
    assert.equal(
      (await fetch(origin, { method: "POST", body: prompt("other") })).status,
      202,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params._meta["antnest.dev/intent"].intentId, "other");
    interrupted.abort();
    await blocked;
    await fetch(`${origin}/__fault/disarm`, { method: "POST" });
    assert.equal(
      (await fetch(origin, { method: "POST", body: prompt("held") })).status,
      202,
    );
    assert.equal(seen.length, 2);
    const stream = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
    assert.equal(
      stream.status,
      200,
      "SSE headers must reach the Bridge before the first event",
    );
    await stream.body.cancel();
  } finally {
    gate.closeAllConnections();
    gate.close();
    upstream.closeAllConnections();
    upstream.close();
    await Promise.all([once(gate, "close"), once(upstream, "close")]);
  }
});

test("ACP gate closes downstream SSE when the producer dies", async () => {
  let producerStream;
  const upstream = createServer((_request, response) => {
    producerStream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = createAcpGate(`http://127.0.0.1:${upstream.address().port}`);
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  try {
    const stream = await fetch(`http://127.0.0.1:${gate.address().port}`);
    assert.equal(stream.status, 200);
    producerStream.destroy();
    await Promise.race([
      stream.body
        .getReader()
        .read()
        .catch(() => undefined),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE producer close was hidden")),
          500,
        ),
      ),
    ]);
  } finally {
    gate.closeAllConnections();
    gate.close();
    upstream.closeAllConnections();
    upstream.close();
    await Promise.all([once(gate, "close"), once(upstream, "close")]);
  }
});

function promptBody(intentId) {
  return ` \n${JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: {
      sessionId: "capture-session",
      prompt: [{ type: "text", text: "unchanged request" }],
      _meta: { "antnest.dev/intent": { intentId } },
    },
  })}\r\n`;
}

const jsonBody = (response) => JSON.parse(response.body.toString("utf8"));
const capturedBody = (record) =>
  Buffer.concat(
    record.response.chunks.map((chunk) => Buffer.from(chunk, "base64")),
  );

async function withCapturedGate(t, handler, action, options = {}) {
  const owner = new AbortController();
  const deadline = setTimeout(
    () => owner.abort(new Error("ACP capture fixture deadline exceeded")),
    5_000,
  );
  const pending = [],
    producerWork = [];
  const upstream = createServer((request, response) => {
    const work = Promise.resolve().then(() => handler(request, response));
    producerWork.push(work);
    void work.catch((error) => response.destroy(error));
  });
  let gate, failure;
  const close = (server) =>
    !server?.listening
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    gate = createAcpGate(`http://127.0.0.1:${upstream.address().port}`, {
      capture: true,
      maxCaptureBytes: 1_048_576,
      ...options,
    });
    gate.listen(0, "127.0.0.1");
    await once(gate, "listening");
    const origin = `http://127.0.0.1:${gate.address().port}`;
    const start = (path, init = {}) => {
      const requestOwner = new AbortController();
      const work = (async () => {
        const response = await fetch(`${origin}${path}`, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            owner.signal,
            requestOwner.signal,
            t.signal,
            ...(init.signal ? [init.signal] : []),
          ]),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: Buffer.from(await response.arrayBuffer()),
        };
      })();
      pending.push(work);
      void work.catch(() => undefined);
      return { promise: work, abort: () => requestOwner.abort() };
    };
    const request = (path, init) => start(path, init).promise;
    const state = async () => {
      const response = await request("/__fault/state");
      assert.equal(response.status, 200);
      const value = jsonBody(response);
      assert.equal(typeof value.heldRequests, "number");
      assert(
        value.forwardedByIntent && typeof value.forwardedByIntent === "object",
      );
      assert(Array.isArray(value.records));
      assert(Array.isArray(value.captureErrors));
      return value;
    };
    const until = async (predicate) => {
      for (;;) {
        owner.signal.throwIfAborted();
        t.signal.throwIfAborted();
        const value = await state();
        if (predicate(value)) return value;
      }
    };
    await action({ start, request, state, until });
  } catch (error) {
    failure = error;
  } finally {
    owner.abort();
    const closing = [close(gate), close(upstream)];
    await Promise.allSettled(pending);
    const closed = await Promise.allSettled(closing);
    const producers = await Promise.allSettled(producerWork);
    clearTimeout(deadline);
    const errors = [
      ...(failure ? [failure] : []),
      ...[...closed, ...producers]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    ];
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "ACP capture fixture failed");
  }
}

test(
  "ACP capture releases the original held request exactly once",
  { timeout: 10_000 },
  async (t) => {
    const seen = [];
    const body = promptBody("release-once");
    const reply = Buffer.from(' \n{ "accepted": "released 原件" }\r\n');
    await withCapturedGate(
      t,
      async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        seen.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks),
        });
        response.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(reply);
      },
      async ({ start, request, until, state }) => {
        const armed = await request("/__fault/arm", {
          method: "POST",
          body: JSON.stringify({ intentId: "release-once" }),
        });
        assert.equal(armed.status, 200);
        const held = start("/rpc/agent-acp/v1?case=release", {
          method: "POST",
          body,
        });
        const before = await until(
          (value) => value.heldIntent === "release-once",
        );
        assert.equal(before.armedIntent, "release-once");
        assert.equal(before.heldRequests, 1);
        assert.equal(before.forwardedPrompts, 0);
        assert.equal(before.records.length, 1);
        assert.equal(before.records[0].forwarded, false);
        assert.equal(before.records[0].response, null);
        assert.deepEqual(seen, []);
        const released = await request("/__fault/release", {
          method: "POST",
          body: JSON.stringify({ intentId: "release-once" }),
        });
        assert.equal(released.status, 200);
        assert.deepEqual(jsonBody(released), { released: 1 });
        const actual = await held.promise;
        assert.equal(actual.status, 201);
        assert.deepEqual(actual.body, reply);
        const duplicate = await request("/__fault/release", {
          method: "POST",
          body: JSON.stringify({ intentId: "release-once" }),
        });
        assert.equal(duplicate.status, 409);
        assert.deepEqual(jsonBody(duplicate), { released: 0 });
        const final = await until(
          (value) => value.records[0]?.response?.closed,
        );
        assert.equal(final.heldRequests, 0);
        assert.equal(final.forwardedPrompts, 1);
        assert.deepEqual(final.forwardedByIntent, { "release-once": 1 });
        assert.deepEqual(final.captureErrors, []);
        assert.equal(final.records.length, 1);
        const record = final.records[0];
        assert.equal(record.method, "POST");
        assert.equal(record.path, "/rpc/agent-acp/v1?case=release");
        assert.equal(record.body, body);
        assert.equal(record.forwarded, true);
        assert.equal(record.response.statusCode, 201);
        assert.equal(record.response.contentType, actual.contentType);
        assert.equal(record.response.complete, true);
        assert.deepEqual(capturedBody(record), reply);
        assert.deepEqual(seen, [
          { method: "POST", path: record.path, body: Buffer.from(body) },
        ]);
        assert.equal((await state()).forwardedPrompts, 1);
      },
    );
  },
);

test(
  "ACP capture never releases a held request after its client aborts",
  { timeout: 10_000 },
  async (t) => {
    const seen = [];
    await withCapturedGate(
      t,
      async (request, response) => {
        for await (const _chunk of request) {
          /* Consume any incorrectly forwarded request. */
        }
        seen.push(request.url);
        response.writeHead(202).end();
      },
      async ({ start, request, until }) => {
        await request("/__fault/arm", {
          method: "POST",
          body: JSON.stringify({ intentId: "aborted-held" }),
        });
        const held = start("/rpc/agent-acp/v1", {
          method: "POST",
          body: promptBody("aborted-held"),
        });
        await until((value) => value.heldRequests === 1);
        held.abort();
        await assert.rejects(
          held.promise,
          (error) => error.name === "AbortError",
        );
        await until((value) => value.heldRequests === 0);
        const released = await request("/__fault/release", {
          method: "POST",
          body: JSON.stringify({ intentId: "aborted-held" }),
        });
        assert.equal(released.status, 409);
        assert.deepEqual(jsonBody(released), { released: 0 });
        const final = await until((value) => value.heldRequests === 0);
        assert.equal(final.forwardedPrompts, 0);
        assert.equal(final.forwardedByIntent["aborted-held"] ?? 0, 0);
        assert.equal(final.records.length, 1);
        assert.equal(final.records[0].forwarded, false);
        assert.equal(final.records[0].response, null);
        assert.deepEqual(seen, []);
      },
    );
  },
);

test(
  "ACP capture mirrors the real JSON rejection without recording authorization headers",
  { timeout: 10_000 },
  async (t) => {
    const secret = "private-authorization-header-canary";
    const body = promptBody("json-rejection");
    const reply = Buffer.from(
      ' \n{"jsonrpc":"2.0","id":7,"error":{"code":-32030,"message":"Agent already has an active Run","data":{"code":"agent_busy","retryable":true,"retry_after_ms":1000}}}\n',
    );
    await withCapturedGate(
      t,
      async (request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        assert.equal(
          request.headers["antnest-service-authorization"],
          `Bearer ${secret}`,
        );
        assert.equal(request.headers["antnest-caller-context"], secret);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString("utf8"), body);
        response.writeHead(409, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(reply);
      },
      async ({ request, until }) => {
        const actual = await request("/rpc/agent-acp/v1", {
          method: "POST",
          body,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Antnest-Service-Authorization": `Bearer ${secret}`,
            "Antnest-Caller-Context": secret,
          },
        });
        assert.equal(actual.status, 409);
        assert.deepEqual(actual.body, reply);
        const final = await until(
          (value) => value.records[0]?.response?.closed,
        );
        assert.deepEqual(final.captureErrors, []);
        assert.deepEqual(final.forwardedByIntent, { "json-rejection": 1 });
        assert.equal(final.records.length, 1);
        const record = final.records[0];
        assert.deepEqual(Object.keys(record).sort(), [
          "body",
          "forwarded",
          "method",
          "path",
          "response",
        ]);
        assert.equal(record.body, body);
        assert.equal(record.response.statusCode, 409);
        assert.equal(record.response.contentType, actual.contentType);
        assert.equal(record.response.complete, true);
        assert.deepEqual(capturedBody(record), reply);
        assert(!JSON.stringify(final).includes(secret));
        assert(!JSON.stringify(record).toLowerCase().includes("authorization"));
      },
    );
  },
);

test(
  "ACP capture preserves the exact SSE bytes and a bodyless request",
  { timeout: 10_000 },
  async (t) => {
    const secret = "private-sse-authorization-canary";
    const first = Buffer.from(
      ': original heartbeat\r\nid: 1\r\ndata: {"text":"原始 event"}\r\n\r\n',
    );
    const second = Buffer.from('event: message\ndata: {"done":true}\n\n');
    const reply = Buffer.concat([first, second]);
    await withCapturedGate(
      t,
      async (request, response) => {
        assert.equal(
          request.headers["antnest-service-authorization"],
          `Bearer ${secret}`,
        );
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.flushHeaders();
        response.write(first);
        await new Promise((resolve) => setImmediate(resolve));
        response.end(second);
      },
      async ({ request, until }) => {
        const actual = await request("/rpc/agent-acp/v1?stream=original", {
          headers: { "Antnest-Service-Authorization": `Bearer ${secret}` },
        });
        assert.equal(actual.status, 200);
        assert.deepEqual(actual.body, reply);
        const final = await until(
          (value) => value.records[0]?.response?.closed,
        );
        assert.deepEqual(final.captureErrors, []);
        assert.equal(final.records.length, 1);
        const record = final.records[0];
        assert.equal(record.method, "GET");
        assert.equal(record.path, "/rpc/agent-acp/v1?stream=original");
        assert.equal(record.body, null);
        assert.equal(record.forwarded, true);
        assert.equal(record.response.statusCode, 200);
        assert.equal(record.response.contentType, actual.contentType);
        assert.equal(record.response.complete, true);
        assert.deepEqual(capturedBody(record), reply);
        assert(!JSON.stringify(final).includes(secret));
      },
    );
  },
);

test(
  "ACP capture stops accumulating at its budget while forwarding the full original body",
  { timeout: 10_000 },
  async (t) => {
    const limit = 256;
    const body = `${promptBody("capture-limit").trimEnd()}${" ".repeat(2_048)}\n`;
    const reply = Buffer.from(`original-response:${"x".repeat(4_096)}\n`);
    const seen = [];
    await withCapturedGate(
      t,
      async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        seen.push(Buffer.concat(chunks));
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(reply);
      },
      async ({ request, until }) => {
        const actual = await request("/rpc/agent-acp/v1?case=bounded", {
          method: "POST",
          body,
        });
        assert.equal(actual.status, 200);
        assert.deepEqual(actual.body, reply);
        assert.deepEqual(seen, [Buffer.from(body)]);
        const final = await until(
          (value) => value.records[0]?.response?.closed,
        );
        assert(
          final.captureErrors.length > 0,
          "truncated capture must retain an error",
        );
        assert.equal(final.forwardedPrompts, 1);
        assert.deepEqual(final.forwardedByIntent, { "capture-limit": 1 });
        assert.equal(final.records.length, 1);
        assert.equal(final.records[0].forwarded, true);
        assert.equal(final.records[0].response.statusCode, 200);
        assert.equal(
          final.records[0].response.complete,
          false,
          "truncated wire is not complete evidence",
        );
        const bytes = final.records.reduce(
          (total, record) =>
            total +
            (record.body === null
              ? 0
              : Buffer.byteLength(record.body, "utf8")) +
            (record.response?.chunks ?? []).reduce(
              (size, chunk) => size + Buffer.from(chunk, "base64").length,
              0,
            ),
          0,
        );
        assert(bytes <= limit, "capture accumulation exceeded maxCaptureBytes");
        const later = await request("/rpc/agent-acp/v1?case=after-limit", {
          method: "POST",
          body,
        });
        assert.equal(later.status, 200);
        assert.deepEqual(later.body, reply);
        const after = await until(
          (value) =>
            value.records.length === 2 && value.records[1]?.response?.closed,
        );
        const afterBytes = after.records.reduce(
          (total, record) =>
            total +
            (record.body === null
              ? 0
              : Buffer.byteLength(record.body, "utf8")) +
            (record.response?.chunks ?? []).reduce(
              (size, chunk) => size + Buffer.from(chunk, "base64").length,
              0,
            ),
          0,
        );
        assert(
          afterBytes <= limit,
          "later exchanges must not restart a depleted capture budget",
        );
        assert.equal(after.forwardedPrompts, 2);
        assert.deepEqual(seen, [Buffer.from(body), Buffer.from(body)]);
      },
      { maxCaptureBytes: limit },
    );
  },
);
