# Antnest Platform Contracts

This directory is the language-neutral boundary between independently
deployable components. It contains wire contracts and shared fixtures, not
generated application models, persistence records, or reusable business code.

## Active Contracts

[Platform resource identifiers](resource-identifiers.md) defines generation of
new resource IDs across service owners; consumers retain opaque-ID semantics.

| Contract | Owner | Required reviewers | Consumers | Purpose |
| --- | --- | --- | --- | --- |
| [`runtime/contract.json`](runtime/contract.json) | Antnest Runtime | ACP Service, Agent Controller | Runtime Controller, ACP Service, and Antnest Runtime | Runtime status and MCP surface |
| [`runtime/runtime-spec.schema.json`](runtime/runtime-spec.schema.json) | Runtime Controller | Antnest Runtime | Runtime Controller and Antnest Runtime | Controller-resolved immutable Runtime bootstrap input |
| [`runtime/packet-contract.json`](runtime/packet-contract.json) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress | Machine-readable raw-IP-over-UDP contract |
| [`runtime/packet-format.md`](runtime/packet-format.md) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress | Raw-IP-over-UDP semantics and evolution |
| [`runtime/packet-fixtures.json`](runtime/packet-fixtures.json) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress tests | Shared accepted and rejected packet examples |
| [`egress/control-contract.json`](egress/control-contract.json) | Runtime Egress | Agent Controller | Agent Controller and Runtime Egress | Machine-readable trusted internal control RPC surface |
| [`egress/control-api.md`](egress/control-api.md) | Runtime Egress | Agent Controller | Agent Controller and Runtime Egress | Trusted internal network-control RPC semantics |
| [`egress/policy.schema.json`](egress/policy.schema.json) | Runtime Egress | Agent Controller | Runtime Egress control callers and tests | Immutable Egress policy revision schema |
| [`../services/runtime-controller/api/control-contract.json`](../services/runtime-controller/api/control-contract.json) | Runtime Controller | Agent Controller | Agent Controller and Runtime Controller | Machine-readable deployment RPC surface |
| [`../services/runtime-controller/api/control-api.md`](../services/runtime-controller/api/control-api.md) | Runtime Controller | Agent Controller | Agent Controller and Runtime Controller | Logical Runtime lifecycle, operation, and observation semantics |
| [`../services/runtime-controller/api/runtime-deployment.schema.json`](../services/runtime-controller/api/runtime-deployment.schema.json) | Runtime Controller | Agent Controller | Agent Controller and Runtime Controller | Language-neutral Runtime configuration input |
| [`agent-controller/control-contract.json`](agent-controller/control-contract.json) | Agent Controller | Identity Service and administrative clients | Internal Agent management clients | Machine-readable ModelProfile, Template, Agent lifecycle, projection-query, operation, and event route catalog |
| [`agent-controller/control-api.schema.json`](agent-controller/control-api.schema.json) | Agent Controller | Identity Service and administrative clients | Internal Agent management clients and contract tests | Agent Controller management request and response schema |
| [`agent-controller/control-api.md`](agent-controller/control-api.md) | Agent Controller | Identity Service and administrative clients | Internal Agent management clients and maintainers | Agent lifecycle, projection-query, ownership, and event semantics |
| [`agent-acp/execution-api.md`](agent-acp/execution-api.md) | Agent ACP Service | Agent Controller, Edge Gateway, Admin Console | Controller publication/settlement, Gateway state, Console audit | Internal execution configuration, settlement, state and retained audit; no Controller Run ticket |
| [`agent-acp/execution-snapshot.schema.json`](agent-acp/execution-snapshot.schema.json) | Agent ACP Service | Agent Controller | Controller and ACP | Organization execution snapshot with current Providers, models, access and ordered fallback |
| [`agent-acp/agent-execution-state.schema.json`](agent-acp/agent-execution-state.schema.json) | Agent ACP Service | Edge Gateway | Gateway state consumers | ACP-owned availability and active Session observation |
| [`identity/identity-contract.json`](identity/identity-contract.json) | Identity Service | Agent Controller, Edge Gateway, and administrative clients | Agent Controller and internal identity clients | Organizations, principals, local authentication, OIDC configuration, and SCIM credential administration |
| [`edge-gateway/session-contract.json`](edge-gateway/session-contract.json) | Edge Gateway | Identity Service, Agent UI and Admin Console | Browser clients and Node Bridge | Browser session, Workspace HTML/API/SSE admission, administrator admission and trusted principal projection |
| [`admin-console/admin-contract.json`](admin-console/admin-contract.json) | Admin Console | Edge Gateway, Identity Service, and Agent Controller | Administrator web application | Stage 3A thin-BFF route and authority-field inventory |

## Agent UI Full-Stack Boundary

These contracts define the active development deployment. The Node Bridge and
browser use business HTTP/SSE through Gateway; the ACP extension remains an
internal producer contract.

| Contract | Owner | Required reviewers | Consumers | Purpose |
| --- | --- | --- | --- | --- |
| [`agent-ui/workspace-api.json`](agent-ui/workspace-api.json), [`wire schema`](agent-ui/workspace-api.schema.json), [`semantics`](agent-ui/workspace-api.md) | Agent UI | Edge Gateway, ACP Service | Gateway and browser | Authenticated HTTP/SSE route and projection boundary |
| [`agent-ui/workspace-commands.md`](agent-ui/workspace-commands.md) | Agent UI | ACP Service, Edge Gateway | Browser; future Channel Gateway pending | Control-command discovery, semantics and reuse of existing authorized operations |
| [`agent-acp/workspace-bridge.schema.json`](agent-acp/workspace-bridge.schema.json), [`semantics`](agent-acp/workspace-bridge.md) | Agent ACP Service | Agent UI, Edge Gateway | Node Bridge | Durable prompt receipt, targeted cancel and replay delivery metadata |
| [`edge-gateway/session-contract.json`](edge-gateway/session-contract.json) | Edge Gateway | Identity Service, Agent UI | Browser and Node Bridge | Active authentication, proxy and SSE admission routes |

Obsolete prototype contracts are deleted when their service is rewritten; they
do not remain as an implied compatibility layer.

## Ownership Rules

1. A contract describes only facts that cross a process boundary.
2. Service-private persistence models and deployment-provider DTOs do not
   belong here.
3. Neither peer may add an undocumented wire-only field or infer an identity
   that the contract does not carry.
4. Generated code, if introduced, must be reproducible and must not become a
   second manually maintained schema.
5. The current system rewrite carries no legacy wire compatibility layer.
   Define shared contracts first, deliver each owning service in its own batch,
   then run an explicit integration batch before deploying the combination. Deployment
   does not assume atomic replacement: each contract documents whether rollout
   is fail-fast or follows expand, migrate, contract.
6. Internal APIs trust their deployment network. Business preconditions,
   idempotency, compare-and-swap behavior, and stable error codes remain part
   of the contract.
7. A contract owner proposes changes. Every required reviewer must accept the
   compatibility and rollout semantics before an implementation changes.

## Validation

Each implementation validates its own encoder, decoder, and domain mapping.
Runtime and Egress both consume the same packet fixtures without sharing source
code. Container acceptance validates the complete Runtime-to-Egress data path.
