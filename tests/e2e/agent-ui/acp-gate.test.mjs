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

const gateControl = async (options) => {
  const { createGateControl } = await import("./acp-gate-control.mjs");
  return createGateControl(options);
};
const controlReceipt = (rawBody, status = 200) =>
  JSON.stringify({ ok: true, status, rawBody });
const controlTurn = () => new Promise((resolve) => setImmediate(resolve));
async function controlStarted(started, outcome, message) {
  let timer;
  try {
    await Promise.race([
      started,
      outcome.then(() => {
        throw new Error(message);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("gate control preserves the full original JSON inventory and HTTP status", async () => {
  const inventory = {
    armedIntent: null,
    heldIntent: null,
    heldRequests: 0,
    forwardedPrompts: 96,
    forwardedByIntent: Object.fromEntries(
      Array.from({ length: 96 }, (_, index) => [`intent-${index}`, 1]),
    ),
    records: Array.from({ length: 96 }, (_, index) => ({
      method: "POST",
      path: "/rpc/agent-acp/v1",
      forwarded: true,
      body: `${index}:原始 inventory:${"x".repeat(2_048)}`,
      response: {
        chunks: [Buffer.from(`original-${index}`).toString("base64")],
        complete: true,
        closed: true,
      },
    })),
    captureErrors: [],
  };
  const rawBody = ` \n${JSON.stringify(inventory)}\r\n`;
  const scripts = [];
  const control = await gateControl({
    async exec(script) {
      scripts.push(script);
      return controlReceipt(rawBody, 409);
    },
    signal: new AbortController().signal,
  });
  let result;
  try {
    result = await control.request("state");
  } finally {
    await control.join();
  }
  assert.equal(scripts.length, 1);
  assert.equal(typeof scripts[0], "string");
  assert(scripts[0].length > 0);
  assert.deepEqual(result, { status: 409, rawBody, body: inventory });
  assert.equal(result.body.records.length, 96);
  assert.equal(result.body.records.at(-1).body, inventory.records.at(-1).body);
});

test("gate control rejects unknown actions and invalid control bodies before exec", async () => {
  let executions = 0;
  const control = await gateControl({
    async exec() {
      executions++;
      return controlReceipt("{}");
    },
    signal: new AbortController().signal,
  });
  try {
    for (const action of [
      undefined,
      null,
      {},
      "",
      "disarm",
      "STATE",
      "/state",
      "../state",
      "state?next=arm",
      "//other.invalid/state",
      "http://other.invalid/__fault/state",
      "http://127.0.0.1:8080/__fault/state",
    ])
      await assert.rejects(async () => control.request(action));
    for (const body of [
      null,
      {},
      [],
      "intent",
      { intentId: "" },
      { intentId: 7 },
      { intentId: "intent", extra: true },
    ]) {
      for (const action of ["arm", "release"])
        await assert.rejects(async () => control.request(action, { body }));
    }
    for (const action of ["arm", "release"])
      await assert.rejects(async () => control.request(action));
    for (const body of [null, {}, [], { intentId: "intent" }])
      await assert.rejects(async () => control.request("state", { body }));
  } finally {
    await control.join();
  }
  assert.equal(
    executions,
    0,
    "Invalid controls must not start Node or Docker exec",
  );
});

test("gate control pre-cancellation starts no normal exec while cleanup release and state remain available", async () => {
  const parent = new AbortController();
  parent.abort(new Error("fixture owner cancelled"));
  const scripts = [];
  const control = await gateControl({
    async exec(script) {
      scripts.push(script);
      return controlReceipt('{"released":1}');
    },
    signal: parent.signal,
  });
  let release, state;
  try {
    for (const [action, options] of [
      ["state", undefined],
      ["arm", { body: { intentId: "original" } }],
      ["release", { body: { intentId: "original" } }],
    ])
      await assert.rejects(async () => control.request(action, options));
    assert.equal(scripts.length, 0);
    release = await control.request("release", {
      body: { intentId: "original" },
      cleanup: true,
    });
    state = await control.request("state", { cleanup: true });
  } finally {
    await control.join();
  }
  assert.equal(scripts.length, 2);
  assert.deepEqual(release.body, { released: 1 });
  assert.deepEqual(state.body, { released: 1 });
});

for (const completion of ["success", "failure"]) {
  test(
    `gate control cancellation joins the original ${completion} exec before rejecting`,
    { timeout: 5_000 },
    async () => {
      const parent = new AbortController();
      const started = Promise.withResolvers();
      const execution = Promise.withResolvers();
      const control = await gateControl({
        exec() {
          started.resolve();
          return execution.promise;
        },
        signal: parent.signal,
      });
      let requestFinished = false,
        joinFinished = false;
      const pending = Promise.resolve().then(() => control.request("state"));
      const outcome = pending.then(
        (value) => {
          requestFinished = true;
          return { status: "fulfilled", value };
        },
        (reason) => {
          requestFinished = true;
          return { status: "rejected", reason };
        },
      );
      let joined, cancelledEarly, joinedEarly, result;
      try {
        await controlStarted(
          started.promise,
          outcome,
          "Control request settled before its exec started",
        );
        parent.abort(new Error("fixture cancellation during exec"));
        joined = Promise.resolve()
          .then(() => control.join())
          .then(
            () => {
              joinFinished = true;
            },
            () => {
              joinFinished = true;
            },
          );
        await controlTurn();
        cancelledEarly = requestFinished;
        joinedEarly = joinFinished;
        if (completion === "success") execution.resolve(controlReceipt("{}"));
        else
          execution.reject(new Error("fixture exec failed after cancellation"));
        result = await outcome;
        await joined;
      } finally {
        execution.resolve(controlReceipt("{}"));
        await outcome;
        await Promise.allSettled([
          joined,
          Promise.resolve().then(() => control.join()),
        ]);
      }
      assert.equal(
        cancelledEarly,
        false,
        "Parent cancellation must not abandon a running exec",
      );
      assert.equal(
        joinedEarly,
        false,
        "join must wait for the original exec to settle",
      );
      assert.equal(result.status, "rejected");
      assert.equal(requestFinished, true);
      assert.equal(joinFinished, true);
    },
  );
}

test(
  "gate control join waits for every independently owned in-flight exec",
  { timeout: 5_000 },
  async () => {
    const started = Promise.withResolvers();
    const executions = Array.from({ length: 3 }, () => Promise.withResolvers());
    let calls = 0,
      joinFinished = false;
    const control = await gateControl({
      exec() {
        const pending = executions[calls++].promise;
        if (calls === 3) started.resolve();
        return pending;
      },
      signal: new AbortController().signal,
    });
    const requests = [
      Promise.resolve().then(() => control.request("state")),
      Promise.resolve().then(() =>
        control.request("arm", { body: { intentId: "original" } }),
      ),
      Promise.resolve().then(() =>
        control.request("release", {
          body: { intentId: "original" },
          cleanup: true,
        }),
      ),
    ];
    const outcomes = Promise.allSettled(requests);
    let joined, afterOne, afterTwo, results;
    try {
      await controlStarted(
        started.promise,
        outcomes,
        "Controls did not start their independently owned execs",
      );
      joined = Promise.resolve()
        .then(() => control.join())
        .then(() => {
          joinFinished = true;
        });
      executions[0].resolve(controlReceipt("{}"));
      await controlTurn();
      afterOne = joinFinished;
      executions[1].resolve(controlReceipt("{}"));
      await controlTurn();
      afterTwo = joinFinished;
      executions[2].resolve(controlReceipt("{}"));
      results = await outcomes;
      await joined;
    } finally {
      for (const execution of executions)
        execution.resolve(controlReceipt("{}"));
      await outcomes;
      await Promise.allSettled([
        joined,
        Promise.resolve().then(() => control.join()),
      ]);
    }
    assert.equal(calls, 3);
    assert.equal(afterOne, false);
    assert.equal(afterTwo, false);
    assert.equal(joinFinished, true);
    assert(results.every((result) => result.status === "fulfilled"));
  },
);

test("gate control rejects failed or malformed exec receipts without extracting a JSON substring", async (t) => {
  const good = { ok: true, status: 200, rawBody: "{}" };
  const malformed = [
    ["empty stdout", ""],
    ["non JSON", "not-json"],
    ["null receipt", "null"],
    ["array receipt", "[]"],
    ["JSON log prefix", `log line\n${JSON.stringify(good)}`],
    ["JSON log suffix", `${JSON.stringify(good)}\nlog line`],
    ["two receipts", `${JSON.stringify(good)}\n${JSON.stringify(good)}`],
    ["missing ok", JSON.stringify({ status: 200, rawBody: "{}" })],
    ["missing status", JSON.stringify({ ok: true, rawBody: "{}" })],
    ["missing raw body", JSON.stringify({ ok: true, status: 200 })],
    ["non boolean ok", JSON.stringify({ ...good, ok: "true" })],
    ["string status", JSON.stringify({ ...good, status: "200" })],
    ["low status", JSON.stringify({ ...good, status: 99 })],
    ["high status", JSON.stringify({ ...good, status: 600 })],
    ["fractional status", JSON.stringify({ ...good, status: 200.5 })],
    ["non string raw body", JSON.stringify({ ...good, rawBody: {} })],
    [
      "incomplete raw JSON",
      JSON.stringify({ ...good, rawBody: '{"records":[' }),
    ],
    ["raw body log prefix", JSON.stringify({ ...good, rawBody: "log\n{}" })],
    ["extra receipt member", JSON.stringify({ ...good, extra: true })],
    ["failed request", JSON.stringify({ ok: false, error: "request_failed" })],
    ["malformed failure", JSON.stringify({ ok: false, error: {} })],
  ];
  for (const [name, stdout] of malformed)
    await t.test(name, async () => {
      let calls = 0;
      const control = await gateControl({
        async exec() {
          calls++;
          return stdout;
        },
        signal: new AbortController().signal,
      });
      try {
        await assert.rejects(async () => control.request("state"));
      } finally {
        await Promise.allSettled([
          Promise.resolve().then(() => control.join()),
        ]);
      }
      assert.equal(calls, 1);
    });
});

test(
  "gate control Node scripts keep the fixed loopback URL and time out held HTTP bodies after five seconds",
  { timeout: 30_000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const parent = new AbortController();
    const releaseBody = Promise.withResolvers();
    const received = [],
      handlers = [],
      responseClosures = [],
      jobs = [];
    const rawInventory = ` \n${JSON.stringify({
      records: Array.from({ length: 80 }, (_, index) => ({
        index,
        body: "original".repeat(512),
      })),
      forwardedByIntent: { original: 1 },
      captureErrors: [],
    })}\r\n`;
    let holdBody = false,
      headersAt = null,
      control;
    const server = createServer((request, response) => {
      responseClosures.push(
        new Promise((resolve) => response.once("close", resolve)),
      );
      const work = (async () => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        if (holdBody && request.url === "/__fault/state") {
          response.write('{"records":[');
          response.flushHeaders();
          headersAt = performance.now();
          await releaseBody.promise;
          if (!response.destroyed) response.end("]}");
        } else
          response.end(
            request.url === "/__fault/state" ? rawInventory : '{"released":1}',
          );
      })();
      handlers.push(work);
      void work.catch((error) => response.destroy(error));
    });
    const emergency = () => {
      releaseBody.resolve();
      for (const job of jobs)
        if (job.child.exitCode === null && job.child.signalCode === null)
          job.child.kill("SIGKILL");
    };
    t.signal.addEventListener("abort", emergency, { once: true });
    let state, armed, released, timeoutOutcome, cleanupResults;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      const mappedOrigin = `http://127.0.0.1:${address.port}`;
      control = await gateControl({
        signal: parent.signal,
        exec(script) {
          const wrapper = `{
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (input, init) => {
            const originalUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const parsed = new URL(originalUrl);
            if (parsed.origin !== "http://127.0.0.1:8080" || parsed.search || parsed.hash ||
              !["/__fault/state", "/__fault/arm", "/__fault/release"].includes(parsed.pathname))
              throw new Error("Unexpected gate control URL");
            process.stderr.write(JSON.stringify({ originalUrl }) + "\\n");
            const mapped = new URL(parsed.pathname, ${JSON.stringify(mappedOrigin)});
            return originalFetch(input instanceof Request ? new Request(mapped, input) : mapped, init);
          };
        }
        `;
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", wrapper + script],
            {
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const stdout = [],
            stderr = [];
          let spawnFailure;
          child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
          child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
          child.once("error", (error) => {
            spawnFailure = error;
          });
          const job = { child, watchdogFired: false };
          jobs.push(job);
          const watchdog = setTimeout(() => {
            job.watchdogFired = true;
            child.kill("SIGKILL");
          }, 9_000);
          watchdog.unref();
          job.closed = new Promise((resolve) =>
            child.once("close", (code, signal) => {
              clearTimeout(watchdog);
              Object.assign(job, {
                code,
                signal,
                spawnFailure,
                closedAt: performance.now(),
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
              });
              resolve(job);
            }),
          );
          return job.closed.then((result) => {
            if (result.spawnFailure || result.code !== 0 || result.signal)
              throw new Error(
                "Gate control fixture Node exec did not exit successfully",
              );
            return result.stdout;
          });
        },
      });
      state = await control.request("state");
      armed = await control.request("arm", {
        body: { intentId: "original-原件" },
      });
      released = await control.request("release", {
        body: { intentId: "original-原件" },
        cleanup: true,
      });
      holdBody = true;
      [timeoutOutcome] = await Promise.allSettled([control.request("state")]);
    } finally {
      parent.abort();
      releaseBody.resolve();
      try {
        if (control)
          await Promise.allSettled([
            Promise.resolve().then(() => control.join()),
          ]);
      } finally {
        emergency();
        await Promise.allSettled(jobs.map((job) => job.closed));
        server.closeAllConnections();
        const closed = server.listening
          ? new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve();
        cleanupResults = await Promise.allSettled([
          closed,
          ...handlers,
          ...responseClosures,
        ]);
        t.signal.removeEventListener("abort", emergency);
      }
    }
    assert.equal(server.listening, false);
    assert(
      cleanupResults.every((result) => result.status === "fulfilled"),
      "Real HTTP handlers and connections must finish cleanly",
    );
    assert.equal(jobs.length, 4);
    for (const job of jobs) {
      assert.equal(
        job.watchdogFired,
        false,
        "The emergency watchdog is not timeout evidence",
      );
      assert.equal(job.code, 0);
      assert.equal(job.signal, null);
      assert.equal(
        job.child.exitCode,
        0,
        "exec must settle only after the real Node child exits",
      );
    }
    assert.deepEqual(state, {
      status: 200,
      rawBody: rawInventory,
      body: JSON.parse(rawInventory),
    });
    assert.equal(state.body.records.length, 80);
    assert.deepEqual(armed.body, { released: 1 });
    assert.deepEqual(released.body, { released: 1 });
    assert.deepEqual(received, [
      { method: "GET", path: "/__fault/state", body: "" },
      {
        method: "POST",
        path: "/__fault/arm",
        body: JSON.stringify({ intentId: "original-原件" }),
      },
      {
        method: "POST",
        path: "/__fault/release",
        body: JSON.stringify({ intentId: "original-原件" }),
      },
      { method: "GET", path: "/__fault/state", body: "" },
    ]);
    assert.deepEqual(
      jobs.map((job) => JSON.parse(job.stderr.trim())),
      [
        { originalUrl: "http://127.0.0.1:8080/__fault/state" },
        { originalUrl: "http://127.0.0.1:8080/__fault/arm" },
        { originalUrl: "http://127.0.0.1:8080/__fault/release" },
        { originalUrl: "http://127.0.0.1:8080/__fault/state" },
      ],
    );
    assert.equal(timeoutOutcome.status, "rejected");
    const timeoutReceipt = JSON.parse(jobs.at(-1).stdout);
    assert.deepEqual(Object.keys(timeoutReceipt).sort(), ["error", "ok"]);
    assert.equal(timeoutReceipt.ok, false);
    assert.match(timeoutReceipt.error, /^[a-z][a-z0-9_]{0,63}$/u);
    assert.equal(
      typeof headersAt,
      "number",
      "The real HTTP response headers must arrive before the timeout",
    );
    const heldBodyMs = jobs.at(-1).closedAt - headersAt;
    assert(
      heldBodyMs >= 4_000 && heldBodyMs < 8_500,
      `Held response body must hit the five-second budget, observed ${heldBodyMs}ms`,
    );
  },
);
