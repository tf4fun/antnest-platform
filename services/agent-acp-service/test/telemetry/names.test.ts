import { describe, expect, it, vi, afterEach } from "vitest";
import { metrics } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";

import { metricAttributes, normalizeAttributes } from "../../src/telemetry/names.js";
import { ServiceTelemetry } from "../../src/telemetry/telemetry.js";
import { configureBoundaries } from "../../src/telemetry/diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("normalizeAttributes", () => {
  it("dual-emits every deprecated and short alias for a canonical-only input", () => {
    const result = normalizeAttributes({ "antnest.agent.id": "a" });
    expect(result["antnest.agent.id"]).toBe("a");
    expect(result["antnest.agent_id"]).toBe("a");
    expect(result["agent.id"]).toBe("a");
  });

  it("normalizes an alias-only spelling to canonical and keeps the alias", () => {
    const result = normalizeAttributes({ "antnest.agent_id": "b" });
    expect(result["antnest.agent.id"]).toBe("b");
    expect(result["antnest.agent_id"]).toBe("b");
  });

  it("emits the canonical value across all spellings on conflicting input in either order", () => {
    for (const input of [
      { "antnest.agent.id": "a", "antnest.agent_id": "b", "agent.id": "b" },
      { "antnest.agent_id": "b", "agent.id": "b", "antnest.agent.id": "a" },
    ]) {
      const result = normalizeAttributes(input);
      expect(result["antnest.agent.id"]).toBe("a");
      expect(result["antnest.agent_id"]).toBe("a");
      expect(result["agent.id"]).toBe("a");
    }
  });

  it.each(["false", " false ", "FALSE"])(
    "emits only canonical keys when legacy aliases are disabled (%j)",
    (value) => {
      vi.stubEnv("ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES", value);
      const result = normalizeAttributes({
        "antnest.agent.id": "a",
        "antnest.agent_id": "b",
        "agent.id": "b",
      });
      expect(result["antnest.agent.id"]).toBe("a");
      expect(result["antnest.agent_id"]).toBeUndefined();
      expect(result["agent.id"]).toBeUndefined();
    },
  );

  it("does not mutate the input object", () => {
    const input: Attributes = { "antnest.agent_id": "agent-1" };
    normalizeAttributes(input);
    expect(input).toEqual({ "antnest.agent_id": "agent-1" });
  });

  it("preserves externally meaningful keys without prototype pollution", () => {
    const result = normalizeAttributes({
      constructor: "kept",
      ["__proto__"]: "kept",
      hasOwnProperty: "kept",
    });
    expect(result["constructor"]).toBe("kept");
    expect(result["__proto__"]).toBe("kept");
    expect(Object.entries(result)).toContainEqual(["hasOwnProperty", "kept"]);
    expect((result as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("metricAttributes", () => {
  it("strips every unbounded ID and content key in any spelling", () => {
    const result = metricAttributes({
      "antnest.agent.id": "a",
      "antnest.agent_id": "a",
      "antnest.run.id": "r",
      "antnest.run_id": "r",
      "antnest.session.id": "s",
      "antnest.request.id": "q",
      "antnest.operation.request_id": "q",
      "antnest.organization.id": "o",
      "antnest.runtime.execution.id": "e",
      "antnest.provider.connection_id": "p",
      "antnest.payload.json": "{}",
      "agent.id": "a",
      "run.id": "r",
      "session.id": "s",
      "request.id": "q",
      "antnest.outcome": "success",
      terminal_class: "failed",
    });
    for (const key of [
      "antnest.agent.id",
      "antnest.agent_id",
      "antnest.run.id",
      "antnest.run_id",
      "antnest.session.id",
      "antnest.request.id",
      "antnest.operation.request_id",
      "antnest.organization.id",
      "antnest.runtime.execution.id",
      "antnest.provider.connection_id",
      "antnest.payload.json",
      "agent.id",
      "run.id",
      "session.id",
      "request.id",
    ]) {
      expect(result[key], key).toBeUndefined();
    }
    expect(result["antnest.outcome"]).toBe("success");
    expect(result["terminal_class"]).toBe("failed");
  });
});

describe("ServiceTelemetry metric dimension filtering", () => {
  it("applies metricAttributes to count and duration calls", () => {
    configureBoundaries({ captureRpcContent: false, disabled: false });
    const add = vi.fn();
    const record = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add })),
      createHistogram: vi.fn(() => ({ record })),
    };
    const spy = vi.spyOn(metrics, "getMeter").mockReturnValue(meter as never);
    try {
      const telemetry = new ServiceTelemetry("fixture");
      telemetry.count("calls", {
        "antnest.agent.id": "a",
        "antnest.outcome": "success",
      });
      telemetry.duration("elapsed", 5, {
        "antnest.agent.id": "a",
        "antnest.outcome": "success",
      });
    } finally {
      spy.mockRestore();
    }
    expect(add).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    for (const call of [...add.mock.calls, ...record.mock.calls]) {
      const attributes = call[1] as Attributes;
      expect(attributes["antnest.agent.id"]).toBeUndefined();
      expect(attributes["antnest.outcome"]).toBe("success");
    }
  });
});
