import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { getEventListeners } from "node:events";
import { serveAgentExecutionState } from "../../src/transport/agent-execution-state.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentExecutionState } from "../../src/application/agent-execution-state.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { ExecuteRunResult } from "../../src/ports/acp-application.js";
import { configureBoundaries } from "../../src/telemetry/diagnostics.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { identityHeaders, snapshot } from "../support/fixtures.js";
import { localExecution } from "../support/local-execution.js";

const watchPath = "/rpc/agent-acp/watch-agent-execution-state";
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => provider.register({ propagator: new core.W3CTraceContextPropagator() }));
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
  const protection = { hasUnstoppedRuntimeCalls: vi.fn().mockResolvedValue(false) };
  const service = new AgentExecutionState({ directory: local.directory, supervisor, protection });
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

describe("workspace state HTTP and SSE", () => {
  it.each([false, true])(
    "bounds revocation delivery when write returns %s but the socket cannot flush",
    async (writable) => {
      const local = await localState();
      const request = new IncomingMessage(new Socket());
      request.method = "POST";
      request.url = watchPath;
      request.headers = { ...identityHeaders(), "content-type": "application/json" };
      request.push(Buffer.from("{}"));
      request.push(null);
      const response = new ServerResponse(request);
      const write = vi.spyOn(response, "write").mockReturnValue(writable);
      vi.spyOn(response, "end").mockReturnValue(response);
      const task = serveAgentExecutionState(
        request,
        response,
        local.service,
        1024,
        () => Promise.resolve(true),
        50,
      );
      const observed = task.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(write).toHaveBeenCalledOnce(), { interval: 1 });
        await local.directory.apply({ ...executionConfiguration(), revision: 2, agents: [] });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { interval: 1 });
        await vi.waitFor(() => expect(response.destroyed).toBe(true));
        await observed;
        expect(getEventListeners(response, "drain")).toHaveLength(0);
        expect(getEventListeners(response, "close")).toHaveLength(0);
        expect(getEventListeners(response, "finish")).toHaveLength(0);
      } finally {
        response.destroy();
        request.destroy();
        await observed;
      }
    },
  );
});
