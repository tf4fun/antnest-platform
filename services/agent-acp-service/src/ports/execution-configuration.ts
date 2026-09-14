import type { PublicExecutionConfiguration } from "../domain/execution-configuration.js";

export interface ExecutionConfigurationPort {
  apply(input: unknown): Promise<{ organization_id: string; applied_revision: number }>;
}

export interface ExecutionConfigurationRepository {
  load(organizationId: string): Promise<PublicExecutionConfiguration | null>;
  save(
    configuration: PublicExecutionConfiguration,
    expectedRevision: number | null,
  ): Promise<boolean>;
}
