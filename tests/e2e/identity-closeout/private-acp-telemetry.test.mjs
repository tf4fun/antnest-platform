import "./acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { inspect } from "node:util";

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
async function collector(t) {
  const records = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    records.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
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
