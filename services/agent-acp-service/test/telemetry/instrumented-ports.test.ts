import { describe, expect, it, vi } from "vitest";

import {
  InstrumentedAcpApplication,
  InstrumentedModel,
  InstrumentedRuntimeInformation,
  InstrumentedToolCatalog,
} from "../../src/telemetry/instrumented-ports.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import type { AuthenticatedModelTransport } from "../../src/ports/model.js";
import type { ToolCallResult, ToolCatalogPort } from "../../src/ports/tools.js";
import type { TelemetryAttributes, TelemetryPort } from "../../src/ports/telemetry.js";
import { DomainError } from "../../src/domain/errors.js";
import { binding, snapshot, sessionConfigurationView } from "../support/fixtures.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";

describe("instrumented ports", () => {
  it("traces local Session configuration without exporting selections", async () => {
    const telemetry = recordingTelemetry();
    const delegate = acpApplication();
    const application = new InstrumentedAcpApplication(delegate, telemetry.port);
    await application.getSessionConfiguration({ binding: binding(), sessionId: "session-1" });
    await application.setSessionConfiguration({
      binding: binding(),
      sessionId: "session-1",
      configId: "model",
      value: "private-selection",
    });
    expect(telemetry.spans.map(({ name }) => name)).toEqual([
      "acp.session.get_configuration",
      "acp.session.set_configuration",
    ]);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.session_methods",
      attributes: { method: "set_configuration", result: "ok" },
      value: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("private-");
  });
  it("passes file observations to the caller without exporting them to telemetry", async () => {
    const telemetry = recordingTelemetry();
    const log = vi.spyOn(telemetry.port, "log");
    const result: ToolCallResult = {
      content: [{ type: "text", text: "written" }],
      isError: false,
      toolEffectState: "settled",
      file: {
        path: "/workspace/private-file",
        change: { before: "private-before", after: "private-after" },
      },
    };
    const call = vi.fn<ToolCatalogPort["call"]>().mockResolvedValue(result);
    const catalog = new InstrumentedToolCatalog({ list: vi.fn(), call }, telemetry.port);
    expect(
      await catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Write",
          inputSchema: { type: "object" },
        },
        arguments: { path: "private-file", content: "private-after" },
        signal: new AbortController().signal,
      }),
    ).toBe(result);
    expect(call).toHaveBeenCalledOnce();
    expect(telemetry.spans).toContainEqual({
      name: "mcp.tools.call",
      attributes: {
        "run.id": "run-1",
        "organization.id": "organization-1",
        "tool.name": "write",
        "mcp.source_id": "runtime",
      },
    });
    expect(JSON.stringify({ telemetry, logs: log.mock.calls })).not.toContain("private-");
  });

  it("traces Runtime information reads without exporting guidance or Skill content", async () => {
    const telemetry = recordingTelemetry();
    const reader = new InstrumentedRuntimeInformation(
      { read: vi.fn().mockResolvedValue(runtimeInformation()) },
      telemetry.port,
    );
    await reader.read(snapshot(), new AbortController().signal);
    expect(telemetry.spans).toContainEqual({
      name: "mcp.runtime.info",
      attributes: { "organization.id": "organization-1", "execution.revision": "execution-1" },
    });
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.mcp.requests",
      attributes: { operation: "info", source: "runtime", result: "ok" },
      value: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("company style guide");
    expect(JSON.stringify(telemetry)).not.toContain("documents/SKILL.md");
  });
  it("records local Run submission without embedding execution in the protocol wrapper", async () => {
    const telemetry = recordingTelemetry();
    const application = new InstrumentedAcpApplication(acpApplication(), telemetry.port);
    const submitted = await application.acceptPrompt({
      binding: binding(),
      sessionId: "session-1",
      prompt: [{ type: "text", text: "secret prompt" }],
      outputChanged: vi.fn(),
    });
    await submitted.completion;
    expect(telemetry.spans).toContainEqual({
      name: "acp.session.prompt",
      attributes: {
        "agent.id": "agent-1",
        "session.id": "session-1",
        "antnest.operation.phase": "admit",
      },
    });
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "accepted" },
      value: 1,
    });
    expect("executeRun" in application).toBe(false);
    expect(JSON.stringify(telemetry)).not.toContain("secret prompt");
  });

  it("labels output observation as a durable snapshot read", async () => {
    const telemetry = recordingTelemetry();
    const application = new InstrumentedAcpApplication(acpApplication(), telemetry.port);
    await application.readSessionOutput({ binding: binding(), sessionId: "session-1" });
    expect(telemetry.spans).toContainEqual({
      name: "acp.session.output",
      attributes: {
        "agent.id": "agent-1",
        "session.id": "session-1",
        "antnest.operation.phase": "read",
      },
    });
  });

  it("records a bounded admission rejection class", async () => {
    const telemetry = recordingTelemetry();
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.reject(new DomainError("agent_unavailable", "Agent is rebuilding")),
    );
    const delegate: AcpApplicationPort = { ...acpApplication(), acceptPrompt };
    const application = new InstrumentedAcpApplication(delegate, telemetry.port);

    await expect(
      application.acceptPrompt({
        binding: binding(),
        sessionId: "session-1",
        prompt: [{ type: "text", text: "secret prompt" }],
        outputChanged: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "agent_unavailable" });

    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "rejected", rejection_class: "agent_unavailable" },
      value: 1,
    });
  });

  it("collapses an unregistered application code before writing metric labels", async () => {
    const telemetry = recordingTelemetry();
    const failure = new DomainError("unbounded_domain_code", "Unexpected application code");
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
        outputChanged: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.run_admissions",
      attributes: { result: "rejected", rejection_class: "internal_error" },
      value: 1,
    });
  });

  it("does not expose model credentials to telemetry", async () => {
    const telemetry = recordingTelemetry();
    const complete = vi.fn<AuthenticatedModelTransport["complete"]>(() =>
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const delegate: AuthenticatedModelTransport = {
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
    assertAccess: vi.fn(),
    getSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    setSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    resumeSession: vi.fn(),
    readSessionOutput: vi.fn(),
    closeSession: vi.fn(),
    cancelRun: vi.fn(),
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "message-1",
        snapshot: snapshot(),
        outputSequence: 0,
        completion: Promise.resolve({
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
        }),
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
