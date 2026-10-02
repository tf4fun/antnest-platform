import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PostgresBridgeObservationRepository } from "../../../src/adapters/postgres/bridge-observation-repository.js";
import { NOOP_TELEMETRY } from "../../../src/ports/telemetry.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../../../../../contracts/agent-acp/workspace-bridge.schema.json", import.meta.url),
    "utf8",
  ),
) as { $schema: string; $defs: Record<string, object> };
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../tests/support/fixtures/agent-acp/bridge-receipts.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { knownErrorClasses: string[] };
const ajv = new Ajv2020({ strict: true, validateFormats: false });
const compile = (name: string) =>
  ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${name}` });
const validReceipt = compile("intentReceipt");
const validObservation = compile("executionObservation");

function persisted(errorClass: string | null, state = "failed") {
  const row = {
    bridge_intent_id: "intent-1",
    session_id: "session-1",
    run_id: "run-1",
    state,
    append_version: "2",
    output_watermark: "4",
    stop_reason: null,
    error_class: errorClass,
  };
  const query = vi.fn((sql: string) =>
    Promise.resolve({
      rows: sql.includes("FROM acp_sessions")
        ? [
            {
              append_version: "2",
              configuration_revision: "1",
              last_message_sequence: "4",
              active_run_id: null,
            },
          ]
        : sql.startsWith("SET ")
          ? []
          : [row],
    }),
  );
  const transaction = async (operation: (client: never) => Promise<unknown>) =>
    operation({ query } as never);
  const telemetry = { ...NOOP_TELEMETRY, log: vi.fn() };
  const repository = new PostgresBridgeObservationRepository(
    { query, transaction } as never,
    telemetry,
  );
  return { repository, telemetry };
}

describe("durable Bridge intent receipt", () => {
  it("validates real repository receipts and embedded observations for all known and open classes", async () => {
    for (const errorClass of [
      null,
      ...fixtures.knownErrorClasses,
      "vendor_future_failure",
      "a".repeat(128),
    ]) {
      const { repository, telemetry } = persisted(errorClass);
      for (let read = 0; read < 3; read++) {
        const receipt = await repository.readIntent("session-1", "intent-1");
        const observation = await repository.readSession("session-1");
        expect(validReceipt(receipt), JSON.stringify(validReceipt.errors)).toBe(true);
        expect(validObservation(observation), JSON.stringify(validObservation.errors)).toBe(true);
        expect(receipt?.errorClass).toBe(errorClass);
        expect(observation?.recentReceipts[0]).toEqual(receipt);
      }
      expect(telemetry.log).not.toHaveBeenCalled();
    }
  });

  it("normalizes invalid persisted classes on both read paths and records a bounded diagnostic", async () => {
    for (const original of ["", "a".repeat(129), "RunFailed", "run-failed", "run_failed\n"]) {
      const { repository, telemetry } = persisted(original);
      const receipt = await repository.readIntent("session-1", "intent-1");
      const observation = await repository.readSession("session-1");
      expect(receipt?.errorClass).toBe("internal_error");
      expect(observation?.recentReceipts[0]?.errorClass).toBe("internal_error");
      expect(validReceipt(receipt), JSON.stringify(validReceipt.errors)).toBe(true);
      expect(validObservation(observation), JSON.stringify(validObservation.errors)).toBe(true);
      expect(telemetry.log).toHaveBeenCalledWith(
        "warn",
        "bridge_receipt_error_class_normalized",
        expect.objectContaining({
          original_error_class: original.slice(0, 128),
          original_error_class_length: original.length,
          normalized_error_class: "internal_error",
          "run.id": "run-1",
        }),
      );
    }
  });

  it("keeps classification null outside failed, cancelled and unknown receipt phases", async () => {
    for (const state of ["admitting", "running", "completed"]) {
      const { repository } = persisted("run_failed", state);
      const receipt = await repository.readIntent("session-1", "intent-1");
      const observation = await repository.readSession("session-1");
      expect(receipt?.errorClass).toBeNull();
      expect(observation?.recentReceipts[0]?.errorClass).toBeNull();
    }
    for (const state of ["cancelled", "unresolved"]) {
      const { repository } = persisted("vendor_future_failure", state);
      const receipt = await repository.readIntent("session-1", "intent-1");
      expect(receipt?.errorClass).toBe("vendor_future_failure");
      expect(validReceipt(receipt)).toBe(true);
    }
  });

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
