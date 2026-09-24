import { describe, expect, it, vi } from "vitest";
import { BridgeObservationService } from "../../src/application/bridge-observation.js";
import { DomainError } from "../../src/domain/errors.js";
import type { BridgeObservationRepository } from "../../src/ports/bridge-observation.js";
import { binding } from "../support/fixtures.js";

describe("Bridge execution observation authorization", () => {
  it("checks current Agent access and Session ownership before returning a receipt", async () => {
    const order: string[] = [];
    const assert = vi.fn(() => {
      order.push("access");
      return Promise.resolve();
    });
    const requireAuthorized = vi.fn(() => {
      order.push("session");
      return Promise.resolve();
    });
    const readIntent = vi.fn<BridgeObservationRepository["readIntent"]>(() => {
      order.push("receipt");
      return Promise.resolve({
        intentId: "intent-1",
        sessionId: "session-1",
        runId: "run-1",
        phase: "running",
        appendVersion: 1,
        outputWatermark: 2,
        stopReason: null,
        errorClass: null,
      });
    });
    const service = new BridgeObservationService({
      access: { assert },
      sessions: { requireAuthorized },
      repository: { readIntent, readSession: vi.fn() },
    });
    await expect(service.readIntent(binding(), "session-1", "intent-1")).resolves.toMatchObject({
      runId: "run-1",
      outputWatermark: 2,
    });
    expect(order).toEqual(["access", "session", "receipt"]);
  });

  it("does not query private receipts after a revoked Agent or foreign Session", async () => {
    const readIntent = vi.fn<BridgeObservationRepository["readIntent"]>();
    const denied = new BridgeObservationService({
      access: { assert: vi.fn().mockRejectedValue(new DomainError("access_denied", "Denied")) },
      sessions: { requireAuthorized: vi.fn() },
      repository: { readIntent, readSession: vi.fn() },
    });
    await expect(denied.readIntent(binding(), "session-1", "intent-1")).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(readIntent).not.toHaveBeenCalled();
    const foreign = new BridgeObservationService({
      access: { assert: vi.fn().mockResolvedValue(undefined) },
      sessions: {
        requireAuthorized: vi
          .fn()
          .mockRejectedValue(new DomainError("session_access_denied", "Foreign Session")),
      },
      repository: { readIntent, readSession: vi.fn() },
    });
    await expect(foreign.readIntent(binding(), "session-1", "intent-1")).rejects.toMatchObject({
      code: "session_access_denied",
    });
    expect(readIntent).not.toHaveBeenCalled();
  });
});
