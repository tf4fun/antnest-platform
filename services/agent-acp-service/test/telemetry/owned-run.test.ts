import { describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import { InstrumentedRunExecutor } from "../../src/telemetry/instrumented-ports.js";
import type { TelemetryAttributes, TelemetryPort } from "../../src/ports/telemetry.js";
import { binding, snapshot } from "../support/fixtures.js";

describe("application-owned Run instrumentation", () => {
  it.each(["completed", "failed"] as const)(
    "records %s execution without a transport start callback",
    async (terminalClass) => {
      const recorded = recorder();
      const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue(
        terminalClass === "completed"
          ? {
              terminalClass,
              executorState: "quiescent",
              toolEffectState: "none",
              stopReason: "end_turn",
            }
          : {
              terminalClass,
              executorState: "quiescent",
              toolEffectState: "none",
              errorClass: "model_failed",
            },
      );
      const supervisor = new RunSupervisor(new InstrumentedRunExecutor({ execute }, recorded.port));
      const run = await supervisor.submit(
        { binding: binding(), sessionId: "session-1", outputChanged: vi.fn() },
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
      await run.completion;
      expect(recorded.spans).toHaveLength(1);
      expect(recorded.spans[0]?.name).toBe("agent.run");
      expect(recorded.spans[0]?.attributes).toMatchObject({
        "run.id": "run-1",
        "session.id": "session-1",
        "organization.id": "organization-1",
      });
      expect(recorded.count).toHaveBeenCalledWith("antnest.acp.runs", {
        terminal_class: terminalClass,
      });
      expect(recorded.duration).toHaveBeenCalledWith(
        "antnest.acp.run.duration",
        expect.any(Number),
        { terminal_class: terminalClass },
      );
      expect(JSON.stringify(recorded.spans)).not.toMatch(/admission|credential/);
    },
  );

  it("observes persistence failure in the execution span and still rejects completion", async () => {
    const recorded = recorder();
    const failure = new Error("terminal write failed");
    const executor = new InstrumentedRunExecutor(
      { execute: vi.fn().mockRejectedValue(failure) },
      recorded.port,
    );
    await expect(
      executor.execute({
        accepted: {
          runId: "run-1",
          sessionId: "session-1",
          requestId: "request-1",
          userMessageId: "message-1",
          outputSequence: 0,
          snapshot: snapshot(),
        },
        publish: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(recorded.count).toHaveBeenCalledWith("antnest.acp.runs", {
      terminal_class: "executor_error",
    });
    expect(recorded.duration).toHaveBeenCalledWith("antnest.acp.run.duration", expect.any(Number), {
      terminal_class: "executor_error",
    });
  });
});

function recorder() {
  const spans: Array<{ name: string; attributes: TelemetryAttributes }> = [];
  const count = vi.fn();
  const duration = vi.fn();
  const port: TelemetryPort = {
    span: <T>(name: string, attributes: TelemetryAttributes, run: () => Promise<T>) => {
      spans.push({ name, attributes });
      return run();
    },
    count,
    duration,
    log: vi.fn(),
  };
  return { spans, count, duration, port };
}
