import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createWorkspaceHttpServer } from "../src/http/node-server.ts";
import { discoverWorkspaceAgents } from "../src/adapters/controller-workspace.ts";
import { startBridgeTelemetry, withActiveHttpTrace } from "../src/telemetry.ts";

test("Bridge continues the incoming Gateway trace and flushes HTTP telemetry on shutdown", async () => {
  const traceId = "0123456789abcdef0123456789abcdef";
  const parentSpanId = "1111111111111111";
  const received: Array<{ path: string; body: string }> = [];
  const collector = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    received.push({ path: request.url ?? "", body: Buffer.concat(parts).toString("utf8") });
    response.writeHead(200).end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  try {
    const address = collector.address();
    assert.ok(address && typeof address !== "string");
    const telemetry = await startBridgeTelemetry({
      disabled: false,
      endpoint: new URL(`http://127.0.0.1:${address.port}`),
      serviceName: "agent-ui-test",
    });
    telemetry.registerRuntimeMetrics(() => ({ owners: 2, observerLeases: 1,
      heldWork: 1, cachedBytes: 1024,
      streamSubscribers: 3, journalQueuedBytes: 256, journalRetainedBytes: 768,
      activeReplays: 1, queuedReplays: 2,
      uncertainOperations: 2, oldestUncertainMs: 1_250 }));
    telemetry.recordColdReplay(12, "success");
    telemetry.recordColdReplay(8, "error");
    telemetry.recordLocalIntentReuse("hit");
    telemetry.recordLocalIntentReuse("conflict");
    const bridge = createWorkspaceHttpServer({ async handle() { return null; } }, { telemetry });
    bridge.listen(0, "127.0.0.1");
    await once(bridge, "listening");
    try {
      const forwarded: Headers[] = [];
      const traced = withActiveHttpTrace(async (_url, init) => {
        forwarded.push(new Headers(init?.headers));
        return Response.json({ ok: true });
      });
      let resolveBackground!: () => void;
      const background = new Promise<void>((resolve) => { resolveBackground = resolve; });
      await telemetry.observeHttp("GET", "/workspace/", async () => {
        await traced("http://controller.internal/status", { headers: { accept: "application/json" } });
        setTimeout(() => {
          void traced("http://controller.internal/status").then(() => resolveBackground());
        }, 0);
        return 200;
      }, { traceparent: `00-${traceId}-${parentSpanId}-01` });
      await background;
      assert.equal(forwarded[0]?.get("accept"), "application/json");
      assert.match(forwarded[0]?.get("traceparent") ?? "",
        new RegExp(`^00-${traceId}-(?!${parentSpanId})[a-f0-9]{16}-01$`));
      assert.equal(forwarded[1]?.get("traceparent"), null,
        "Background work must not inherit an ended HTTP parent span");
      let controllerTraceparent: string | null = null;
      await telemetry.observeHttp("GET", "/workspace/", async () => {
        await discoverWorkspaceAgents({
          baseUrl: new URL("http://controller.internal"),
          scope: { organizationId: "org-1", principalId: "user-1" },
          fetchImpl: async (_url, init) => {
            controllerTraceparent = new Headers(init?.headers).get("traceparent");
            return Response.json({ agents: [], next_cursor: null });
          },
        });
        return 200;
      }, { traceparent: `00-${traceId}-${parentSpanId}-01` });
      assert.match(controllerTraceparent ?? "", new RegExp(`^00-${traceId}-[a-f0-9]{16}-01$`),
        "Controller discovery must continue the active Bridge HTTP trace");
      const bridgeAddress = bridge.address();
      assert.ok(bridgeAddress && typeof bridgeAddress !== "string");
      const response = await fetch(`http://127.0.0.1:${bridgeAddress.port}/status`, {
        headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
      });
      assert.equal(response.status, 200);
      await response.text();
    } finally {
      bridge.closeAllConnections();
      bridge.close();
      await once(bridge, "close");
      await telemetry.shutdown();
    }
    const traceExport = received.find((item) => item.path === "/v1/traces" && item.body);
    assert.ok(traceExport,
      `A completed HTTP span was not exported: ${JSON.stringify(received)}`);
    const spans = JSON.parse(traceExport.body).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans));
    assert.ok(spans.some((span) => span.traceId === traceId &&
      span.parentSpanId === parentSpanId),
    `The Bridge span did not continue the Gateway context: ${JSON.stringify(spans)}`);
    assert.ok(received.some((item) => item.path === "/v1/metrics" && item.body),
      `HTTP metrics were not flushed: ${JSON.stringify(received)}`);
    const exportedMetrics = received.filter((item) => item.path === "/v1/metrics")
      .flatMap((item) => JSON.parse(item.body).resourceMetrics.flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics)));
    for (const name of ["antnest.ui.bridge.owners", "antnest.ui.bridge.observer_leases",
      "antnest.ui.bridge.held_work", "antnest.ui.bridge.cached_history_bytes",
      "antnest.ui.bridge.stream_subscribers",
      "antnest.ui.bridge.journal_queued_bytes", "antnest.ui.bridge.journal_retained_bytes",
      "antnest.ui.bridge.active_replays", "antnest.ui.bridge.queued_replays",
      "antnest.ui.bridge.uncertain_operations",
      "antnest.ui.bridge.oldest_uncertain_ms",
      "antnest.ui.process.heap_used_bytes",
      "antnest.ui.process.rss_bytes"])
      assert.ok(exportedMetrics.some((metric) => metric.name === name),
        `Missing Bridge capacity metric ${name}`);
    const replayMetric = exportedMetrics.find((metric) =>
      metric.name === "antnest.ui.bridge.cold_replay_duration");
    assert.ok(replayMetric, "Cold replay duration metric must be exported");
    assert.deepEqual(replayMetric.histogram?.dataPoints?.map((point: { attributes: Array<{
      key: string; value: { stringValue?: string };
    }> }) => point.attributes.find((attribute) => attribute.key === "outcome")?.value.stringValue)
      .sort(), ["error", "success"]);
    const reuseMetric = exportedMetrics.find((metric) =>
      metric.name === "antnest.ui.bridge.local_intent_reuse");
    assert.deepEqual(reuseMetric?.sum?.dataPoints?.map((point: { attributes: Array<{
      key: string; value: { stringValue?: string };
    }> }) => point.attributes.find((attribute) => attribute.key === "outcome")?.value.stringValue)
      .sort(), ["conflict", "hit"]);
    const gaugeValue = (name: string): number => {
      const point = exportedMetrics.find((metric) => metric.name === name)?.gauge?.dataPoints?.[0];
      return Number(point?.asInt ?? point?.asDouble);
    };
    assert.equal(gaugeValue("antnest.ui.bridge.owners"), 2);
    assert.equal(gaugeValue("antnest.ui.bridge.observer_leases"), 1);
    assert.equal(gaugeValue("antnest.ui.bridge.cached_history_bytes"), 1024);
    assert.equal(gaugeValue("antnest.ui.bridge.stream_subscribers"), 3);
    assert.equal(gaugeValue("antnest.ui.bridge.journal_queued_bytes"), 256);
    assert.equal(gaugeValue("antnest.ui.bridge.uncertain_operations"), 2);
    assert.equal(gaugeValue("antnest.ui.bridge.oldest_uncertain_ms"), 1_250);
    assert.equal(gaugeValue("antnest.ui.bridge.journal_retained_bytes"), 768);
    assert.equal(gaugeValue("antnest.ui.bridge.active_replays"), 1);
    assert.equal(gaugeValue("antnest.ui.bridge.queued_replays"), 2);
    assert.ok(gaugeValue("antnest.ui.process.heap_used_bytes") > 0);
    assert.ok(gaugeValue("antnest.ui.process.rss_bytes") > 0);
  } finally {
    collector.closeAllConnections();
    collector.close();
    await once(collector, "close");
  }
});
