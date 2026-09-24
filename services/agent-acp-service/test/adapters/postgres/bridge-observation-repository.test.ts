import { describe, expect, it, vi } from "vitest";
import { PostgresBridgeObservationRepository } from "../../../src/adapters/postgres/bridge-observation-repository.js";

describe("durable Bridge intent receipt", () => {
  it("exposes the persisted failure class without exposing provider details", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          bridge_intent_id: "intent-1",
          session_id: "session-1",
          run_id: "run-1",
          state: "failed",
          append_version: "2",
          output_watermark: "4",
          stop_reason: null,
          error_class: "model_unsupported_content",
        },
      ],
    });
    const repository = new PostgresBridgeObservationRepository({ query } as never);
    await expect(repository.readIntent("session-1", "intent-1")).resolves.toEqual({
      intentId: "intent-1",
      sessionId: "session-1",
      runId: "run-1",
      phase: "failed",
      appendVersion: 2,
      outputWatermark: 4,
      stopReason: null,
      errorClass: "model_unsupported_content",
    });
    expect(query.mock.calls[0]?.[0]).toContain("r.error_class");
  });
});
