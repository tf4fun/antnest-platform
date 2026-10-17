import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { AgentAccessRevokedError } from "../src/adapters/acp-http.ts";
import type { AcpBridgePort } from "../src/bridge/agent-owner.ts";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";
import { startBridgeTelemetry } from "../src/telemetry.ts";
import { TestRequest } from "./support/auth-fixture.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const url = "http://localhost/api/app/workspace/v1/agents/agent-1/view";
const headers = { "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
const port = (overrides: Partial<AcpBridgePort> = {}): AcpBridgePort => ({
  async readAgentExecutionState() { return { availability: "ready", activeSessionId: null }; },
  async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
  async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
    activeRunId: null, recentReceipts: [], configurationRevision: null }; },
  async readIntent() { return { kind: "unknown" }; },
  async prompt() {}, async cancel() {}, close() {}, ...overrides,
});

test("Agent view failures retain their boundary and bounded safe causes without changing responses", async (t) => {
  const received: unknown[] = [];
  const collector = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    if (request.url === "/v1/traces") received.push(JSON.parse(Buffer.concat(parts).toString()));
    response.writeHead(200).end();
  });
  t.after(async () => {
    collector.closeAllConnections();
    if (collector.listening) await new Promise<void>((resolve, reject) =>
      collector.close((error) => error ? reject(error) : resolve()));
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  assert(address && typeof address !== "string");
  const telemetry = await startBridgeTelemetry({ disabled: false,
    endpoint: new URL(`http://127.0.0.1:${address.port}`), serviceName: "agent-ui-failure-test" });
  const secret = "private-cookie-token-and-remote-response";
  const cyclic = new Error(secret);
  cyclic.cause = cyclic;
  const hostile = Object.defineProperty(new Error(), "message", {
    get() { throw new Error(secret); },
  });
  const scenarios = [
    { name: "owner", stage: "owner", code: "caller_context_invalid", status: 503,
      connect: async () => { throw new Error("caller_context_invalid"); } },
    { name: "read", stage: "view", code: "unknown", status: 503,
      connect: async () => port({ async readAgentExecutionState() { throw new Error(secret); } }) },
    { name: "denied", stage: "view", code: "agent_access_revoked", status: 403,
      connect: async () => port({ async readAgentExecutionState() { throw new AgentAccessRevokedError(); } }) },
    { name: "cycle", stage: "owner", code: "unknown", status: 503,
      connect: async () => { throw cyclic; } },
    { name: "large", stage: "owner", code: "unknown", status: 503,
      connect: async () => { throw new AggregateError(Array.from({ length: 40 }, () => new Error(secret)), secret); } },
    { name: "non-error", stage: "owner", code: "unknown", status: 503,
      connect: async () => { throw undefined; } },
    { name: "hostile", stage: "owner", code: "classification_failed", status: 503,
      connect: async () => { throw hostile; } },
  ];
  const expected = new Map<string, { stage: string; code: string; bounded?: boolean }>();
  const runtimes: ReturnType<typeof createWorkspaceRuntime>[] = [];
  let sequence = 0;
  const read = async (runtime: ReturnType<typeof createWorkspaceRuntime>, name: string) => {
    const traceId = (++sequence).toString(16).padStart(32, "0");
    let response: Response | null = null;
    await telemetry.observeHttp("GET", `/fixture/${name}`, async () => {
      response = await runtime.handle(new TestRequest(url, { headers }));
      return response!.status;
    }, { traceparent: `00-${traceId}-1111111111111111-01` });
    return { traceId, response: response as Response | null };
  };
  try {
    for (const scenario of scenarios) {
      const runtime = createWorkspaceRuntime({ connect: scenario.connect });
      runtimes.push(runtime);
      const { response, traceId } = await read(runtime, scenario.name);
      assert.equal(response?.status, scenario.status);
      assert(!JSON.stringify(await response?.json()).includes(secret));
      expected.set(traceId, { stage: scenario.stage, code: scenario.code,
        ...(scenario.name === "large" ? { bounded: true } : {}) });
    }

    let endSdk!: () => void;
    const sdkClosed = new Promise<void>((resolve) => { endSdk = resolve; });
    let connections = 0;
    const runtime = createWorkspaceRuntime({ connect: async () => {
      connections++;
      return port({ closed: sdkClosed, close() {
        throw new AggregateError([new Error("ACP DELETE cleanup failed")], "ACP cleanup failed");
      } });
    } });
    runtimes.push(runtime);
    assert.equal((await read(runtime, "warm")).response?.status, 200);
    endSdk();
    await turn();
    const failed = await read(runtime, "retirement");
    assert.equal(failed.response?.status, 503, "real old-owner cleanup failure remains unavailable");
    assert.equal(connections, 1, "a failed cleanup must not be bypassed by creating another owner");
    expected.set(failed.traceId, { stage: "owner", code: "acp_delete_failed" });
  } finally {
    const failures: unknown[] = [];
    for (const runtime of runtimes) {
      try { await runtime.drain(100); } catch (error) { failures.push(error); }
    }
    try { await telemetry.shutdown(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "diagnostic fixture cleanup failed");
  }
  const spans = (received as any[]).flatMap((batch) => batch.resourceSpans.flatMap(
    (resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  for (const [traceId, wanted] of expected) {
    const span = spans.find((value: any) => value.traceId === traceId);
    assert(span, traceId);
    const events = (span.events ?? []).filter((event: any) => event.name === "antnest.ui.agent_view.failure");
    assert.equal(events.length, 1, `missing exact Agent view failure boundary: ${wanted.stage}/${wanted.code}`);
    const values = Object.fromEntries(events[0].attributes.map((attribute: any) => [attribute.key, attribute.value]));
    assert.equal(values.stage.stringValue, wanted.stage);
    const causes = values.causes.arrayValue.values.map((value: any) => value.stringValue);
    assert(causes.includes(wanted.code), JSON.stringify(causes));
    assert(causes.length <= 16, "failure traversal must be bounded");
    if (wanted.bounded) assert.equal(values.truncated.boolValue, true);
    assert(!JSON.stringify(events).includes(secret), "private exception content must not enter telemetry");
    assert(!JSON.stringify(events).includes("user-1"));
    assert(!JSON.stringify(events).includes("agent-1"));
  }
});
