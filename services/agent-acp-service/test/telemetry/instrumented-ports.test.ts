import { describe, expect, it, vi } from "vitest";

import {
  InstrumentedAcpApplication,
  InstrumentedModel,
} from "../../src/telemetry/instrumented-ports.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { TelemetryAttributes, TelemetryPort } from "../../src/ports/telemetry.js";
import { AgentControllerError } from "../../src/ports/agent-controller.js";
import { binding, snapshot } from "../support/fixtures.js";

describe("instrumented ports", () => {
  it("records ACP admission and terminal Run outcomes with bounded metric labels", async () => {
    const telemetry = recordingTelemetry();
    const delegate = acpApplication();
    const application = new InstrumentedAcpApplication(delegate, telemetry.port);

    const accepted = await application.acceptPrompt({
      binding: binding(),
      sessionId: "session-1",
      prompt: [{ type: "text", text: "secret prompt" }],
    });
    await application.executeRun({
      accepted,
      publish: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "accepted" },
      value: 1,
    });
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.runs",
      attributes: { terminal_class: "completed" },
      value: 1,
    });
    const duration = telemetry.durations.find(
      (candidate) => candidate.name === "antnest.acp.run.duration",
    );
    expect(duration?.attributes).toEqual({ terminal_class: "completed" });
    expect(duration?.milliseconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(telemetry)).not.toContain("secret prompt");
  });

  it("records a bounded admission rejection class", async () => {
    const telemetry = recordingTelemetry();
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.reject(new AgentControllerError("agent_rebuilding", "Agent is rebuilding", true)),
    );
    const delegate: AcpApplicationPort = { ...acpApplication(), acceptPrompt };
    const application = new InstrumentedAcpApplication(delegate, telemetry.port);

    await expect(
      application.acceptPrompt({
        binding: binding(),
        sessionId: "session-1",
        prompt: [{ type: "text", text: "secret prompt" }],
      }),
    ).rejects.toMatchObject({ code: "agent_rebuilding" });

    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "rejected", rejection_class: "agent_rebuilding" },
      value: 1,
    });
  });

  it("collapses an unexpected Controller code before writing metric labels", async () => {
    const telemetry = recordingTelemetry();
    const failure = new AgentControllerError(
      "agent_rebuilding",
      "Agent Controller violated its contract",
      true,
    );
    Object.defineProperty(failure, "code", { value: "unbounded_remote_code" });
    const delegate: AcpApplicationPort = {
      ...acpApplication(),
      acceptPrompt: vi.fn(() => Promise.reject(failure)),
    };
    const application = new InstrumentedAcpApplication(delegate, telemetry.port);

    await expect(
      application.acceptPrompt({
        binding: binding(),
        sessionId: "session-1",
        prompt: [{ type: "text", text: "prompt" }],
      }),
    ).rejects.toBe(failure);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "rejected", rejection_class: "dependency_unavailable" },
      value: 1,
    });
  });

  it("does not expose model credentials to telemetry", async () => {
    const telemetry = recordingTelemetry();
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const delegate: ModelPort = {
      complete,
    };
    const model = new InstrumentedModel(delegate, telemetry.port);

    await model.complete({
      snapshot: snapshot(),
      credential: "provider-secret",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(telemetry)).not.toContain("provider-secret");
  });
});

function acpApplication(): AcpApplicationPort {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    resumeSession: vi.fn(),
    closeSession: vi.fn(),
    cancelRun: vi.fn(),
    acceptPrompt: vi.fn(() =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "message-1",
        snapshot: snapshot(),
      }),
    ),
    executeRun: vi.fn<AcpApplicationPort["executeRun"]>(() =>
      Promise.resolve({
        terminalClass: "completed",
        executorState: "quiescent",
        runtimeEffectState: "settled",
      }),
    ),
  };
}

function recordingTelemetry(): {
  port: TelemetryPort;
  spans: Array<{ name: string; attributes: TelemetryAttributes }>;
  counts: Array<{ name: string; attributes: TelemetryAttributes; value: number }>;
  durations: Array<{ name: string; attributes: TelemetryAttributes; milliseconds: number }>;
} {
  const spans: Array<{ name: string; attributes: TelemetryAttributes }> = [];
  const counts: Array<{ name: string; attributes: TelemetryAttributes; value: number }> = [];
  const durations: Array<{ name: string; attributes: TelemetryAttributes; milliseconds: number }> =
    [];
  return {
    spans,
    counts,
    durations,
    port: {
      span: <Result>(
        name: string,
        attributes: TelemetryAttributes,
        operation: () => Promise<Result>,
      ) => {
        spans.push({ name, attributes });
        return operation();
      },
      count: (name, attributes, value = 1) => counts.push({ name, attributes, value }),
      duration: (name, milliseconds, attributes) =>
        durations.push({ name, milliseconds, attributes }),
      log: () => undefined,
    },
  };
}
