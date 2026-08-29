# Antnest Platform Contracts

This directory is the language-neutral boundary between independently
deployable components. It contains wire contracts and shared fixtures, not
generated application models, persistence records, or reusable business code.

## Active Contracts

| Contract | Owner | Required reviewers | Consumers | Purpose |
| --- | --- | --- | --- | --- |
| [`runtime/contract.json`](runtime/contract.json) | Antnest Runtime | ACP Service, Agent Controller | Runtime Controller, ACP Service, and Antnest Runtime | Runtime status and MCP surface |
| [`runtime/runtime-spec.schema.json`](runtime/runtime-spec.schema.json) | Agent Controller | Runtime Controller, Antnest Runtime | Agent Controller, Runtime Controller, and Antnest Runtime | Immutable Runtime creation input |
| [`runtime/packet-contract.json`](runtime/packet-contract.json) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress | Machine-readable raw-IP-over-UDP contract |
| [`runtime/packet-format.md`](runtime/packet-format.md) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress | Raw-IP-over-UDP semantics and evolution |
| [`runtime/packet-fixtures.json`](runtime/packet-fixtures.json) | Runtime Egress | Antnest Runtime | Antnest Runtime and Runtime Egress tests | Shared accepted and rejected packet examples |
| [`egress/control-contract.json`](egress/control-contract.json) | Runtime Egress | Agent Controller | Agent Controller and Runtime Egress | Machine-readable trusted internal control RPC surface |
| [`egress/control-api.md`](egress/control-api.md) | Runtime Egress | Agent Controller | Agent Controller and Runtime Egress | Trusted internal network-control RPC semantics |
| [`egress/policy.schema.json`](egress/policy.schema.json) | Runtime Egress | Agent Controller | Runtime Egress control callers and tests | Immutable Egress policy revision schema |

Files under `openapi/` describe obsolete service prototypes. They are not
active contracts and impose no compatibility requirement. Each service rewrite
removes its corresponding draft instead of adapting the new domain to it.

## Ownership Rules

1. A contract describes only facts that cross a process boundary.
2. Service-private persistence models and deployment-provider DTOs do not
   belong here.
3. Neither peer may add an undocumented wire-only field or infer an identity
   that the contract does not carry.
4. Generated code, if introduced, must be reproducible and must not become a
   second manually maintained schema.
5. The current system rewrite carries no legacy wire compatibility layer.
   Source changes update every active peer in one repository change. Deployment
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
