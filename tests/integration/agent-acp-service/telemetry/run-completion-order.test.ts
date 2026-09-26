import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { context, propagation, trace, type Span } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import {
  AcpApplication,
  type AcpApplicationDependencies,
} from "../../../../services/agent-acp-service/src/application/application.js";
import { RunExecutor } from "../../../../services/agent-acp-service/src/application/run-executor.js";
import { RunSupervisor } from "../../../../services/agent-acp-service/src/application/run-supervisor.js";
import type { RunEventRepository } from "../../../../services/agent-acp-service/src/ports/run-event-repository.js";
import type {
  SessionEvent,
  SessionOutputSnapshot,
  SubmittedAcpRun,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  InstrumentedAcpApplication,
  InstrumentedRunExecutor,
} from "../../../../services/agent-acp-service/src/telemetry/instrumented-ports.js";
import { ServiceTelemetry } from "../../../../services/agent-acp-service/src/telemetry/telemetry.js";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { SessionOutputStreams } from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";
import { createAcpV1Agent } from "../../../../services/agent-acp-service/src/transport/acp/v1/agent.js";
import { createAcpV2Agent } from "../../../../services/agent-acp-service/src/transport/acp/v2/agent.js";
import {
  binding,
  sessionConfigurationView,
  snapshot,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

it.each(["v1", "v2"] as const)(
  "%s preserves durable completion and Agent ownership after its admission span ends",
  async (version) => {
    const test = setup();
    const updates: string[] = [];
    const idle = Promise.withResolvers<void>();
    let idleReceived = false;
    const observe = (update: { sessionUpdate: string; state?: string }) => {
      updates.push(update.sessionUpdate);
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        idleReceived = true;
        idle.resolve();
      }
    };
    const options = {
      binding: test.identity,
      application: test.application,
      outputs: test.outputs,
      promptCapabilities: { image: false, embeddedContext: false },
    };

    const check = async (request: () => Promise<unknown>) => {
      let replied = false;
      const response = request().then((result) => {
        replied = true;
        return result;
      });
      // Observe any protocol rejection immediately, including during cleanup.
      void response.catch(() => undefined);
      await test.messageEntered.promise;
      await vi.waitFor(() => expect(test.submitted()).toBeDefined());
      expect(test.supervisor.occupancy(test.identity).busy).toBe(true);
      expect(test.runSpan()?.isRecording()).toBe(true);
      expect(
        exporter
          .getFinishedSpans()
          .some((s) => s.name === "acp.session.prompt"),
      ).toBe(true);
      expect(test.finish).not.toHaveBeenCalled();
      expect(test.events).toHaveLength(0);
      expect(idleReceived).toBe(false);

      if (version === "v2")
        await expect(response).resolves.toEqual({ messageId: "user-1" });
      else expect(replied).toBe(false);

      test.allowMessage.resolve();
      await test.terminalEntered.promise;
      const submitted = test.submitted()!;
      let completed = false;
      void submitted.completion.then(() => {
        completed = true;
      });
      let cancelled = false;
      const cancellation = test.supervisor.cancel("session-1").then(() => {
        cancelled = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(cancelled).toBe(false);
      expect(test.supervisor.occupancy(test.identity).busy).toBe(true);
      expect(test.runSpan()?.isRecording()).toBe(true);
      expect(test.state()).toEqual({ kind: "state", state: "running" });
      expect(idleReceived).toBe(false);
      if (version === "v1") expect(replied).toBe(false);

      test.allowTerminal.resolve();
      await expect(submitted.completion).resolves.toMatchObject({
        terminalClass: "completed",
      });
      await cancellation;
      await expect(response).resolves.toEqual(
        version === "v1" ? { stopReason: "end_turn" } : { messageId: "user-1" },
      );
      if (version === "v2") await idle.promise;
      expect(test.supervisor.occupancy(test.identity).busy).toBe(false);
      expect(test.runSpan()?.isRecording()).toBe(false);
      expect(updates).toContain(
        version === "v1" ? "agent_message_chunk" : "agent_message",
      );
      expect(test.order).toEqual(["message committed", "terminal committed"]);
      const spans = exporter.getFinishedSpans();
      const run = spans.find((s) => s.name === "agent.run")!;
      const admission = spans.find((s) => s.name === "acp.session.prompt")!;
      const reads = spans.filter((s) => s.name === "acp.session.output");
      const rpc = spans.find((s) => s.name === "acp session/prompt")!;
      expect(run.spanContext().traceId).toBe(rpc.spanContext().traceId);
      expect(admission.spanContext().traceId).toBe(rpc.spanContext().traceId);
      expect(admission.attributes["antnest.operation.phase"]).toBe("admit");
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every((s) => s.attributes["antnest.operation.phase"] === "read"),
      ).toBe(true);
    };

    try {
      if (version === "v1") {
        const client = v1
          .client()
          .onNotification(v1.methods.client.session.update, ({ params }) =>
            observe(params.update),
          );
        await client.connectWith(
          createAcpV1Agent(options),
          async (connection) => {
            await connection.request(v1.methods.agent.initialize, {
              protocolVersion: v1.PROTOCOL_VERSION,
            });
            await check(() =>
              connection.request(v1.methods.agent.session.prompt, {
                sessionId: "session-1",
                prompt: [{ type: "text", text: "/help" }],
              }),
            );
          },
        );
      } else {
        const client = v2
          .client()
          .onNotification(v2.methods.client.session.update, ({ params }) =>
            observe(params.update),
          );
        await client.connectWith(
          createAcpV2Agent(options),
          async (connection) => {
            await connection.request(v2.methods.agent.initialize, {
              protocolVersion: v2.PROTOCOL_VERSION,
              info: { name: "completion-order", version: "1" },
            });
            await check(() =>
              connection.request(v2.methods.agent.session.prompt, {
                sessionId: "session-1",
                prompt: [{ type: "text", text: "/help" }],
              }),
            );
          },
        );
      }
    } finally {
      test.allowMessage.resolve();
      test.allowTerminal.resolve();
      await test.supervisor.shutdown();
      test.outputs.disconnect(test.identity.connectionId);
    }
  },
);

function setup() {
  const identity = binding();
  const outputs = new SessionOutputStreams();
  const telemetry = new ServiceTelemetry("agent-acp-service");
  const messageEntered = Promise.withResolvers<void>();
  const allowMessage = Promise.withResolvers<void>();
  const terminalEntered = Promise.withResolvers<void>();
  const allowTerminal = Promise.withResolvers<void>();
  const events: SessionEvent[] = [];
  const order: string[] = [];
  let state: SessionOutputSnapshot["state"] = {
    kind: "state",
    state: "running",
  };
  let runSpan: Span | undefined;
  let submitted: SubmittedAcpRun | undefined;
  const finish = vi.fn(async () => {
    terminalEntered.resolve();
    await allowTerminal.promise;
    state = { kind: "state", state: "idle", stopReason: "end_turn" };
    order.push("terminal committed");
  });
  const appendAgentMessage: RunEventRepository["appendAgentMessage"] = async (
    input,
  ) => {
    runSpan = trace.getSpan(context.active());
    messageEntered.resolve();
    await allowMessage.promise;
    const event = {
      kind: "agent_message" as const,
      messageId: input.id,
      content: input.content,
    };
    events.push(event);
    order.push("message committed");
    return event;
  };
  const supervisor = new RunSupervisor(
    new InstrumentedRunExecutor(
      new RunExecutor({
        executions: { finish, getState: vi.fn(), listRecoveryWork: vi.fn() },
        events: {
          appendAgentMessage,
          appendAgentThought: vi.fn(),
          appendUsage: vi.fn(),
          appendPlan: vi.fn(),
          appendToolProgress: vi.fn(),
          appendRejectedToolCall: vi.fn(),
          startToolAttempt: vi.fn(),
          finishToolAttempt: vi.fn(),
          interruptToolAttempts: vi.fn(),
        },
        providers: { acquire: vi.fn() },
        contextBuilder: { build: vi.fn() },
        tools: { list: vi.fn(), call: vi.fn() },
        ownershipSignal: new AbortController().signal,
        recoveryRequired: vi.fn(),
        now: () => new Date("2026-08-30T00:00:00Z"),
        id: () => "answer-1",
      }),
      telemetry,
    ),
  );
  const application = new InstrumentedAcpApplication(
    new AcpApplication({
      access: { assert: vi.fn().mockResolvedValue(undefined) },
      configuration: {
        get: vi.fn().mockResolvedValue(sessionConfigurationView()),
        set: vi.fn(),
      },
      sessions: {
        createSession: vi.fn(),
        listSessions: vi.fn(),
        deleteSession: vi.fn(),
        forkSession: vi.fn(),
        resumeSession: vi.fn(),
        closeSession: vi.fn(),
        requestCancellation: vi.fn(),
        requestTargetCancellation: vi.fn().mockResolvedValue(false),
        requirePromptSession: vi.fn().mockResolvedValue(undefined),
        readOutput: vi.fn<AcpApplicationDependencies["sessions"]["readOutput"]>(
          ({ afterSequence }) =>
            Promise.resolve({
              sequence: events.length,
              events:
                afterSequence === undefined ? [] : events.slice(afterSequence),
              state,
            }),
        ),
      },
      prompts: {
        checkBridgeIntent: vi.fn().mockResolvedValue(undefined),
        accept: vi.fn().mockResolvedValue({
          outputSequence: 0,
          runId: "run-1",
          requestId: "request-1",
          sessionId: "session-1",
          userMessageId: "user-1",
          command: { name: "help", locale: "en" },
          snapshot: snapshot(),
        }),
      },
      runs: supervisor,
    }),
    telemetry,
  );
  const acceptPrompt = application.acceptPrompt.bind(application);
  vi.spyOn(application, "acceptPrompt").mockImplementation(async (input) => {
    submitted = await acceptPrompt(input);
    return submitted;
  });
  return {
    identity,
    application,
    outputs,
    supervisor,
    messageEntered,
    allowMessage,
    terminalEntered,
    allowTerminal,
    finish,
    events,
    order,
    state: () => state,
    runSpan: () => runSpan,
    submitted: () => submitted,
  };
}
