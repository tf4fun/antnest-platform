import { DomainError } from "../../domain/errors.js";
import { sessionConfigurationSchema } from "../../domain/session-configuration.js";
import type { SessionConfigurationRepository } from "../../ports/session-configuration.js";
import type { PostgresKernel } from "./kernel.js";
import { encodeSessionEvent } from "./session-event-codec.js";

export class PostgresSessionConfiguration implements SessionConfigurationRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async get(sessionId: string) {
    const result = await this.kernel.query<{
      configuration: unknown;
      configuration_revision: string;
    }>(
      "SELECT configuration, configuration_revision FROM acp_sessions WHERE id = $1 AND state <> 'deleted'",
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new DomainError("session_not_found", "Session does not exist");
    return {
      configuration: sessionConfigurationSchema.parse(row.configuration),
      revision: Number(row.configuration_revision),
    };
  }

  public async save(input: Parameters<SessionConfigurationRepository["save"]>[0]) {
    await this.kernel.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const changed = await client.query<{
        last_message_sequence: string;
        configuration_revision: string;
      }>(
        `UPDATE acp_sessions SET configuration = $3::jsonb,
           configuration_revision = configuration_revision + 1,
           last_message_sequence = last_message_sequence + 1, updated_at = $4
         WHERE id = $1 AND configuration_revision = $2 AND state <> 'deleted'
         RETURNING last_message_sequence, configuration_revision`,
        [
          input.sessionId,
          input.expectedRevision,
          JSON.stringify(input.configuration),
          input.changedAt,
        ],
      );
      const row = changed.rows[0];
      if (row === undefined)
        throw new DomainError(
          "configuration_conflict",
          "Session configuration changed; reload and retry",
        );
      await client.query(
        `INSERT INTO session_messages(id, session_id, sequence, kind, visible, payload, created_at)
         VALUES ($1, $2, $3, 'configuration', true, $4::jsonb, $5)`,
        [
          `${input.sessionId}:configuration:${row.configuration_revision}`,
          input.sessionId,
          row.last_message_sequence,
          JSON.stringify(encodeSessionEvent({ kind: "configuration", configuration: input.view })),
          input.changedAt,
        ],
      );
    });
  }
}
