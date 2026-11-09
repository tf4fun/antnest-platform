import assert from "node:assert/strict";
import { test } from "node:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";

import * as telemetryModule from "../src/telemetry.ts";

const scope = { organizationId: "org-1", principalId: "user-1", agentId: "agent-1" };
const cause = (overrides: Record<string, string> = {}) => ({
  reason: "access_denied",
  source: "agent-execution-state",
  organizationId: scope.organizationId,
  principalId: scope.principalId,
  agentId: scope.agentId,
  ...overrides,
});

const terminationEvents = (exporter: tracing.InMemorySpanExporter) =>
  exporter
    .getFinishedSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "antnest.stream.termination");

const installRecorder = () => {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return { exporter, provider };
};

const teardown = async (provider: node.NodeTracerProvider, legacy: string | undefined) => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  if (legacy === undefined) delete process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
  else process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES = legacy;
};

test("stream termination dual-emits canonical keys and generated aliases by default", async (t) => {
  const legacy = process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
  delete process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
  const { exporter, provider } = installRecorder();
  t.after(() => teardown(provider, legacy));
  const telemetry = await telemetryModule.startBridgeTelemetry({
    disabled: false,
    serviceName: "names-test",
  });
  const status = await telemetry.observeHttp("GET", "/events", async () => {
    telemetryModule.captureStreamTermination(scope)(cause());
    return 200;
  });
  assert.equal(status, 200);
  await provider.forceFlush();
  const events = terminationEvents(exporter);
  assert.equal(events.length, 1);
  const attributes = events[0]!.attributes!;
  assert.deepEqual(Object.keys(attributes).sort(), [
    "antnest.agent.id",
    "antnest.agent_id",
    "antnest.organization.id",
    "antnest.organization_id",
    "antnest.principal.id",
    "reason",
    "source",
  ]);
  assert.deepEqual(attributes, {
    "reason": "access_denied",
    "source": "agent-execution-state",
    "antnest.agent.id": "agent-1",
    "antnest.organization.id": "org-1",
    "antnest.principal.id": "user-1",
    "antnest.agent_id": "agent-1",
    "antnest.organization_id": "org-1",
  });
});

for (const value of ["false", " false ", "FALSE"]) {
  test(`legacy alias switch ${JSON.stringify(value)} emits canonical keys only`, async (t) => {
    const legacy = process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
    process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES = value;
    const { exporter, provider } = installRecorder();
    t.after(() => teardown(provider, legacy));
    const telemetry = await telemetryModule.startBridgeTelemetry({
      disabled: false,
      serviceName: "names-test",
    });
    await telemetry.observeHttp("GET", "/events", async () => {
      telemetryModule.captureStreamTermination(scope)(cause());
      return 200;
    });
    await provider.forceFlush();
    const events = terminationEvents(exporter);
    assert.equal(events.length, 1);
    const attributes = events[0]!.attributes!;
    assert.deepEqual(Object.keys(attributes).sort(), [
      "antnest.agent.id",
      "antnest.organization.id",
      "antnest.principal.id",
      "reason",
      "source",
    ]);
    assert.deepEqual(attributes, {
      "antnest.agent.id": "agent-1",
      "antnest.organization.id": "org-1",
      "antnest.principal.id": "user-1",
      "reason": "access_denied",
      "source": "agent-execution-state",
    });
  });
}

test("foreign principal, duplicate and post-finish callbacks never emit", async (t) => {
  const legacy = process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
  const { exporter, provider } = installRecorder();
  t.after(() => teardown(provider, legacy));
  const telemetry = await telemetryModule.startBridgeTelemetry({
    disabled: false,
    serviceName: "names-test",
  });
  let recorder: ((value: unknown) => void) | undefined;
  await telemetry.observeHttp("GET", "/events", async () => {
    recorder = telemetryModule.captureStreamTermination(scope);
    recorder!(cause({ principalId: "attacker" }));
    recorder!(cause());
    recorder!(cause());
    return 200;
  });
  recorder!(cause());
  await provider.forceFlush();
  assert.equal(terminationEvents(exporter).length, 1);
});
