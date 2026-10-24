import { describe, expect, it } from "vitest";
import { ProviderCircuit } from "../../src/application/provider-circuit.js";

function setup(options: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let elapsed = 0;
  const circuit = new ProviderCircuit({ ...options, now: () => elapsed });
  return {
    circuit,
    advance(milliseconds: number): void {
      elapsed += milliseconds;
    },
  };
}

function acquire(circuit: ProviderCircuit) {
  const permit = circuit.tryAcquire();
  expect(permit).toBeDefined();
  if (permit === undefined) throw new Error("Expected a Provider circuit permit");
  return permit;
}

describe("Provider circuit admission", () => {
  it("defaults to three consecutive failures and a thirty-second cooldown", () => {
    const f = setup();
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(29_999);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(1);
    expect(acquire(f.circuit).settle("success")).toBe(false);
  });

  it.each([
    { failureThreshold: 1, cooldownMs: 1 },
    { failureThreshold: 100, cooldownMs: 3_600_000 },
  ])("accepts the configured threshold and cooldown boundaries %j", (options) => {
    const f = setup(options);
    for (let count = 1; count <= options.failureThreshold; count += 1)
      expect(acquire(f.circuit).settle("failure")).toBe(count === options.failureThreshold);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(options.cooldownMs);
    expect(acquire(f.circuit).settle("success")).toBe(false);
  });

  it.each([
    { field: "threshold", value: 0 },
    { field: "threshold", value: -1 },
    { field: "threshold", value: 101 },
    { field: "threshold", value: 1.5 },
    { field: "threshold", value: Number.NaN },
    { field: "threshold", value: Number.POSITIVE_INFINITY },
    { field: "cooldown", value: 0 },
    { field: "cooldown", value: -1 },
    { field: "cooldown", value: 3_600_001 },
    { field: "cooldown", value: 1.5 },
    { field: "cooldown", value: Number.NaN },
    { field: "cooldown", value: Number.POSITIVE_INFINITY },
  ])("rejects an invalid $field value $value with RangeError", ({ field, value }) => {
    expect(
      () =>
        new ProviderCircuit(
          field === "threshold" ? { failureThreshold: value } : { cooldownMs: value },
        ),
    ).toThrow(RangeError);
  });

  it("permits concurrent closed requests and applies outcomes in completion order", () => {
    const f = setup({ failureThreshold: 2 });
    const first = acquire(f.circuit);
    const second = acquire(f.circuit);
    const third = acquire(f.circuit);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first.settle("failure")).toBe(false);
    expect(third.settle("success")).toBe(false);
    expect(second.settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    expect(f.circuit.tryAcquire()).toBeUndefined();
  });

  it("clears the consecutive failure count on a closed success", () => {
    const f = setup();
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("success")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
  });

  it("neither increments nor clears closed failures on a neutral outcome", () => {
    const f = setup({ failureThreshold: 2 });
    expect(acquire(f.circuit).settle("neutral")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("neutral")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
  });

  it("settles once while repeated settlement reports the current admission state", () => {
    const f = setup({ failureThreshold: 2, cooldownMs: 10 });
    const original = acquire(f.circuit);
    expect(original.settle("failure")).toBe(false);
    expect(original.settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    expect(original.settle("success")).toBe(true);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(10);
    expect(original.settle("neutral")).toBe(false);
    const probe = acquire(f.circuit);
    expect(original.settle("success")).toBe(true);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    expect(probe.settle("success")).toBe(false);
    expect(original.settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("neutral")).toBe(false);
  });

  it("does not renew an open cooldown when requests are skipped and admits one boundary probe", () => {
    const f = setup({ failureThreshold: 1, cooldownMs: 100 });
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    f.advance(50);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(49);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    f.advance(1);
    const probe = acquire(f.circuit);
    expect(f.circuit.tryAcquire()).toBeUndefined();
    expect(probe.settle("success")).toBe(false);
  });

  it("keeps a half-open probe exclusive until its original permit settles", () => {
    const f = setup({ failureThreshold: 1, cooldownMs: 10 });
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    f.advance(10);
    const probe = acquire(f.circuit);
    for (let count = 0; count < 3; count += 1) {
      f.advance(100);
      expect(f.circuit.tryAcquire()).toBeUndefined();
    }
    expect(probe.settle("success")).toBe(false);
    expect(acquire(f.circuit).settle("neutral")).toBe(false);
  });

  it("closes after a successful probe and starts a fresh failure count", () => {
    const f = setup({ failureThreshold: 2, cooldownMs: 10 });
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
    f.advance(10);
    expect(acquire(f.circuit).settle("success")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(false);
    expect(acquire(f.circuit).settle("failure")).toBe(true);
  });

  it.each(["failure", "neutral"] as const)(
    "restarts cooldown at probe settlement after a %s outcome",
    (outcome) => {
      const f = setup({ failureThreshold: 1, cooldownMs: 100 });
      expect(acquire(f.circuit).settle("failure")).toBe(true);
      f.advance(100);
      const probe = acquire(f.circuit);
      f.advance(250);
      expect(probe.settle(outcome)).toBe(true);
      f.advance(99);
      expect(f.circuit.tryAcquire()).toBeUndefined();
      f.advance(1);
      expect(acquire(f.circuit).settle("success")).toBe(false);
    },
  );

  it.each(["success", "failure", "neutral"] as const)(
    "ignores an old generation's %s result during a new probe and after recovery",
    (outcome) => {
      const f = setup({ failureThreshold: 2, cooldownMs: 10 });
      const staleDuringProbe = acquire(f.circuit);
      const staleAfterProbe = acquire(f.circuit);
      expect(acquire(f.circuit).settle("failure")).toBe(false);
      expect(acquire(f.circuit).settle("failure")).toBe(true);
      f.advance(10);
      const probe = acquire(f.circuit);
      expect(staleDuringProbe.settle(outcome)).toBe(true);
      expect(f.circuit.tryAcquire()).toBeUndefined();
      expect(probe.settle("success")).toBe(false);
      expect(acquire(f.circuit).settle("failure")).toBe(false);
      expect(staleAfterProbe.settle(outcome)).toBe(false);
      expect(acquire(f.circuit).settle("failure")).toBe(true);
    },
  );
});
