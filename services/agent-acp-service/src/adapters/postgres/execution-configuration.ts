import {
  parsePublicExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../../ports/execution-configuration.js";
import type { PostgresKernel } from "./kernel.js";

export class PostgresExecutionConfiguration implements ExecutionConfigurationRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async load(organizationId: string): Promise<PublicExecutionConfiguration | null> {
    const result = await this.kernel.query<{ configuration: unknown }>(
      "SELECT configuration FROM execution_configurations WHERE organization_id = $1",
      [organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parsePublicExecutionConfiguration(row.configuration);
  }

  public async save(
    input: PublicExecutionConfiguration,
    expectedRevision: number | null,
  ): Promise<boolean> {
    const configuration = parsePublicExecutionConfiguration(input);
    const values = [
      configuration.organization_id,
      configuration.revision,
      JSON.stringify(configuration),
    ];
    if (expectedRevision === null) {
      const inserted = await this.kernel.query(
        `INSERT INTO execution_configurations(organization_id, revision, configuration)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (organization_id) DO NOTHING`,
        values,
      );
      return inserted.rowCount === 1;
    }
    const updated = await this.kernel.query(
      `UPDATE execution_configurations SET revision = $2, configuration = $3::jsonb, updated_at = now()
       WHERE organization_id = $1 AND revision = $4 AND revision < $2`,
      [...values, expectedRevision],
    );
    return updated.rowCount === 1;
  }
}
