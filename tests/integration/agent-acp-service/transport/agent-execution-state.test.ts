import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { setTimeout as delay } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AgentExecutionState } from "../../../../services/agent-acp-service/src/application/agent-execution-state.js";
import { RunSupervisor } from "../../../../services/agent-acp-service/src/application/run-supervisor.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import type { AgentExecutionStatePort } from "../../../../services/agent-acp-service/src/ports/agent-execution-state.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  identityHeaders,
  snapshot,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { localExecution } from "../../../../services/agent-acp-service/test/support/local-execution.js";

const getPath = "/rpc/agent-acp/get-agent-execution-state";
const watchPath = "/rpc/agent-acp/watch-agent-execution-state";
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
async function localState(initialize = true) {
  const local = await localExecution(initialize);
  const completion = Promise.withResolvers<ExecuteRunResult>();
  const supervisor = new RunSupervisor({ execute: () => completion.promise });
  const protection = {
    hasUnstoppedRuntimeCalls: vi.fn().mockResolvedValue(false),
  };
  const service = new AgentExecutionState({
    directory: local.directory,
    supervisor,
    protection,
  });
  cleanups.push(async () => {
    completion.resolve(completed);
    await supervisor.shutdown();
  });
  const start = () =>
    supervisor.submit(
      {
        binding: { ...executionIdentity(), connectionId: "A" },
        sessionId: "session-1",
        outputChanged: () => undefined,
      },
      () =>
        Promise.resolve({
          runId: "run-1",
          sessionId: "session-1",
          requestId: "request-1",
          userMessageId: "message-1",
          outputSequence: 0,
          snapshot: snapshot(),
        }),
    );
  return { ...local, service, supervisor, protection, completion, start };
}

async function listen(
  executionState?: AgentExecutionStatePort,
  ready = true,
  stateDeliveryTimeoutMs = 10_000,
) {
  const unexpected = () =>
    Promise.reject(new Error("State queries cannot invoke ACP commands"));
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
  const server = new AgentAcpHttpServer({
    application,
    ...(executionState === undefined ? {} : { executionState }),
    ready: () => Promise.resolve(ready),
    maxWebSocketPayloadBytes: 1024,
    maxConfigurationBytes: 1024,
    stateDeliveryTimeoutMs,
  });
  await server.listen("127.0.0.1", 0);
  cleanups.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

function post(
  base: string,
  path = getPath,
  headers: Record<string, string> = identityHeaders(),
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

async function watch(base: string, headers = identityHeaders()) {
  const response = await post(base, watchPath, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (response.body === null) throw new Error("Missing state stream");
  const reader = response.body.getReader();
  const frames: EventSourceMessage[] = [];
  const parser = createParser({ onEvent: (event) => frames.push(event) });
  const decoder = new TextDecoder();
  const finished = (async () => {
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        chunk = await reader.read();
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const observed = finished.catch((error: unknown) => error);
  const close = async () => {
    if (response.body?.locked) await reader.cancel();
    await observed;
  };
  cleanups.push(close);
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
  return { frames, finished, close };
}

describe("workspace state HTTP and SSE", () => {
  it.each([getPath, watchPath])(
    "authorizes opaque identity locally at %s",
    async (path) => {
      const local = await localState(false);
      const identity = {
        organizationId: "org+division@example.org",
        principalId: "owner+team@example.org",
        agentId: "agent/department+1",
      };
      const configuration = executionConfiguration();
      configuration.organization_id = identity.organizationId;
      configuration.agents[0]!.agent_id = identity.agentId;
      configuration.agents[0]!.principal_ids = [identity.principalId];
      await local.directory.apply(configuration);
      const base = await listen(local.service);
      const headers = identityHeaders(identity);
      if (path === getPath) {
        const response = await post(base, path, headers);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          agent_id: identity.agentId,
          access_allowed: true,
          availability: "ready",
        });
      } else {
        const stream = await watch(base, headers);
        expect(JSON.parse(stream.frames[0]!.data)).toMatchObject({
          agent_id: identity.agentId,
          access_allowed: true,
          availability: "ready",
        });
        await stream.close();
      }
      const rejected = await post(
        base,
        path,
        identityHeaders({
          ...identity,
          principalId: "other+owner@example.org",
        }),
      );
      expect(rejected.status).toBe(200);
      const body = await rejected.text();
      expect(body).toContain('"access_allowed":false');
      expect(body).toContain('"configuration_revision":null');
      expect(body).not.toContain('"availability":"ready"');
    },
  );

  it("does not apply delivery deadlines to idle subscriptions", async () => {
    const local = await localState();
    const base = await listen(local.service, true, 20);
    const stream = await watch(base);
    let closed = false;
    void stream.finished.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    await delay(60);
    expect(closed).toBe(false);
    const run = await local.start();
    await vi.waitFor(() =>
      expect(JSON.parse(stream.frames.at(-1)!.data)).toMatchObject({
        availability: "busy",
      }),
    );
    local.completion.resolve(completed);
    await run.completion;
    await stream.close();
  });
  it("reads and reconnects to real local occupancy, then returns to idle without Controller calls", async () => {
    const local = await localState();
    const base = await listen(local.service);
    const ready = await post(base);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      availability: "ready",
      active_session_id: null,
    });
    const run = await local.start();
    const stream = await watch(base);
    expect(JSON.parse(stream.frames[0]!.data)).toMatchObject({
      availability: "busy",
      active_session_id: "session-1",
    });
    local.completion.resolve(completed);
    await run.completion;
    await vi.waitFor(() =>
      expect(JSON.parse(stream.frames.at(-1)!.data)).toMatchObject({
        availability: "ready",
        active_session_id: null,
      }),
    );
    expect(
      stream.frames.every((frame) => frame.event === "workspace_state"),
    ).toBe(true);
  });

  it("hides Session identity from authorized peers and clears revoked streams", async () => {
    const local = await localState();
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.principal_ids.push("peer");
    await local.directory.apply(next);
    await local.start();
    const base = await listen(local.service);
    const peer = await post(
      base,
      getPath,
      identityHeaders({ ...executionIdentity(), principalId: "peer" }),
    );
    expect(await peer.json()).toMatchObject({
      availability: "busy",
      active_session_id: null,
    });
    const stream = await watch(base);
    await local.directory.apply({ ...next, revision: 3, agents: [] });
    await stream.finished;
    expect(JSON.parse(stream.frames.at(-1)!.data)).toMatchObject({
      access_allowed: false,
      active_session_id: null,
      configuration_revision: null,
    });
  });

  it.each([getPath, watchPath])(
    "rejects missing identity and body overrides at %s",
    async (path) => {
      const read = vi.fn<AgentExecutionStatePort["read"]>();
      const streaming = vi.fn<AgentExecutionStatePort["watch"]>();
      const base = await listen({ read, watch: streaming });
      const anonymous = await post(base, path, {});
      expect(anonymous.status).toBe(401);
      await anonymous.text();
      const overridden = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...identityHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ agent_id: "other" }),
      });
      expect(overridden.status).toBe(400);
      await overridden.text();
      expect(read).not.toHaveBeenCalled();
      expect(streaming).not.toHaveBeenCalled();
    },
  );

  it.each([getPath, watchPath])(
    "does not fabricate state for cold configuration at %s",
    async (path) => {
      const local = await localState(false);
      const response = await post(await listen(local.service), path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "execution_state_unavailable",
        retryable: true,
      });
    },
  );

  it.each(["missing", "stopping"])(
    "fails when the state service is %s",
    async (cause) => {
      const local = await localState();
      const response = await post(
        await listen(
          cause === "missing" ? undefined : local.service,
          cause !== "stopping",
        ),
      );
      expect(response.status).toBe(503);
      await response.text();
    },
  );

  it("closes with a non-secret error frame after a running stream loses its state source", async () => {
    const local = await localState();
    const stream = await watch(await listen(local.service));
    local.onApplied.mockRejectedValueOnce(
      new Error("private publication detail"),
    );
    await expect(
      local.directory.apply({ ...executionConfiguration(), revision: 2 }),
    ).rejects.toThrow("private publication detail");
    await stream.finished;
    expect(stream.frames.at(-1)?.event).toBe("workspace_error");
    expect(JSON.parse(stream.frames.at(-1)!.data)).toMatchObject({
      code: "execution_state_unavailable",
    });
    expect(JSON.stringify(stream.frames)).not.toContain(
      "private publication detail",
    );
  });

  it("aborts and releases the state subscription when its HTTP client disconnects", async () => {
    const local = await localState();
    const released = Promise.withResolvers<void>();
    const delegate = local.service.watch.bind(local.service);
    const service: AgentExecutionStatePort = {
      read: local.service.read.bind(local.service),
      watch: (...args) => delegate(...args).finally(() => released.resolve()),
    };
    const stream = await watch(await listen(service));
    await stream.close();
    await released.promise;
  });

  it("emits a caller-child span but never captures stream payloads even when RPC capture is enabled", async () => {
    configureBoundaries({ captureRpcContent: true, disabled: false });
    const local = await localState();
    const base = await listen(local.service);
    const parent = provider.getTracer("test").startSpan("gateway-client");
    const carrier = identityHeaders();
    propagation.inject(trace.setSpan(context.active(), parent), carrier);
    const response = await post(base, getPath, carrier);
    const body: unknown = await response.json();
    const stream = await watch(base, carrier);
    local.supervisor.stop(new DomainError("service_stopping", "Stopping"));
    await stream.finished;
    parent.end();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(3));
    const spans = exporter.getFinishedSpans();
    const get = spans.find((span) => span.attributes["http.route"] === getPath);
    const streaming = spans.find(
      (span) => span.attributes["http.route"] === watchPath,
    );
    expect(get?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(streaming?.parentSpanContext?.spanId).toBe(
      parent.spanContext().spanId,
    );
    expect(
      get?.events.find((event) => event.name === "antnest.response")
        ?.attributes?.["antnest.payload.json"],
    ).toBe(JSON.stringify(body));
    expect(streaming?.attributes["rpc.method"]).toBe(
      "watch_agent_execution_state",
    );
    expect(
      streaming?.events.filter(
        (event) =>
          event.name === "antnest.request" || event.name === "antnest.response",
      ),
    ).toEqual([]);
    const captured = JSON.stringify({
      attributes: streaming?.attributes,
      events: streaming?.events,
    });
    expect(captured).not.toContain("configuration_revision");
    expect(captured).not.toContain("synthetic-provider-key");
  });
});
