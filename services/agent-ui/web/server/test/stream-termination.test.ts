import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createTestWorkspaceHttpServer, testContext, workloadHeaders } from "./support/auth-fixture.ts";
import { createEventHandler } from "../src/http/event-routes.ts";
import { StreamJournal, StreamCapacityError } from "../src/bridge/stream-journal.ts";
import * as telemetryModule from "../src/telemetry.ts";

const scope = { organizationId: "org-1", principalId: "user-1", agentId: "agent-1" };
const cause = { reason: "access_denied" as const, source: "agent-execution-state" as const };
const path = "/api/app/workspace/v1/agents/agent-1/events";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fields = (attributes = []) => Object.fromEntries(attributes.map(attribute =>
  [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]));

test("only a normally completed, opened, scoped SSE exports one non-error access-denial witness", { timeout: 20_000 }, async () => {
  const exports: unknown[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/v1/traces") exports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200).end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const telemetry = await telemetryModule.startBridgeTelemetry({ disabled: false,
    endpoint: new URL(`http://127.0.0.1:${(collector.address() as { port: number }).port}`), serviceName: "agent-ui-termination-test" });
  const cases = new Map<string, {
    journal: StreamJournal<unknown>; subscribed: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>; deliver: ReturnType<typeof deferred>; releases: number;
  }>();
  const server = createTestWorkspaceHttpServer({ async handle(request) {
    const name = new URL(request.url).searchParams.get("case")!;
    const row = cases.get(name)!;
    const response = await createEventHandler({ async subscribe() {
      const cursor = name === "expired-before-headers" ? row.journal.snapshot(() => ({})).cursor : null;
      return { events: row.journal.subscribe(cursor, cursor => ({ streamCursor: cursor })),
        release() { row.releases++; row.released.resolve(); } };
    } })(request);
    row.subscribed.resolve();
    if (name === "expired-before-headers") await row.deliver.promise;
    return response;
  } }, { telemetry });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const traces = new Map<string, string>();
  let endedRecorder: ((value: unknown) => void) | undefined;
  try {
    for (const name of ["denied", "ordinary", "client-abort", "capacity", "foreign-principalId", "foreign-organizationId", "foreign-agentId", "expired-before-headers"]) {
      const foreignKey = name.startsWith("foreign-") ? name.slice(8) : null;
      const journal = new StreamJournal({ scope: { ...scope, ...(foreignKey ? { [foreignKey]: "foreign" } : {}) },
        sessionId: "session-1", epoch: "epoch-1", projectionId: "projection-1", key: Buffer.alloc(32, 3), maxSubscriberBytes: 1024 });
      const row = { journal, subscribed: deferred(), released: deferred(), deliver: deferred(), releases: 0 };
      cases.set(name, row);
      const traceId = String(cases.size).padStart(32, "0");
      traces.set(name, traceId);
      const expiresAt = name === "expired-before-headers" ? Math.ceil(Date.now() / 1000) + 1 : Math.floor(Date.now() / 1000) + 60;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const headers = { ...workloadHeaders(), "Antnest-Caller-Context": testContext({ agt: "agent-1", exp: expiresAt }).token,
        traceparent: `00-${traceId}-1111111111111111-01`,
        "x-antnest-principal-id": "untrusted-user", "x-antnest-organization-id": "untrusted-org" };
      try {
        if (name === "expired-before-headers") {
          const pending = fetch(`${origin}${path}?case=${name}`, { headers, signal: controller.signal }).then(response => response.status, () => "closed");
          await row.subscribed.promise;
          journal.close(cause);
          await row.released.promise;
          await delay(Math.max(0, expiresAt * 1000 - Date.now()) + 30);
          row.deliver.resolve();
          assert.notEqual(await pending, 200, "an expired, prefetched done result must not open an SSE");
        } else {
          const response = await fetch(`${origin}${path}?case=${name}`, { headers, signal: controller.signal });
          assert.equal(response.status, 200);
          const reader = response.body!.getReader();
          assert.equal((await reader.read()).done, false, "the stream must actually open before closure");
          const finished = reader.read().then(part => part.done, error => {
            if (name !== "client-abort") throw error;
            return false;
          });
          if (name === "client-abort") controller.abort();
          else if (name === "ordinary") journal.close();
          else if (name === "capacity") assert.throws(() => journal.publishReset(() => ({ body: "x".repeat(2048) })), StreamCapacityError);
          else await telemetry.observeHttp("GET", "/unrelated", async () => {
            journal.close(cause);
            await finished;
            return 200;
          });
          assert.equal(await finished, name !== "client-abort");
          await row.released.promise;
          journal.close(cause); // A later denial must not relabel cancellation/capacity/ordinary EOF.
          reader.releaseLock();
        }
        assert.equal(row.releases, 1);
      } finally { clearTimeout(timer); controller.abort(); row.deliver.resolve(); journal.close(); }
    }
    // The recorder is deliberately invoked under a different active HTTP span.
    // It must keep the admitted request's span and stop writing after it ends.
    await telemetry.observeHttp("GET", "/captured", async () => {
      endedRecorder = telemetryModule.captureStreamTermination(scope);
      await telemetry.observeHttp("GET", "/different", async () => {
        endedRecorder!({ ...cause, ...scope });
        endedRecorder!({ ...cause, ...scope });
        return 200;
      });
      return 200;
    });
    endedRecorder!({ ...cause, ...scope });
    let unusedRecorder!: (value: unknown) => void;
    await telemetry.observeHttp("GET", "/ended-unused", async () => {
      unusedRecorder = telemetryModule.captureStreamTermination(scope);
      return 200;
    });
    await telemetry.observeHttp("GET", "/late-caller", async () => {
      unusedRecorder({ ...cause, ...scope });
      return 200;
    });
  } finally {
    for (const row of cases.values()) { row.deliver.resolve(); row.journal.close(); }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await telemetry.shutdown();
    collector.closeAllConnections();
    await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  }
  const spans = exports.flatMap((payload: any) => payload.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  const terminations = span => (span.events ?? []).filter(event => event.name === "antnest.stream.termination");
  for (const [name, traceId] of traces) {
    const matches = spans.filter(span => span.traceId === traceId);
    assert.equal(matches.length, 1, name);
    const span = matches[0];
    const events = terminations(span);
    assert.equal(events.length, name === "denied" ? 1 : 0, name);
    if (name === "denied") {
      assert.equal(span.kind, 2);
      assert.equal(Number(fields(span.attributes)["http.response.status_code"]), 200);
      assert.notEqual(span.status?.code, 2);
      assert.deepEqual(fields(events[0].attributes), { reason: "access_denied", source: "agent-execution-state",
        "antnest.organization.id": "org-1", "antnest.principal.id": "user-1", "antnest.agent.id": "agent-1" });
      assert(BigInt(events[0].timeUnixNano) >= BigInt(span.startTimeUnixNano));
      assert(BigInt(events[0].timeUnixNano) <= BigInt(span.endTimeUnixNano));
    }
  }
  for (const route of ["/captured", "/different", "/unrelated", "/ended-unused", "/late-caller"]) {
    const matches = spans.filter(span => fields(span.attributes)["http.route"] === route);
    assert(matches.length > 0);
    assert.equal(matches.reduce((total, span) => total + terminations(span).length, 0), route === "/captured" ? 1 : 0, route);
  }
});
