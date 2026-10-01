# Antnest Platform Contracts

This directory is the language-neutral boundary between independently
deployable components. It contains wire contracts and shared fixtures, not
generated application models, persistence records, or reusable business code.

## Active Contracts

[Platform resource identifiers](resource-identifiers.md) defines generation of
new resource IDs across service owners; consumers retain opaque-ID semantics.

The [Skill deployment contract](skill-registry/deployment.md) defines standard
Compose wiring for the admitted learning/source/discovery workflow. It introduces
no new service API; [deployment evidence](../docs/skill-deployment-delivery-20261001.md)
and the [operator guide](../docs/skill-deployment.md) cover its configuration.

| Contract                                                                                                                                 | Owner              | Required reviewers                                         | Consumers                                                           | Purpose                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`runtime/contract.json`](runtime/contract.json)                                                                                         | Antnest Runtime    | ACP Service, Agent Controller                              | Runtime Controller, ACP Service, and Antnest Runtime                | Runtime status and MCP surface                                                                                                              |
| [`runtime/builtin-tools.schema.json`](runtime/builtin-tools.schema.json)                                                                 | Antnest Runtime    | ACP Service                                                | Runtime, ACP model/maintenance callers and integration/E2E fixtures | Public read/write/edit string paths, 1-based line reads and Bash defaults                                                                   |
| [`runtime/runtime-spec.schema.json`](runtime/runtime-spec.schema.json)                                                                   | Runtime Controller | Antnest Runtime                                            | Runtime Controller and Antnest Runtime                              | Controller-resolved immutable Runtime bootstrap input                                                                                       |
| [`runtime/packet-contract.json`](runtime/packet-contract.json)                                                                           | Runtime Egress     | Antnest Runtime                                            | Antnest Runtime and Runtime Egress                                  | Machine-readable raw-IP-over-UDP contract                                                                                                   |
| [`runtime/packet-format.md`](runtime/packet-format.md)                                                                                   | Runtime Egress     | Antnest Runtime                                            | Antnest Runtime and Runtime Egress                                  | Raw-IP-over-UDP semantics and evolution                                                                                                     |
| [`runtime/packet-fixtures.json`](runtime/packet-fixtures.json)                                                                           | Runtime Egress     | Antnest Runtime                                            | Antnest Runtime and Runtime Egress tests                            | Shared accepted and rejected packet examples                                                                                                |
| [`egress/control-contract.json`](egress/control-contract.json)                                                                           | Runtime Egress     | Agent Controller                                           | Agent Controller and Runtime Egress                                 | Machine-readable trusted internal control RPC surface                                                                                       |
| [`egress/control-api.md`](egress/control-api.md)                                                                                         | Runtime Egress     | Agent Controller                                           | Agent Controller and Runtime Egress                                 | Trusted internal network-control RPC semantics                                                                                              |
| [`egress/policy.schema.json`](egress/policy.schema.json)                                                                                 | Runtime Egress     | Agent Controller                                           | Runtime Egress control callers and tests                            | Immutable Egress policy revision schema                                                                                                     |
| [`../services/runtime-controller/api/control-contract.json`](../services/runtime-controller/api/control-contract.json)                   | Runtime Controller | Agent Controller                                           | Agent Controller and Runtime Controller                             | Machine-readable deployment RPC surface                                                                                                     |
| [`../services/runtime-controller/api/control-api.md`](../services/runtime-controller/api/control-api.md)                                 | Runtime Controller | Agent Controller                                           | Agent Controller and Runtime Controller                             | Logical Runtime lifecycle, operation, and observation semantics                                                                             |
| [`../services/runtime-controller/api/runtime-deployment.schema.json`](../services/runtime-controller/api/runtime-deployment.schema.json) | Runtime Controller | Agent Controller                                           | Agent Controller and Runtime Controller                             | Language-neutral Runtime configuration input                                                                                                |
| [`agent-controller/control-contract.json`](agent-controller/control-contract.json)                                                       | Agent Controller   | Identity Service and administrative clients                | Internal Agent management clients                                   | Machine-readable ModelProfile, Template, Agent lifecycle, projection-query, operation, and event route catalog                              |
| [`agent-controller/control-api.schema.json`](agent-controller/control-api.schema.json)                                                   | Agent Controller   | Identity Service and administrative clients                | Internal Agent management clients and contract tests                | Agent Controller management request and response schema                                                                                     |
| [`agent-controller/control-api.md`](agent-controller/control-api.md)                                                                     | Agent Controller   | Identity Service and administrative clients                | Internal Agent management clients and maintainers                   | Agent lifecycle, projection-query, ownership, and event semantics                                                                           |
| [`agent-acp/execution-api.md`](agent-acp/execution-api.md)                                                                               | Agent ACP Service  | Agent Controller, Edge Gateway, Admin Console              | Controller publication/settlement, Gateway state, Console audit     | Internal execution configuration, settlement, state and retained audit; no Controller Run ticket                                            |
| [`agent-acp/execution-snapshot.schema.json`](agent-acp/execution-snapshot.schema.json)                                                   | Agent ACP Service  | Agent Controller                                           | Controller and ACP                                                  | Organization execution snapshot with current Providers, models, access and ordered fallback                                                 |
| [`agent-acp/agent-execution-state.schema.json`](agent-acp/agent-execution-state.schema.json)                                             | Agent ACP Service  | Edge Gateway                                               | Gateway state consumers                                             | ACP-owned availability and active Session observation                                                                                       |
| [`identity/identity-contract.json`](identity/identity-contract.json)                                                                     | Identity Service   | Agent Controller, Edge Gateway, and administrative clients | Agent Controller and internal identity clients                      | Organizations, principals, local authentication, OIDC configuration, and SCIM credential administration                                     |
| [`edge-gateway/session-contract.json`](edge-gateway/session-contract.json)                                                               | Edge Gateway       | Identity Service, Agent UI and Admin Console               | Browser clients and Node Bridge                                     | Browser session, Workspace HTML/API/SSE admission, administrator admission and trusted principal projection                                 |
| [`admin-console/admin-contract.json`](admin-console/admin-contract.json)                                                                 | Admin Console      | Edge Gateway, Identity Service, and Agent Controller       | Administrator web application                                       | Stage 3A thin-BFF route and authority-field inventory                                                                                       |
| [`Console Skill source schema`](admin-console/skill-discovery.schema.json), [`semantics`](admin-console/skill-discovery.md)              | Admin Console      | Skill Registry and authenticated Gateway principal         | Administrator browser                                               | Own-Agent live source search/preview and explicit immutable promotion; exact selection/CAS, stable receipts and no implicit Template change |

## Agent UI Full-Stack Boundary

These contracts define the active development deployment. The Node Bridge and
browser use business HTTP/SSE through Gateway; the ACP extension remains an
internal producer contract.

| Contract                                                                                                                                                                                                                                                                                                        | Owner                                 | Required reviewers                                  | Consumers                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`agent-ui/workspace-api.json`](agent-ui/workspace-api.json), [`wire schema`](agent-ui/workspace-api.schema.json), [`semantics`](agent-ui/workspace-api.md)                                                                                                                                                     | Agent UI                              | Edge Gateway, ACP Service                           | Gateway and browser                                                | Authenticated HTTP/SSE route and projection boundary                                                                                                                                                                                                                                                                                                                                                         |
| [`agent-ui/workspace-commands.md`](agent-ui/workspace-commands.md)                                                                                                                                                                                                                                              | Agent UI                              | ACP Service, Edge Gateway                           | Browser; future Channel Manager pending                            | Control-command discovery, semantics and reuse of existing authorized operations                                                                                                                                                                                                                                                                                                                             |
| [`agent-acp/workspace-bridge.schema.json`](agent-acp/workspace-bridge.schema.json), [`semantics`](agent-acp/workspace-bridge.md)                                                                                                                                                                                | Agent ACP Service                     | Agent UI, Edge Gateway                              | Node Bridge                                                        | Durable prompt receipt, targeted cancel and replay delivery metadata                                                                                                                                                                                                                                                                                                                                         |
| [`agent-acp/skill-commands.md`](agent-acp/skill-commands.md)                                                                                                                                                                                                                                                    | Agent ACP Service                     | Agent UI                                            | ACP initialize and command updates                                 | Runtime Skill discovery, source-qualified selection and normal Prompt invocation                                                                                                                                                                                                                                                                                                                             |
| [`agent-acp/skill-discovery-tools.md`](agent-acp/skill-discovery-tools.md), [`model inputs`](skill-registry/discovery-api.schema.json)                                                                                                                                                                          | Agent ACP Service                     | Skill Registry, Runtime                             | Foreground model; publishing UI separately owned                   | Platform find/load catalog and dispatch, persisted Run authority, request budget and read recovery; D4A adds confirmed file use, durable scopes and cleanup admission                                                                                                                                                                                                                                        |
| [`agent-acp/skill-temporary-consumer.md`](agent-acp/skill-temporary-consumer.md)                                                                                                                                                                                                                                | Agent ACP Service                     | Antnest Runtime                                     | Current foreground Run and private recovery worker                 | D4A signed real files, durable scopes, completion/cancel/restart cleanup and foreground/learning/lifecycle admission                                                                                                                                                                                                                                                                                         |
| [`edge-gateway/session-contract.json`](edge-gateway/session-contract.json)                                                                                                                                                                                                                                      | Edge Gateway                          | Identity Service, Agent UI                          | Browser and Node Bridge                                            | Active authentication, proxy and SSE admission routes                                                                                                                                                                                                                                                                                                                                                        |
| [`skill-registry/registry-api.schema.json`](skill-registry/registry-api.schema.json), [`semantics`](skill-registry/registry-api.md)                                                                                                                                                                             | Skill Registry                        | Agent Controller, Runtime Controller, Admin Console | Internal control-plane callers                                     | Implemented publish, list, resolve and artifact boundary; local, PostgreSQL and Docker business gates pass                                                                                                                                                                                                                                                                                                   |
| [`Skill discovery schema`](skill-registry/discovery-api.schema.json), [`semantics`](skill-registry/discovery-api.md)                                                                                                                                                                                            | Skill Registry; ACP owns source reads | ACP Service, Runtime, Admin Console and Agent UI    | Internal trusted callers; model tool inputs separately constrained | Registry D1, ACP D2 automatic projection/source reads and D3 model find/load text tools pass owning gates; Runtime D4 temporary file endpoints pass; ACP D4A delivery/cleanup passes; Console D6 source preview/promotion passes; [DI1](../docs/skill-propagation-integration-delivery-20261001.md) passes actual automatic sources, current-Run use, login/promotion and frozen Template/create/rebuild/Run |
| [`runtime/temporary-skills.schema.json`](runtime/temporary-skills.schema.json), [`semantics`](runtime/temporary-skills.md)                                                                                                                                                                                      | Antnest Runtime                       | ACP Service, Runtime Controller                     | Trusted ACP; hidden from foreground tools/list                     | D4 signed Run-bound real-file install/release and effect-aware cleanup pass Runtime gates; ACP D4A durable delivery/cleanup passes its owning gates                                                                                                                                                                                                                                                          |
| [`skill-registry/runtime-delivery.schema.json`](skill-registry/runtime-delivery.schema.json), [`semantics`](skill-registry/runtime-delivery-api.md)                                                                                                                                                             | Runtime Controller                    | Agent Controller, Skill Registry                    | Agent Controller and Runtime Controller                            | Stage 4 B0 system-Skill preparation and lifecycle-consumption boundary; B3 endpoints and base I1 business path implemented                                                                                                                                                                                                                                                                                   |

Obsolete prototype contracts are deleted when their service is rewritten; they
do not remain as an implied compatibility layer.

## Stage 4 Planned Contracts

The [Stage 4 service plan](../docs/stage-4-services.md) records `skill-registry`,
`channel-manager` and `task-scheduler`. The Registry-owned route/payload boundary
and its Controller, RC, ACP and Console consumers are implemented; the other two services have no contracts or
implementation. The
[minimal Skill Registry design](../docs/skill-registry-minimal-design.md)
defines package hosting, immutable Template references, and read-only delivery
on Agent creation/rebuild. It supersedes the wider first-delivery suggestions in
the [reference analysis](../docs/skill-registry-responsibilities.md).
The [Registry contract](skill-registry/registry-api.md), JSON schema, shared
format cases and `skill` resource kind cover its producer-facing boundary.
The implemented RC preparation/lifecycle boundary provides resumable preparation
before lifecycle mutation, per-Agent sets under `layout_version`, shared YAML
verdicts under `package_rules_version`, durable references across Drain/Fence,
phase-specific invalidation recovery, and Enable preparation before NetworkEnsure.
The actual Go/Rust format tests cover Runtime's non-core numeric scalars and
reject merge keys. RC verifies the created container's actual mount, ownership
and manifest before start or recovery adoption. The execution snapshot constrains
`skill_instructions` to an empty array; ACP rejects nonempty input and has removed
the prompt branch. Console omits the old body projection, including historical
or malformed input. The [acceptance audit](../docs/skill-registry-acceptance-audit-20260928.md)
records service, component, browser and Docker evidence. Current development has
no old business data. Legacy migration/export and recovery contracts have been
removed from the published catalog and service handlers; their historical
versions remain in Git. See the [release cleanup](../docs/legacy-skill-release-cleanup-20261001.md).
The independent [learning design](../docs/skill-learning-design.md) and frozen
[L0 shared contract](skill-learning/learning-api.md) define policy-based
automatic generation/application, optional authenticated
user actions, managed personal-Skill provenance and a separate Runtime maintenance
endpoint excluded from `tools/list`, Runtime rejection of reserved Tool calls,
bound maintenance credentials, managed-call quiescence with post-swap digest
checks, exact-content application records and Controller-owned
Agent policy. Automatic application records a policy revision; the optional manual
branch records exact-candidate confirmation. Neither can be fabricated by model
output. Credentials select a `kid` from the bounded current/next bootstrap key
set. That set enters the
deployment digest and is frozen with each accepted RC operation; configuration
rotation cannot change replay input. Rotation and compromise require the explicit
rebuild/isolation procedure in the design, not assumed hot key reload.
L0 distinguishes `package_rules_version` from ACP's `review_prompt_version` and
from the collection `layout_version`. Runtime L1, RC bootstrap L1R and ACP L3
deliver the maintenance boundary separately. The initial UI provides blocker
details and a normal-Run remediation path, without a new process-kill API.
L3/LI1 now include automatic triggering, application and foreground competition;
manual saving is a later L5a/L5b/LI2 extension. L0 has schema and contract
tests; Runtime, Controller, ACP and UI consumer batches and their explicit
integration have passed the current functional gates. The
[learning audit](../docs/skill-learning-acceptance-audit-20260930.md) records the
evidence and limits. Undo, diffs, retained versions and existing-Skill adoption
remain outside the first delivery. Maintenance operations are never model tools.
The [learning notification proposal](../docs/skill-learning-notifications-design.md)
selects SDK 1.5.0's experimental `notice` for live delivery. L0 defines notice
capability negotiation, namespaced change metadata and delivery/source-session routing;
Server persists learning results, Bridge reconciles them after reconnect, and FE
deduplicates the existing SSE views. Bounded result queries support recovery and
history, independently of ACP output watermarks and `session/load` replay.
L0 defines notice metadata and optional workspace projection fields; the
producer and consumer implementations pass service, component and real Docker
browser gates. Human experience acceptance follows functional completion.
Workspace command semantics are preparation for a future
Channel Manager consumer, not an existing channel wire contract. Each owning
service must define its shared boundary before implementation and track consumer
delivery separately from its own local acceptance.

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
