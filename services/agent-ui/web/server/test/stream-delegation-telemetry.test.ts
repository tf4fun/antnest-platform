import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createTestWorkspaceHttpServer, testContext, workloadHeaders } from "./support/auth-fixture.ts";
import * as observation from "../src/telemetry.ts";

test("real authenticated SSE exports its frozen original delegation deadline on its own SERVER span", async () => {
  const batches: any[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/v1/traces") batches.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200).end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  assert(address && typeof address !== "string");
  const telemetry = await observation.startBridgeTelemetry({ disabled: false,
    endpoint: new URL(`http://127.0.0.1:${address.port}`), serviceName: "agent-ui-delegation-test" });
  const pending: Promise<number>[] = [];
  const secret = "PRIVATE-ORIGINAL-SESSION-CANARY";
  const delegation = testContext({ agt: "agent-1", sid: secret,
    exp: Math.ceil(Date.now() / 1000) + 2 });
  const renewed = testContext({ agt: "agent-1", sid: secret });
  const parent = "1234567890abcdef";
  const ids = { stream: "a".repeat(32), view: "b".repeat(32), rejected: "c".repeat(32) };
  const server = createTestWorkspaceHttpServer({ async handle(request) {
    if (!new URL(request.url).pathname.endsWith("/events")) return Response.json({ ok: true });
    // An attempted later diagnostic must not replace the original snapshot.
    (observation as any).recordStreamDelegation?.(renewed.claims.exp * 1000);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(": initial\n\n"));
    } }), { headers: { "content-type": "text/event-stream" } });
  } }, { telemetry: { observeHttp(...args: Parameters<typeof telemetry.observeHttp>) {
    const work = telemetry.observeHttp(...args); pending.push(work); return work;
  } } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const headers = (token: string, id: string) => ({ ...workloadHeaders(),
    "Antnest-Caller-Context": token, traceparent: `00-${id}-${parent}-01`,
    "X-Antnest-Stream-Delegation-Expires-At": "PRIVATE-FORGED-DEADLINE-CANARY" });
  let started = 0, received = 0;
  try {
    started = Date.now();
    const response = await fetch(origin + "/api/app/workspace/v1/agents/agent-1/events", {
      headers: headers(delegation.token, ids.stream), signal: controller.signal,
    });
    received = Date.now();
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const view = await fetch(origin + "/api/app/workspace/v1/agents/agent-1/view", {
      headers: headers(renewed.token, ids.view),
    });
    assert.equal(view.status, 200); await view.text();
    const refused = await fetch(origin + "/api/app/workspace/v1/agents/agent-1/events", {
      headers: headers("invalid-context", ids.rejected),
    });
    assert.equal(refused.status, 401); await refused.text();
    assert(await reader.read().then((part) => part.done, () => !controller.signal.aborted),
      "original stream must close at its short delegation deadline");
    assert(Date.now() < renewed.claims.exp * 1000);
  } finally {
    clearTimeout(timer); controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(pending);
    await telemetry.shutdown();
    collector.closeAllConnections();
    await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  }
  const spans = batches.flatMap(batch => batch.resourceSpans.flatMap((resource: any) =>
    resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  const attributes = (span: any) => Object.fromEntries((span.attributes ?? []).map((entry: any) =>
    [entry.key, entry.value.intValue === undefined ? entry.value.doubleValue : Number(entry.value.intValue)]));
  const stream = spans.filter(span => span.traceId === ids.stream);
  assert.equal(stream.length, 1);
  assert.equal(stream[0].parentSpanId, parent);
  const values = attributes(stream[0]);
  const expiresKey = "antnest.ui.stream.delegation_expires_at_unix_ms";
  const remainingKey = "antnest.ui.stream.delegation_remaining_ms";
  assert.equal(values[expiresKey], delegation.claims.exp * 1000);
  assert(Number.isSafeInteger(values[remainingKey]) && values[remainingKey] > 0);
  const sampledAt = values[expiresKey] - values[remainingKey];
  assert(sampledAt >= started && sampledAt <= received);
  for (const id of [ids.view, ids.rejected]) {
    const selected = spans.filter(span => span.traceId === id);
    assert.equal(selected.length, 1);
    assert.equal(attributes(selected[0])[expiresKey], undefined);
    assert.equal(attributes(selected[0])[remainingKey], undefined);
  }
  for (const canary of [secret, delegation.token, renewed.token, "PRIVATE-FORGED-DEADLINE-CANARY"])
    assert(!JSON.stringify(batches).includes(canary));
});
