import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AgentSettlement } from "../../../../services/agent-acp-service/src/application/agent-settlement.js";
import { RunSupervisor } from "../../../../services/agent-acp-service/src/application/run-supervisor.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import type { AgentSettlementPort } from "../../../../services/agent-acp-service/src/ports/agent-settlement.js";
import type { RuntimeProtectionRepository } from "../../../../services/agent-acp-service/src/ports/execution-repository.js";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { localExecution } from "../../../../services/agent-acp-service/test/support/local-execution.js";

const route = "/rpc/agent-acp/settle-agent";
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
let server: AgentAcpHttpServer | undefined;
beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
afterEach(async () => {
  await server?.close();
  server = undefined;
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

const input = () => ({
  organization_id: "organization-1",
  agent_id: "agent-1",
  minimum_revision: 2,
  operation_id: "operation-1",
  mode: "wait",
  deadline_at: new Date(Date.now() + 1000).toISOString(),
});

async function listen(settlement?: AgentSettlementPort, ready = true) {
  const unexpected = () => Promise.reject(new Error("Unexpected ACP method"));
  const application: AcpApplicationPort = {
    assertAccess: unexpected,
    createSession: unexpected,
    listSessions: unexpected,
    resumeSession: unexpected,
    closeSession: unexpected,
    deleteSession: unexpected,
    forkSession: unexpected,
    cancelRun: unexpected,
    acceptPrompt: unexpected,
    readSessionOutput: unexpected,
    getSessionConfiguration: unexpected,
    setSessionConfiguration: unexpected,
  };
  server = new AgentAcpHttpServer({
    ...(settlement === undefined ? {} : { settlement }),
    application,
    ready: () => Promise.resolve(ready),
    maxConfigurationBytes: 2048,
    maxWebSocketPayloadBytes: 1024,
  });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}${route}`;
}

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("Agent settlement HTTP contract", () => {
  it.each([false, true])(
    "connects real local configuration and supervision, protected=%s",
    async (protectedRuntime) => {
      const local = await localExecution();
      const closed = executionConfiguration();
      closed.revision = 2;
      closed.agents[0]!.accepting_runs = false;
      closed.agents[0]!.operation_id = "operation-1";
      await local.directory.apply(closed);
      const settlement = new AgentSettlement({
        directory: local.directory,
        supervisor: new RunSupervisor({
          execute: () => Promise.reject(new Error("No execution expected")),
        }),
        learning: { closeForLifecycle: () => Promise.resolve(true) },
        protection: {
          hasUnstoppedRuntimeCalls: () => Promise.resolve(protectedRuntime),
        },
        now: () => new Date(),
      });
      const response = await post(await listen(settlement), input());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        applied_revision: 2,
        outcome: protectedRuntime ? "runtime_barrier_required" : "settled",
      });
    },
  );

  it.each([
    [
      new DomainError("agent_operation_conflict", "stale"),
      409,
      "agent_operation_conflict",
    ],
    [
      new DomainError("configuration_not_ready", "cold"),
      503,
      "settlement_unavailable",
    ],
    [
      new Error("private database connection detail"),
      503,
      "settlement_unavailable",
    ],
  ] as const)(
    "maps errors without inventing a settlement result: %s",
    async (error, status, code) => {
      const response = await post(
        await listen({ settle: () => Promise.reject(error) }),
        input(),
      );
      expect(response.status).toBe(status);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ code, retryable: status === 503 });
      expect(body).not.toHaveProperty("outcome");
      expect(JSON.stringify(body)).not.toContain(error.message);
    },
  );

  it.each([
    "invalid shape",
    "invalid JSON",
    "oversized",
    "encoded",
    "non JSON",
    "GET",
  ])("rejects %s before settlement", async (kind) => {
    const settle = vi
      .fn<AgentSettlementPort["settle"]>()
      .mockResolvedValue({ applied_revision: 2, outcome: "settled" });
    const url = await listen({ settle });
    const response = await fetch(url, {
      method: kind === "GET" ? "GET" : "POST",
      headers: {
        "content-type": kind === "non JSON" ? "text/plain" : "application/json",
        ...(kind === "encoded" ? { "content-encoding": "gzip" } : {}),
      },
      ...(kind === "GET"
        ? {}
        : {
            body:
              kind === "invalid JSON"
                ? "{"
                : kind === "oversized"
                  ? "x".repeat(2049)
                  : JSON.stringify({ ...input(), admission_id: "obsolete" }),
          }),
    });
    const expectedStatus = {
      "invalid shape": 400,
      "invalid JSON": 400,
      oversized: 413,
      encoded: 415,
      "non JSON": 415,
      GET: 405,
    }[kind];
    expect(response.status).toBe(expectedStatus);
    await response.text();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(["missing", "stopping"])(
    "reports %s service as unavailable",
    async (state) => {
      const settle = vi.fn<AgentSettlementPort["settle"]>();
      const response = await post(
        await listen(
          state === "missing" ? undefined : { settle },
          state !== "stopping",
        ),
        input(),
      );
      expect(response.status).toBe(503);
      await response.text();
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it.each(["service stopping", "caller disconnected"])(
    "cancels an active evidence read when %s without acknowledging success",
    async (cause) => {
      const local = await localExecution();
      const closed = executionConfiguration();
      closed.revision = 2;
      closed.agents[0]!.accepting_runs = false;
      closed.agents[0]!.operation_id = "operation-1";
      await local.directory.apply(closed);
      const entered = Promise.withResolvers<AbortSignal>();
      const evidence = Promise.withResolvers<boolean>();
      const finished = Promise.withResolvers<void>();
      const read: RuntimeProtectionRepository["hasUnstoppedRuntimeCalls"] = (
        _scope,
        signal,
      ) => {
        if (signal === undefined) throw new Error("Missing read cancellation");
        const cancel = () => evidence.reject(new Error("Read cancelled"));
        signal.addEventListener("abort", cancel, { once: true });
        entered.resolve(signal);
        return evidence.promise.finally(() => {
          signal.removeEventListener("abort", cancel);
          finished.resolve();
        });
      };
      const supervisor = new RunSupervisor({
        execute: () => Promise.reject(new Error("No Run expected")),
      });
      const settlement = new AgentSettlement({
        directory: local.directory,
        supervisor,
        learning: { closeForLifecycle: () => Promise.resolve(true) },
        protection: { hasUnstoppedRuntimeCalls: read },
        now: () => new Date(),
      });
      const caller = new AbortController();
      const response = post(
        await listen(settlement),
        {
          ...input(),
          deadline_at: new Date(Date.now() + 5000).toISOString(),
        },
        {},
        caller.signal,
      );
      const observed = response.catch((error: unknown) => error);
      try {
        const signal = await entered.promise;
        if (cause === "service stopping") {
          supervisor.stop(new Error("Worker ownership lost during request"));
          const result = await response;
          expect(result.status).toBe(503);
          const body: unknown = await result.json();
          expect(body).toMatchObject({ code: "settlement_unavailable" });
          expect(body).not.toHaveProperty("outcome");
        } else {
          caller.abort(new Error("Caller left"));
          expect(await observed).toBeInstanceOf(Error);
        }
        await finished.promise;
        expect(signal.aborted).toBe(true);
      } finally {
        caller.abort();
        evidence.resolve(false);
        await observed;
        await supervisor.shutdown();
      }
    },
  );

  it("records one caller-child RPC span and bounded protocol data without business spans", async () => {
    configureBoundaries({ captureRpcContent: true, disabled: false });
    const request = input();
    const result = { applied_revision: 2, outcome: "settled" as const };
    const url = await listen({ settle: () => Promise.resolve(result) });
    const parent = provider
      .getTracer("test")
      .startSpan("controller-rpc-client");
    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), parent), carrier);
    const response = await post(url, request, carrier);
    await response.text();
    parent.end();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(2));
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.attributes["rpc.method"] === "settle_agent");
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span?.attributes["http.route"]).toBe(route);
    expect(
      span?.events.find((event) => event.name === "antnest.request")
        ?.attributes?.["antnest.payload.json"],
    ).toBe(JSON.stringify(request));
    expect(
      span?.events.find((event) => event.name === "antnest.response")
        ?.attributes?.["antnest.payload.json"],
    ).toBe(JSON.stringify(result));
  });
});
