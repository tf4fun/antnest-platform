import type {
  ExecutionConfiguration,
  PublicExecutionConfiguration,
} from "../domain/execution-configuration.js";

export class InvalidExecutionAuthorityError extends Error {
  public constructor() {
    super("Stored execution authority is invalid");
    this.name = "InvalidExecutionAuthorityError";
  }
}

export interface ExecutionConfigurationPort {
  apply(input: unknown): Promise<{ organization_id: string; applied_revision: number }>;
}

export interface ExecutionConfigurationRepository {
  load(organizationId: string): Promise<PublicExecutionConfiguration | null>;
  loadAuthority(organizationId: string): Promise<ExecutionConfiguration | null>;
  listOrganizations(): Promise<string[]>;
  save(configuration: ExecutionConfiguration, expectedRevision: number | null): Promise<boolean>;
}
