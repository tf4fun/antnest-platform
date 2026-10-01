# Agent Defaults And Session Configuration

Controller owns organization model availability, current model parameters,
encrypted Provider credentials and Agent default authorization. ACP owns Session
model/mode overrides and resolves each execution's effective configuration.
Neither service reads the other's database.

## Management Flow

1. The owner changes defaults through `set-agent-authorization`. The independent
   Agent configuration service checks current Identity membership, access binding
   and authorization revision in the management transaction.
2. The transaction saves defaults, appends management audit and advances the
   organization execution revision.
3. The shared publisher sends the current configuration to ACP after commit.
   Commit and remote application are separate facts.
4. ACP uses the synchronized defaults and organization model catalog while
   retaining Session overrides locally. No per-Session configuration or per-Run
   credential callback to Controller exists.

See [Agent configuration](agent-configuration.md),
[publication](execution-publication.md) and the
[management contract](../../../contracts/agent-controller/control-api.md).

## Absent Surface And Verification

`get-session-configuration`, `acquire-run`, `resolve-agent-access`,
`resolve-credential` and `finish-run` are not registered by Controller.
Tests cover default-authorization CAS, foreign-owner rejection, current
credential rotation and publication through a real PostgreSQL source and HTTP
ACP peer. Configuration changes must not mutate Runtime or Egress.
Protocol/Session override tests belong to ACP, not a simulated Controller Run.

Controller has no execution application, Port, repository, Run table or
workspace execution reader. Access bindings keep owner, access revision and
active status, not opaque routing subjects or Model capabilities.
Service-local tests do not establish an operational cross-service deployment.
