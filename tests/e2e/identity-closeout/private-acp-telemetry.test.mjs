import "./acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { hostname } from "node:os";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { inspect, promisify } from "node:util";

const moduleURL = new URL("./private-acp-telemetry.mjs", import.meta.url);
const implementation = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function create(...args) {
  assert.equal(typeof implementation.createPrivateACPTelemetry, "function");
  return implementation.createPrivateACPTelemetry(...args);
}
async function collector(t, respond) {
  const records = [];
  const observations = new EventEmitter();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    records.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (respond) respond(response, records.length);
    else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }
    observations.emit("request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    records,
    url: `http://127.0.0.1:${server.address().port}/v1/traces`,
    async waitForRequests(count) {
      while (records.length < count)
        await once(observations, "request", {
          signal: AbortSignal.timeout(5_000),
        });
    },
  };
}
const attributes = (values) =>
  Object.fromEntries(
    values.map(({ key, value }) => [key, Object.values(value)[0]]),
  );
function exported(records) {
  return records.flatMap(({ body }) =>
    body.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) =>
        scope.spans.map((span) => ({
          span,
          service: attributes(resource.resource.attributes)["service.name"],
          resource: attributes(resource.resource.attributes),
          attributes: attributes(span.attributes),
        })),
      ),
    ),
  );
}

test("private CLIENT telemetry exports an actual root and preserves its exact wire IDs", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  const upgrade = telemetry.startUpgrade(1);
  assert.match(upgrade.traceID, /^[a-f0-9]{32}$/u);
  assert.match(upgrade.clientSpanID, /^[a-f0-9]{16}$/u);
  assert.equal(
    upgrade.traceparent,
    `00-${upgrade.traceID}-${upgrade.clientSpanID}-01`,
  );
  upgrade.end(101);
  upgrade.end(503);
  await telemetry.flush();
  const spans = exported(c.records);
  assert.equal(spans.length, 1);
  const { span, service, attributes: values } = spans[0];
  assert.equal(service, "antnest-private-acp-client");
  assert.equal(span.name, "HTTP GET agent-acp-workspace");
  assert.equal(span.kind, 3);
  assert.equal(span.traceId, upgrade.traceID);
  assert.equal(span.spanId, upgrade.clientSpanID);
  assert(!span.parentSpanId);
  assert.equal(values["http.request.method"], "GET");
  assert.equal(Number(values["http.response.status_code"]), 101);
  assert.equal(values["antnest.protocol.version"], "v1");
  assert.equal(c.records[0].path, "/v1/traces");
  assert.equal(c.records[0].headers["content-type"], "application/json");
});

test("HTTP and WS CLIENT exports carry one actual process identity across providers", async (t) => {
  const c = await collector(t);
  const providers = [create(c.url), create(c.url)];
  for (const provider of providers) t.after(() => provider.shutdown());
  const clients = [
    providers[0].startHTTP("GET"),
    providers[0].startUpgrade(1),
    providers[1].startUpgrade(2),
  ];
  clients[0].end(200, "eof");
  clients[1].end(101);
  clients[2].end(101);
  for (const provider of providers) await provider.flush();
  const records = exported(c.records);
  assert.equal(records.length, 3);
  const instances = new Set();
  for (const client of clients) {
    const record = records.find(
      (item) => item.span.spanId === client.clientSpanID,
    );
    assert(record);
    assert.equal(record.span.traceId, client.traceID);
    assert.equal(record.resource["host.name"], hostname());
    assert.equal(Number(record.resource["process.pid"]), process.pid);
    assert.equal(record.resource["process.runtime.name"], "nodejs");
    assert.equal(record.resource["telemetry.sdk.name"], "opentelemetry");
    assert.equal(record.resource["telemetry.sdk.language"], "nodejs");
    assert.equal(typeof record.resource["service.instance.id"], "string");
    assert(record.resource["service.instance.id"].length > 0);
    instances.add(record.resource["service.instance.id"]);
  }
  assert.equal(instances.size, 1);
});

test("a separate actual Node process exports a distinct CLIENT process identity", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  const parent = telemetry.startHTTP("POST");
  parent.end(200, "eof");
  await telemetry.flush();
  const dependencies = new URL(
    "./acp-client-dependencies.fixture.mjs",
    import.meta.url,
  );
  const code = `
    import ${JSON.stringify(dependencies.href)};
    const { createPrivateACPTelemetry } = await import(${JSON.stringify(moduleURL.href)});
    const telemetry = createPrivateACPTelemetry(${JSON.stringify(c.url)});
    const client = telemetry.startHTTP("GET");
    client.end(200, "eof");
    try { await telemetry.flush(); } finally { await telemetry.shutdown(); }
    process.stdout.write(JSON.stringify({pid: process.pid, traceID: client.traceID, clientSpanID: client.clientSpanID}));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", code],
    { timeout: 10000, maxBuffer: 16384 },
  );
  const child = JSON.parse(stdout);
  assert(Number.isSafeInteger(child.pid) && child.pid > 0);
  assert.notEqual(child.pid, process.pid);
  const records = exported(c.records);
  assert.equal(records.length, 2);
  const first = records.find(
    (record) => record.span.spanId === parent.clientSpanID,
  );
  const second = records.find(
    (record) => record.span.spanId === child.clientSpanID,
  );
  assert(first && second);
  assert.equal(second.span.traceId, child.traceID);
  assert.equal(first.resource["host.name"], hostname());
  assert.equal(second.resource["host.name"], hostname());
  assert.equal(Number(first.resource["process.pid"]), process.pid);
  assert.equal(Number(second.resource["process.pid"]), child.pid);
  assert.notEqual(
    first.resource["service.instance.id"],
    second.resource["service.instance.id"],
  );
});

test("private CLIENT denial and interrupted upgrade remain exported failures", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  telemetry.startUpgrade(2).end(401);
  telemetry.startUpgrade(1).end(undefined, "cancelled");
  await telemetry.flush();
  const spans = exported(c.records);
  assert.equal(spans.length, 2);
  assert(spans.every(({ span }) => span.status.code === 2));
  assert.equal(Number(spans[0].attributes["http.response.status_code"]), 401);
  assert.equal(spans[0].attributes["antnest.outcome"], "rejected");
  assert.equal(spans[1].attributes["antnest.outcome"], "cancelled");
  assert(!JSON.stringify(c.records).includes("exception.message"));
});

test("HTTP 101 does not erase an explicit SDK handshake failure", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  telemetry.startUpgrade(1).end(101, "failed");
  await telemetry.flush();
  const [{ span, attributes: values }] = exported(c.records);
  assert.equal(Number(values["http.response.status_code"]), 101);
  assert.equal(values["antnest.outcome"], "failed");
  assert.equal(span.status.code, 2);
});

test("private telemetry requires an explicit plain exporter endpoint and owns shutdown", async (t) => {
  for (const endpoint of [
    undefined,
    "",
    "file:///tmp/traces",
    "http://user:secret@localhost/v1/traces",
    "http://localhost/v1/traces?token=secret",
    "http://localhost/v1/traces#secret",
  ])
    assert.throws(() => create(endpoint));
  const c = await collector(t);
  const telemetry = create(c.url);
  for (const version of [undefined, 0, "1", 3])
    assert.throws(() => telemetry.startUpgrade(version));
  await telemetry.shutdown();
  await telemetry.shutdown();
  assert.throws(() => telemetry.startUpgrade(1));
  assert.equal(c.records.length, 0);
});

test("malformed exporter URLs cannot expose credential input in errors", () => {
  assert.throws(
    () => create("http://user:PRIVATE-OTLP-CANARY@"),
    (error) => {
      assert.doesNotMatch(inspect(error), /PRIVATE-OTLP-CANARY/u);
      assert.equal(error.cause, undefined);
      assert.equal(error.input, undefined);
      return true;
    },
  );
});

test("HTTP telemetry exports separate method contexts and neutral cancellation", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  const clients = ["GET", "POST", "DELETE"].map((method) =>
    telemetry.startHTTP(method),
  );
  clients[0].end(200, "cancelled", 9);
  clients[1].end(202, "eof", 0);
  clients[2].end(202, "eof", 2);
  clients[0].end(503, "failed");
  await telemetry.flush();
  const spans = exported(c.records);
  assert.equal(spans.length, 3);
  assert.equal(new Set(spans.map(({ span }) => span.traceId)).size, 3);
  spans.forEach(({ span, attributes: values }, index) => {
    assert.equal(span.kind, 3);
    assert.equal(span.traceId, clients[index].traceID);
    assert.equal(span.spanId, clients[index].clientSpanID);
    assert(!span.parentSpanId);
    assert.notEqual(span.status?.code, 2);
    assert.equal(values["antnest.protocol.version"], "v1");
    assert.equal(
      values["http.request.method"],
      ["GET", "POST", "DELETE"][index],
    );
  });
  assert.equal(spans[0].attributes["antnest.outcome"], "cancelled");
  assert.equal(Number(spans[0].attributes["http.response.body.size"]), 9);
});

test("HTTP failure status and independent body failure survive cancellation", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  telemetry.startHTTP("GET").end(503, "cancelled", 2);
  telemetry.startHTTP("POST").end(200, "failed", 3);
  telemetry.startHTTP("DELETE").end(204, "failed", 0);
  await telemetry.flush();
  const spans = exported(c.records);
  assert.equal(spans.length, 3);
  assert(spans.every(({ span }) => span.status.code === 2));
  assert.deepEqual(
    spans.map(({ attributes: values }) =>
      Number(values["http.response.status_code"]),
    ),
    [503, 200, 204],
  );
  assert(
    spans.every(
      ({ attributes: values }) => values["error.type"] === "ACPHTTPError",
    ),
  );
  assert(!JSON.stringify(c.records).includes("exception.message"));
  for (const method of [undefined, "PATCH", "get"])
    assert.throws(() => telemetry.startHTTP(method));
  await telemetry.shutdown();
  assert.throws(() => telemetry.startHTTP("GET"));
});

test("HTTP cleanup failure retains its original cancelled body outcome", async (t) => {
  const c = await collector(t);
  const telemetry = create(c.url);
  t.after(() => telemetry.shutdown());
  telemetry.startHTTP("DELETE").end(202, "failed", 5, "cancelled");
  await telemetry.flush();
  const [{ span, attributes: values }] = exported(c.records);
  assert.equal(span.status.code, 2);
  assert.equal(values["antnest.outcome"], "failed");
  assert.equal(values["antnest.http.body.outcome"], "cancelled");
  assert.equal(Number(values["http.response.status_code"]), 202);
  assert.equal(Number(values["http.response.body.size"]), 5);
});

function respond(response, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end("{}");
}

async function heldCollector(t, rejectFirst = false) {
  const held = new Set();
  let released = false;
  let active = 0;
  let peak = 0;
  const c = await collector(t, (response, index) => {
    active++;
    peak = Math.max(peak, active);
    response.once("finish", () => active--);
    if (rejectFirst && index === 1) respond(response, 400);
    else if (released) respond(response);
    else held.add(response);
  });
  return {
    ...c,
    peak: () => peak,
    release() {
      released = true;
      for (const response of held) respond(response);
      held.clear();
    },
  };
}

async function exportFailure(promise, client, reason = "export_failed") {
  let failure;
  await assert.rejects(promise, (error) => {
    failure = error;
    assert.equal(error.code, "PRIVATE_ACP_EXPORT_FAILED");
    assert.equal(error.reason, reason);
    assert.equal(error.traceID, client.traceID);
    assert.equal(error.clientSpanID, client.clientSpanID);
    return true;
  });
  return failure;
}

test("an already settled HTTP 400 export remains a failure after later exports and shutdown", async (t) => {
  const c = await collector(t, (response, index) =>
    respond(response, index === 1 ? 400 : index === 3 ? 403 : 200),
  );
  const telemetry = create(c.url);
  try {
    const first = telemetry.startHTTP("GET");
    first.end(200, "eof", 2);
    // This first flush is a settlement barrier, not evidence of success. The
    // regression is the later flush, after the SDK has removed its failed work.
    await telemetry.flush().catch(() => {});
    const failure = await exportFailure(telemetry.flush(), first);
    assert.equal(failure.cause.code, 400);
    for (let index = 0; index < 2; index++) {
      telemetry.startUpgrade(1).end(101);
      assert.equal(await exportFailure(telemetry.flush(), first), failure);
    }
    assert.equal(exported(c.records).length, 3);
    const shutdown = telemetry.shutdown();
    assert.equal(telemetry.shutdown(), shutdown);
    assert.equal(await exportFailure(shutdown, first), failure);
    assert.throws(() => telemetry.startHTTP("GET"));
    assert.throws(() => telemetry.startUpgrade(1));
  } finally {
    await telemetry.shutdown().catch(() => {});
  }
});

for (const operation of ["flush", "shutdown"])
  test(`${operation} joins a held burst beyond the SDK exporter limit without losing original spans`, async (t) => {
    const c = await heldCollector(t);
    const telemetry = create(c.url);
    const clients = Array.from({ length: 64 }, () =>
      telemetry.startHTTP("GET"),
    );
    for (const client of clients) client.end(200, "cancelled", 7);
    let settled = false;
    const result = telemetry[operation]().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    void result.then(() => (settled = true));
    try {
      await c.waitForRequests(1);
      await setImmediate();
      assert.equal(
        settled,
        false,
        "must join the actual held export responses",
      );
      c.release();
      const outcome = await result;
      if (!outcome.ok) throw outcome.error;
      assert.deepEqual(
        exported(c.records)
          .map(({ span }) => `${span.traceId}/${span.spanId}`)
          .sort(),
        clients
          .map((client) => `${client.traceID}/${client.clientSpanID}`)
          .sort(),
      );
      assert(c.peak() <= 8, "private exporter bounds actual HTTP concurrency");
    } finally {
      c.release();
      await result;
      await telemetry.shutdown().catch(() => {});
    }
  });

test("shutdown still joins later in-flight exports before reporting an earlier settled failure", async (t) => {
  const c = await heldCollector(t, true);
  const telemetry = create(c.url);
  let result;
  try {
    const failed = telemetry.startUpgrade(2);
    failed.end(101);
    await telemetry.flush().catch(() => {});
    const next = telemetry.startHTTP("DELETE");
    next.end(204, "eof");
    await c.waitForRequests(2);
    let settled = false;
    result = telemetry.shutdown().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    void result.then(() => (settled = true));
    await setImmediate();
    assert.equal(settled, false);
    assert.throws(() => telemetry.startHTTP("GET"));
    c.release();
    await result;
    const failure = await exportFailure(telemetry.shutdown(), failed);
    assert.equal(failure.cause.code, 400);
    assert.deepEqual(
      exported(c.records).map(({ span }) => span.spanId),
      [failed.clientSpanID, next.clientSpanID],
    );
  } finally {
    c.release();
    await result;
    await telemetry.shutdown().catch(() => {});
  }
});

test("queue overflow is explicit and retains the rejected span identity while accepted exports drain", async (t) => {
  const c = await heldCollector(t);
  const telemetry = create(c.url);
  const clients = Array.from({ length: 257 }, () => telemetry.startUpgrade(1));
  for (const client of clients) client.end(101);
  const result = telemetry.flush().catch(() => {});
  try {
    await c.waitForRequests(1);
    c.release();
    await result;
    const failure = await exportFailure(
      telemetry.flush(),
      clients.at(-1),
      "queue_full",
    );
    assert.deepEqual(
      exported(c.records)
        .map(({ span }) => `${span.traceId}/${span.spanId}`)
        .sort(),
      clients
        .slice(0, 256)
        .map((client) => `${client.traceID}/${client.clientSpanID}`)
        .sort(),
    );
    assert.equal(
      await exportFailure(telemetry.shutdown(), clients.at(-1), "queue_full"),
      failure,
    );
  } finally {
    c.release();
    await result;
    await telemetry.shutdown().catch(() => {});
  }
});

for (const kind of ["http", "upgrade"])
  test(`shutdown rejects an unfinished ${kind} span and a late end cannot silently disappear`, async (t) => {
    const c = await collector(t);
    const telemetry = create(c.url);
    const client =
      kind === "http" ? telemetry.startHTTP("GET") : telemetry.startUpgrade(1);
    const shutdown = telemetry.shutdown();
    void shutdown.catch(() => {});
    try {
      assert.throws(
        () => client.end(kind === "http" ? 200 : 101, "eof"),
        /telemetry is shut down/u,
      );
      await exportFailure(shutdown, client, "unfinished_span");
      assert.equal(exported(c.records).length, 0);
    } finally {
      await shutdown.catch(() => {});
    }
  });

test("a provider flush deadline still joins the actual queued exports before returning its error", async (t) => {
  const { node } = await import("@opentelemetry/sdk-node");
  const original = node.NodeTracerProvider.prototype.forceFlush;
  const deadline = Promise.withResolvers();
  // Exercise the installed SDK's real deadline without spending its default
  // 30 seconds. Only the provider deadline changes; OTLP responses stay real.
  t.mock.method(node.NodeTracerProvider.prototype, "forceFlush", function () {
    return original.call(this, { timeoutMillis: 1 }).catch((error) => {
      deadline.resolve(error);
      throw error;
    });
  });
  const c = await heldCollector(t);
  const telemetry = create(c.url);
  const clients = Array.from({ length: 17 }, () => telemetry.startHTTP("GET"));
  for (const client of clients) client.end(200, "eof", 2);
  let settled = false;
  const result = telemetry.flush().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  void result.then(() => (settled = true));
  try {
    await c.waitForRequests(1);
    const error = await deadline.promise;
    assert.match(inspect(error), /timeout period of 1 ms/u);
    await setImmediate();
    assert.equal(settled, false, "provider timeout must not abandon exports");
    c.release();
    assert.deepEqual(await result, { ok: false, error });
    assert.deepEqual(
      exported(c.records)
        .map(({ span }) => `${span.traceId}/${span.spanId}`)
        .sort(),
      clients
        .map((client) => `${client.traceID}/${client.clientSpanID}`)
        .sort(),
    );
  } finally {
    c.release();
    await result;
    await telemetry.shutdown().catch(() => {});
  }
});
