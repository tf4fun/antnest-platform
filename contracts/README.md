# Antnest Platform Contracts

This directory is the language-neutral boundary between independently
deployable components. It contains wire contracts, schemas and shared
fixtures, not generated application models, persistence records, or reusable
business code.

Shared field naming, pagination, precondition and idempotency conventions
are defined in [CONVENTIONS.md](CONVENTIONS.md).

[OIDC account linking](identity/oidc-linking.md) defines the revision-16 Identity,
revision-20 Gateway and revision-52 Console contract for #61. Binding ownership,
SCIM pairing and exact-ID notices precede their separate service and integration
batches; active caller grants remain tied to service implementation.

[Bounded Identity resolution](edge-gateway/resolve-cache.md) and its
[policy](edge-gateway/resolve-cache-policy.json) define Gateway revision 21 for
#59. They reuse Identity revision 16's private session feed; Gateway, trace/
display consumers and explicit HTTPS outage/load integration remain separate
pending batches.

[ACP error classification](agent-acp/errors.md), its
[catalog](agent-acp/errors.json) and [schema](agent-acp/errors.schema.json)
define #53's shared version-1 contract. Completing this shared phase does not
complete the ACP, Agent UI or Gateway implementation batches or their
cross-service user workflow; those consumers and integration remain pending.

## Active Contracts

| Directory                                                                    | Owner service                                                                                                     | Consumers                                                                            | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`platform/`](platform/)                                                     | Shared contract; Identity owns CCT issuance                                                                       | All services; deployment and integration pending                                     | [`service-authentication.md`](platform/service-authentication.md), CCT `*.schema.json`, [`caller-context-fixtures.json`](platform/caller-context-fixtures.json), [`service-token-callers.schema.json`](platform/service-token-callers.schema.json), [`service-token-fixtures.json`](platform/service-token-fixtures.json), [`service-callers.schema.json`](platform/service-callers.schema.json), [`service-authentication-error.schema.json`](platform/service-authentication-error.schema.json), [`rollout ledger`](platform/service-authentication-rollout.json)                            |
| [`runtime/`](runtime/)                                                       | Antnest Runtime; Runtime Egress owns the packet contract; Runtime Controller owns the RuntimeSpec                 | Runtime Controller, Agent ACP Service, Runtime Egress                                | [`contract.json`](runtime/contract.json), [`runtime-information.schema.json`](runtime/runtime-information.schema.json), [`builtin-tools.schema.json`](runtime/builtin-tools.schema.json), [`runtime-spec.schema.json`](runtime/runtime-spec.schema.json), [`packet-contract.json`](runtime/packet-contract.json), [`packet-format.md`](runtime/packet-format.md), [`packet-fixtures.json`](runtime/packet-fixtures.json), [`temporary-skills.schema.json`](runtime/temporary-skills.schema.json), [`temporary-skills.md`](runtime/temporary-skills.md), [`callers.json`](runtime/callers.json) |
| [`egress/`](egress/)                                                         | Runtime Egress                                                                                                    | Agent Controller                                                                     | [`control-contract.json`](egress/control-contract.json), [`control-api.md`](egress/control-api.md), [`service-authentication.md`](egress/service-authentication.md), [`policy.schema.json`](egress/policy.schema.json), [`attachment-state-request.schema.json`](egress/attachment-state-request.schema.json), [`resource-version-request.schema.json`](egress/resource-version-request.schema.json), [`callers.json`](egress/callers.json)                                                                                                                                                    |
| [`runtime-controller/`](runtime-controller/) | Runtime Controller                                                                                                | Agent Controller                                                                     | [`control-contract.json`](runtime-controller/control-contract.json), [`control-api.md`](runtime-controller/control-api.md), [`runtime-deployment.schema.json`](runtime-controller/runtime-deployment.schema.json), [`callers.json`](runtime-controller/callers.json)                                                                                                                                                                                                                                                           |
| [`agent-controller/`](agent-controller/)                                     | Agent Controller                                                                                                  | Admin Console, Edge Gateway, Agent ACP Service, Identity Service (reviewer)          | [`control-contract.json`](agent-controller/control-contract.json), [`control-api.schema.json`](agent-controller/control-api.schema.json), [`control-api.md`](agent-controller/control-api.md), [`run-api.md`](agent-controller/run-api.md) (retired Run admission API), [`callers.json`](agent-controller/callers.json)                                                                                                                                                                                                                                                                        |
| [`agent-acp/`](agent-acp/)                                                   | Agent ACP Service                                                                                                 | Agent Controller, Edge Gateway, Admin Console, Agent UI Node Bridge, Antnest Runtime | [`execution-api.md`](agent-acp/execution-api.md) and its `*.schema.json` files, [`workspace-bridge.md`](agent-acp/workspace-bridge.md), [`workspace-bridge.schema.json`](agent-acp/workspace-bridge.schema.json), [`skill-commands.md`](agent-acp/skill-commands.md), [`skill-discovery-tools.md`](agent-acp/skill-discovery-tools.md), [`skill-temporary-consumer.md`](agent-acp/skill-temporary-consumer.md), [`callers.json`](agent-acp/callers.json)                                                                                                                                       |
| [`identity/`](identity/)                                                     | Identity Service                                                                                                  | Agent Controller, Edge Gateway, Admin Console                                        | [`README.md`](identity/README.md), [`identity-contract.json`](identity/identity-contract.json), [`principal-revocations.md`](identity/principal-revocations.md), [`callers.json`](identity/callers.json)                                                                                                                                                                                                                                                                                                                                                                                       |
| [`edge-gateway/`](edge-gateway/)                                             | Edge Gateway                                                                                                      | Browsers, Agent UI Node Bridge, Admin Console                                        | [`README.md`](edge-gateway/README.md), [`session-contract.json`](edge-gateway/session-contract.json), [`callers.json`](edge-gateway/callers.json)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`agent-ui/`](agent-ui/)                                                     | Agent UI                                                                                                          | Browser, Edge Gateway                                                                | [`workspace-api.json`](agent-ui/workspace-api.json), [`workspace-api.schema.json`](agent-ui/workspace-api.schema.json), [`workspace-api.md`](agent-ui/workspace-api.md), [`workspace-commands.md`](agent-ui/workspace-commands.md), [`workspace-navigation.md`](agent-ui/workspace-navigation.md), [`callers.json`](agent-ui/callers.json)                                                                                                                                                                                                                                                     |
| [`admin-console/`](admin-console/)                                           | Admin Console                                                                                                     | Administrator browser                                                                | [`README.md`](admin-console/README.md), [`admin-contract.json`](admin-console/admin-contract.json), [`skill-discovery.md`](admin-console/skill-discovery.md), [`skill-discovery.schema.json`](admin-console/skill-discovery.schema.json), [`callers.json`](admin-console/callers.json)                                                                                                                                                                                                                                                                                                         |
| [`skill-registry/`](skill-registry/)                                         | Skill Registry; Runtime Controller owns runtime delivery; Agent ACP Service owns source reads                     | Agent Controller, Runtime Controller, Agent ACP Service, Admin Console               | [`registry-api.md`](skill-registry/registry-api.md), [`registry-api.schema.json`](skill-registry/registry-api.schema.json), [`discovery-api.md`](skill-registry/discovery-api.md), [`discovery-api.schema.json`](skill-registry/discovery-api.schema.json), [`runtime-delivery-api.md`](skill-registry/runtime-delivery-api.md), [`runtime-delivery.schema.json`](skill-registry/runtime-delivery.schema.json), [`trace-boundaries.md`](skill-registry/trace-boundaries.md), [`deployment.md`](skill-registry/deployment.md), [`callers.json`](skill-registry/callers.json)                    |
| [`skill-learning/`](skill-learning/)                                         | Shared: Agent Controller (policy), Agent ACP Service (review and records), Antnest Runtime (maintenance endpoint) | Runtime Controller, Agent UI                                                         | [`learning-api.md`](skill-learning/learning-api.md), [`learning-api.schema.json`](skill-learning/learning-api.schema.json)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [`resource-identifiers.md`](resource-identifiers.md)                         | Each ID-generating service                                                                                        | All services                                                                         | [`resource-identifiers.md`](resource-identifiers.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The deployment credential layout is defined by the
[development authentication contract](platform/development-authentication.md)
and its [machine contract](platform/development-authentication-contract.json).
The subsequent [purpose-network contract](platform/development-networks.md) and
[machine topology](platform/development-network-contract.json) are frozen;
Compose deployment and final integration remain pending; standalone transports
have separate [component evidence](../scripts/deployment/README.md).
All ten service batches are admitted; deployment and final cross-service
acceptance remain pending in the rollout ledger.

Related design documents: [Skill Registry design](../docs/skill-registry-minimal-design.md),
[Skill learning design](../docs/skill-learning-design.md),
[Skill learning notifications](../docs/skill-learning-notifications-design.md),
[Skill deployment](../docs/skill-deployment.md) and
[Stage 4 services](../docs/stage-4-services.md).

The Agent UI browser also consumes the
[Gateway session routes](edge-gateway/session-contract.json) and
[Identity browser-session lifecycle](identity/browser-sessions.md).
Its producer revision bindings are recorded separately from Node routes in
[`workspace-api.json`](agent-ui/workspace-api.json).

Channel Manager and Task Scheduler contracts are not yet defined. Workspace
control-command semantics are intended for reuse by a future Channel Manager,
but they are not a channel wire contract.

## Ownership Rules

1. A contract describes only facts that cross a process boundary.
   Service-private persistence models and deployment-provider DTOs do not
   belong here.
2. Neither peer may add an undocumented wire-only field or infer an identity
   that the contract does not carry.
3. Generated code, if introduced, must be reproducible and must not become a
   second manually maintained schema.
4. Wire contracts roll N/N-1. Only additive optional fields are compatible in
   place; anything else ships a new versioned route or schema while the
   producer keeps serving the previous version and consumers actually decode
   both shapes for at least one release before the old version retires. An
   in-place `schema_version` bump does not waive a breaking change.
5. Internal APIs must verify workload identity and route-specific caller context
   under the [platform authentication contract](platform/service-authentication.md).
   Service enforcement is admitted per owner in its rollout ledger; coordinated
   deployment and final integration remain pending. Private network membership
   is not proof of identity. Business preconditions,
   idempotency, compare-and-swap behavior and stable error codes remain with
   the owning service.
6. The owner proposes changes. Consumers review compatibility and rollout
   semantics before an implementation changes. Change the shared contract
   first, then each owning service, then run cross-service integration.

## Golden Examples

Producer golden examples live under `<area>/examples/` and are enumerated in
[`golden-manifest.json`](golden-manifest.json): every entry names its schema,
the producing service and every consumer. Goldens are captured from actual
producer output, never hand-authored response fixtures. Producers render them
from synthetic input only, with deterministic identifiers and clocks and
redacted synthetic credentials. A golden suite rewrites them only on explicit
opt-in (`UPDATE_GOLDEN=1` or its `-update` flag); without it a mismatch
fails. Current and preserved N-1 goldens are immutable once recorded, and
each consumer runs the same file through its real parser. Response parsers
tolerate unknown fields recursively so additive N+1 fields keep decoding,
while request schemas stay strict. Golden coverage never weakens authority,
known-validation or secret checks.

`schema_version` stays optional during the version-1 rollout — its absence
means the historical N-1 shape — on execution snapshots, RuntimeSpec, RC
observations, and ACP audit envelopes/rows; a v2 publication keeps
`schema_version` 2. Agent Controller `agent_event` rows instead REQUIRE
`schema_version` 1 or 2 (unversioned events are rejected). Version markers
apply to platform-owned documents and event DTOs, never to the external ACP SDK
protocol. Response tolerance never weakens request or security checks.

The producer→consumer evidence matrix and rolling N/N-1 deployment rules are
in [`contract-rollout.md`](contract-rollout.md).

`scripts/check-contract-compatibility.mjs` gates pull requests as a
conservative, syntactic additive-only checker. It is not a general schema
diff or a semantic-compatibility proof: when a genuinely safe change trips a
false positive, ship a new version instead of bypassing the gate.

## Validation

Each implementation validates its own encoder, decoder, and domain mapping
against these files; Runtime and Runtime Egress consume the same packet
fixtures without sharing source code. Commands run from the repository root:

| Command                                                                    | Covers                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make test`                                                                | `make test-go`, `make test-rust` and `make test-node`                                                                                                                                         |
| `make test-go`                                                             | Go service tests, including the Agent Controller, Identity, Edge Gateway, Admin Console and Skill Registry contract tests                                                                     |
| `make test-rust`                                                           | Antnest Runtime and Runtime Egress tests, including the packet and policy contract tests                                                                                                      |
| `make test-node`                                                           | ACP and Agent UI tests, plus the Skill learning, Skill discovery and Runtime tool contract tests below                                                                                        |
| `node --test tests/integration/skill-learning/contracts.test.mjs`          | Skill learning schema and cross-schema links                                                                                                                                                  |
| `node --test tests/integration/skill-registry/discovery-contract.test.mjs` | Skill discovery schema                                                                                                                                                                        |
| `node --test tests/integration/runtime-tools/contracts.test.mjs`           | Runtime built-in tool schema                                                                                                                                                                  |
| `make test-service-authentication`                                         | Planned caller catalogs, actual route coverage, CCT schema/signed vectors, token configuration/header/rotation vectors and the shared JSON media-type probe; no claim of listener enforcement |

These contract tests are not part of `make test` and run directly:

| Command                                                                           | Covers                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `node --test tests/integration/agent-ui/fullstack-contract.test.mjs`              | Agent UI workspace API, Gateway routes and ACP Bridge schema |
| `node --test tests/integration/admin-console/skill-discovery-contract.test.mjs`   | Console Skill source schema                                  |
| `node --test tests/integration/skill-registry/temporary-skills-contract.test.mjs` | Runtime temporary Skill schema                               |

Docker E2E targets in the [Makefile](../Makefile) validate combined data
paths: `make e2e-stage1` covers the Runtime-to-Egress path, and targets such as
`make e2e-stage3` and `make e2e-skill-deployment` cover the control plane and
Skill workflows.

## Common error model

[`common/error.schema.json`](common/error.schema.json) defines the shared
draft 2020-12 API error envelope for #67: `code`, `category`, `message`,
`retryable` and `request_id` are required, `details` is an optional object,
and additional properties stay permitted for expand-migrate changes. The
platform-owned version-1 registry in [`common/errors.json`](common/errors.json)
lists the nine categories and canonical codes plus deprecated alias codes
that keep their old wire values. Each service declares the codes it emits in
a `common/slices/<service>.json` file; `scripts/generate-api-errors.mjs`
renders the checked-in Go, TypeScript and Rust constant sets from those
slices, and `--check` keeps the generated files fresh in CI. Rendering runs
the source through `gofmt`, so generation and `--check` require the Go
toolchain on `PATH` (installed in CI). Service error envelope migrations
remain per-service batches under the same issue.
