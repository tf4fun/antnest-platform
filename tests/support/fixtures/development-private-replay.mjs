import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { developmentPrivateStateFixture } from "./development-private-state.mjs";
import { requestFixture } from "../../e2e/acp-plan/trace-fixture.mjs";
import { privateBoundaryFixture } from "../../e2e/acp-plan/private-boundary.fixture.mjs";
import { privatePlanRequestFixture } from "../../e2e/acp-plan/private-request.fixture.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const now = () =>
  Math.trunc((performance.timeOrigin + performance.now()) * 1000);
const valueOf = (value) =>
  Object.hasOwn(value, "intValue")
    ? Number(value.intValue)
    : Object.values(value)[0];
const attributes = (rows) =>
  rows.map(({ key, value }) => ({ key, value: valueOf(value) }));
const micros = (value) => Number(BigInt(value) / 1000n);

// Protocol/Jaeger adapter only. CLIENT data comes from the actual SDK's OTLP
// export; the peer's SERVER fixtures bind to this upgrade and observed RPC IDs.
export async function developmentPrivateReplayFixture(
  root,
  { agentId, sessionId, updates, onLoad = () => {}, warning = false },
) {
  const authority = developmentPrivateStateFixture(root, {
    agentId: () => agentId,
    state: () => assert.fail("replay must not read state"),
  });
  const f = {
    authority,
    requests: [],
    rpc: [],
    upgrades: [],
    exports: [],
    failures: [],
    traces: new Map(),
    details: new Map(),
  };
  let connection, closedAt;
  function connectionTrace() {
    assert(connection && closedAt, "actual private connection has not closed");
    const exported = f.exports
      .flatMap((body) =>
        body.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => ({ resource: resource.resource, span })),
          ),
        ),
      )
      .filter(
        ({ span }) =>
          span.traceId === connection.traceID &&
          span.spanId === connection.clientSpanID,
      );
    assert.equal(
      exported.length,
      1,
      "exactly one original CLIENT export required",
    );
    const { span, resource } = exported[0];
    assert.equal(span.kind, 3);
    assert.equal(span.name, "HTTP GET agent-acp-workspace");
    const resourceTags = attributes(resource.attributes);
    assert.equal(
      resourceTags.find((item) => item.key === "service.name").value,
      "antnest-private-acp-client",
    );
    const trace = structuredClone(connection.template);
    trace.traceID = connection.traceID;
    trace.processes.client = {
      serviceName: "antnest-private-acp-client",
      tags: resourceTags,
    };
    const client = {
      traceID: connection.traceID,
      spanID: span.spanId,
      processID: "client",
      operationName: span.name,
      startTime: micros(span.startTimeUnixNano),
      duration: micros(span.endTimeUnixNano) - micros(span.startTimeUnixNano),
      references: [],
      tags: [
        ...attributes(span.attributes),
        { key: "span.kind", value: "client" },
        ...(span.status?.code === 2 ? [{ key: "error", value: true }] : []),
      ],
    };
    const server = trace.spans[1];
    Object.assign(server, {
      traceID: connection.traceID,
      startTime: connection.startedAt,
      duration: Math.max(1, closedAt - connection.startedAt),
    });
    server.references = [
      {
        refType: "CHILD_OF",
        traceID: connection.traceID,
        spanID: connection.clientSpanID,
      },
    ];
    trace.spans = [client, server];
    return trace;
  }
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      f.requests.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
      });
      if (request.url === "/v1/traces") f.exports.push(JSON.parse(body));
      if (authority.handle(request, response, body)) return;
      let result;
      if (request.url === "/api/session/login")
        result = authority.login(response);
      else if (request.url.startsWith("/api/v3/trace-summaries?")) {
        const url = new URL(request.url, "http://fixture");
        const filters = JSON.parse(url.searchParams.get("query.attributes"));
        const matches = [...f.traces.values()].filter((trace) =>
          trace.spans.some((span) =>
            Object.entries(filters).every(([key, value]) =>
              span.tags.some(
                (item) => item.key === key && String(item.value) === value,
              ),
            ),
          ),
        );
        result = {
          summaries: matches.map((trace) => ({ traceId: trace.traceID })),
        };
      } else if (request.url.startsWith("/api/traces/")) {
        const id = request.url.split("/").at(-1);
        f.details.set(id, (f.details.get(id) ?? 0) + 1);
        const trace =
          id === connection?.traceID ? connectionTrace() : f.traces.get(id);
        assert(trace, "unknown private Trace requested");
        result = { data: [trace] };
      } else {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(result));
    } catch (error) {
      f.failures.push(error);
      response
        .writeHead(500, { "content-type": "application/json" })
        .end('{"code":"fixture_assertion"}');
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    f.upgrades.push({ path: request.url, headers: request.headers });
    if (request.url !== "/v1/acp") {
      socket.end(
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    try {
      assert.equal(
        f.upgrades.length,
        1,
        "one original replay connection required",
      );
      assert.equal(request.headers.cookie, undefined);
      assert.equal(
        request.headers["antnest-service-authorization"],
        "Bearer " + "W".repeat(43),
      );
      assert.equal(
        request.headers["antnest-caller-context"],
        authority.context,
      );
      assert.match(
        request.headers.traceparent,
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u,
      );
      const [, traceID, clientSpanID] = request.headers.traceparent.split("-");
      connection = {
        traceID,
        clientSpanID,
        startedAt: now(),
        template: privateBoundaryFixture(requestFixture("initialize"))
          .connectionTrace,
      };
      sockets.handleUpgrade(request, socket, head, (opened) => {
        sockets.emit("connection", opened);
        opened.once("close", () => {
          closedAt = now();
        });
        opened.on("message", async (bytes) => {
          try {
            const message = JSON.parse(bytes.toString());
            f.rpc.push(message);
            assert.deepEqual(
              f.rpc.map((row) => row.method),
              ["initialize", "session/load"].slice(0, f.rpc.length),
            );
            assert(f.rpc.length <= 2);
            const init = message.method === "initialize";
            if (!init)
              assert.deepEqual(message.params, {
                sessionId,
                cwd: "/workspace",
                mcpServers: [],
              });
            const bound = init
              ? privateBoundaryFixture(requestFixture("initialize"))
              : privatePlanRequestFixture();
            const traceID = randomBytes(16).toString("hex"),
              offset = now() - bound.request.startTime;
            bound.trace.traceID = traceID;
            for (const span of bound.trace.spans) {
              span.traceID = traceID;
              span.startTime += offset;
              for (const ref of span.references) {
                ref.traceID =
                  ref.refType === "FOLLOWS_FROM" ? connection.traceID : traceID;
                if (ref.refType === "FOLLOWS_FROM")
                  ref.spanID = connection.template.spans[1].spanID;
              }
              span.tags = span.tags.filter(
                (item) =>
                  !(
                    init &&
                    ["antnest.session.id", "session.id"].includes(item.key)
                  ),
              );
              for (const item of span.tags) {
                if (["antnest.agent.id", "agent.id"].includes(item.key))
                  item.value = agentId;
                if (["antnest.session.id", "session.id"].includes(item.key))
                  item.value = sessionId;
              }
            }
            bound.field(
              bound.request,
              "antnest.request.id",
              String(message.id),
            );
            if (warning && !init)
              bound.request.warnings = [
                "clock skew adjustment disabled; replay fixture",
              ];
            f.traces.set(traceID, bound.trace);
            if (!init) {
              for (const params of updates)
                opened.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params,
                  }),
                );
              await onLoad();
            }
            opened.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: init
                  ? {
                      protocolVersion: 1,
                      agentCapabilities: { loadSession: true },
                      _meta: { "antnest.dev/errors": { version: 1 } },
                    }
                  : {},
              }),
            );
          } catch (error) {
            f.failures.push(error);
            opened.terminate();
          }
        });
      });
    } catch (error) {
      f.failures.push(error);
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  f.origin = "http://127.0.0.1:" + server.address().port;
  f.configuration = authority.configuration(f.origin);
  f.snapshot = () => ({
    requests: f.requests,
    rpc: f.rpc,
    upgrades: f.upgrades,
    exports: f.exports,
    details: [...f.details],
    trace_ids: [...f.traces.keys()],
    connection_trace_id: connection?.traceID,
    closed: closedAt !== undefined,
  });
  f.close = async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const failures = [...f.failures, ...authority.failures];
    if (failures.length)
      throw new AggregateError(
        failures,
        "Development private replay adapter failed",
      );
  };
  return f;
}
