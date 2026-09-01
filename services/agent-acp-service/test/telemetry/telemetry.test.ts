import { describe, expect, it } from "vitest";

import { ServiceTelemetry, startTelemetry } from "../../src/telemetry/telemetry.js";

describe("ServiceTelemetry", () => {
  it("keeps structured logs useful without leaking error messages or undefined fields", () => {
    const lines: string[] = [];
    const telemetry = new ServiceTelemetry("test-service", (line) => lines.push(line));
    const error = Object.assign(new Error("credential-do-not-log"), { code: "dependency_failed" });

    telemetry.log(
      "error",
      "model_request_failed",
      { "agent.id": "agent-1", omitted: undefined },
      error,
    );

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      level: "error",
      event: "model_request_failed",
      service: "test-service",
      "agent.id": "agent-1",
      error_type: "Error",
      error_code: "dependency_failed",
    });
    expect(payload).not.toHaveProperty("omitted");
    expect(lines[0]).not.toContain("credential-do-not-log");
  });

  it("preserves operation results and failures through spans", async () => {
    const telemetry = new ServiceTelemetry("test-service", () => undefined);

    await expect(
      telemetry.span("agent.run", { "run.id": "run-1" }, () => Promise.resolve(42)),
    ).resolves.toBe(42);
    await expect(
      telemetry.span("agent.run", { "run.id": "run-2" }, () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
  });

  it("starts as a local no-export runtime when OTLP is disabled", async () => {
    const runtime = await startTelemetry({
      disabled: true,
      serviceName: "test-service",
      tracesEnabled: false,
      metricsEnabled: false,
    });

    runtime.telemetry.count("agent.runs", { terminal_class: "completed" });
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
