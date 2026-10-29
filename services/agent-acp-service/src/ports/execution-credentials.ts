export type ExecutionCredentialScope = Readonly<{
  organization_id: string;
  connection_id: string;
  credential_version: string;
}>;

export type ResolvedExecutionCredential = Readonly<{
  organization_id: string;
  connection_id: string;
  credential_version: string;
  method: string;
  secret: string;
}>;

export type ExecutionCredentialResolver = (
  scope: ExecutionCredentialScope,
  signal: AbortSignal,
) => Promise<ResolvedExecutionCredential>;
