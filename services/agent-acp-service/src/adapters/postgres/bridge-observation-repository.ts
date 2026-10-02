import type { PoolClient } from "pg";
import { configurationRevisionToken } from "../../domain/configuration-revision.js";
import type {
  BridgeIntentReceipt,
  BridgeObservationRepository,
  BridgeSessionExecution,
} from "../../ports/bridge-observation.js";
import type { PostgresKernel } from "./kernel.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";

type ReceiptRow = {
  bridge_intent_id: string;
  session_id: string;
  run_id: string;
  state: "admitting" | "running" | "completed" | "cancelled" | "failed" | "unresolved";
  append_version: string;
  output_watermark: string;
  stop_reason: string | null;
  error_class: string | null;
};

const RECEIPT_COLUMNS = `r.bridge_intent_id, r.session_id, r.id AS run_id,
  r.state, r.append_version, r.stop_reason, r.error_class,
  COALESCE((SELECT MAX(m.sequence) FROM session_messages m WHERE m.run_id = r.id), 0)
    AS output_watermark`;

export class PostgresBridgeObservationRepository implements BridgeObservationRepository {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
  ) {}

  public async readIntent(
    sessionId: string,
    intentId: string,
  ): Promise<BridgeIntentReceipt | null> {
    const result = await this.kernel.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM runs r
        WHERE r.session_id = $1 AND r.bridge_intent_id = $2`,
      [sessionId, intentId],
    );
    return result.rows[0] === undefined ? null : receipt(result.rows[0], this.telemetry);
  }

  public readSession(sessionId: string): Promise<BridgeSessionExecution | null> {
    return this.kernel.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await client.query<{
        append_version: string;
        configuration_revision: string;
        last_message_sequence: string;
        active_run_id: string | null;
      }>(
        `SELECT s.append_version, s.configuration_revision, s.last_message_sequence,
                (SELECT r.id FROM runs r WHERE r.session_id = s.id
                  AND r.state IN ('admitting', 'running')
                  ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS active_run_id
           FROM acp_sessions s WHERE s.id = $1`,
        [sessionId],
      );
      const row = state.rows[0];
      if (row === undefined) return null;
      const recentReceipts = await this.recent(client, sessionId);
      return {
        sessionId,
        appendVersion: safeNumber(row.append_version),
        outputWatermark: safeNumber(row.last_message_sequence),
        activeRunId: row.active_run_id,
        recentReceipts,
        configurationRevision: configurationRevisionToken(sessionId, row.configuration_revision),
      };
    });
  }

  private async recent(client: PoolClient, sessionId: string): Promise<BridgeIntentReceipt[]> {
    const result = await client.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM runs r
        WHERE r.session_id = $1 AND r.bridge_intent_id IS NOT NULL
        ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
      [sessionId],
    );
    return result.rows.map((row) => receipt(row, this.telemetry));
  }
}

function receipt(row: ReceiptRow, telemetry: TelemetryPort): BridgeIntentReceipt {
  const phase =
    row.state === "admitting" ? "persisting" : row.state === "unresolved" ? "unknown" : row.state;
  const errorClass =
    phase === "failed" || phase === "cancelled" || phase === "unknown"
      ? normalizeErrorClass(row.error_class)
      : null;
  if (errorClass !== row.error_class) {
    telemetry.log("warn", "bridge_receipt_error_class_normalized", {
      "run.id": row.run_id,
      phase,
      original_error_class: row.error_class?.slice(0, 128),
      original_error_class_length: row.error_class?.length ?? 0,
      normalized_error_class: errorClass ?? "none",
    });
  }
  return {
    intentId: row.bridge_intent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    phase,
    appendVersion: safeNumber(row.append_version),
    outputWatermark: safeNumber(row.output_watermark),
    stopReason: row.stop_reason,
    errorClass,
  };
}

function normalizeErrorClass(value: string | null): string | null {
  if (value === null) return null;
  return value.length >= 1 && value.length <= 128 && /^[a-z][a-z0-9_]*$/u.test(value)
    ? value
    : "internal_error";
}

function safeNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid durable Bridge sequence");
  return result;
}
