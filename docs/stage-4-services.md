# Stage 4: Skill hosting, external channels and scheduled tasks

This document describes the Stage 4 service layer: the services it adds, their
responsibility boundaries, and the rules that govern how their contracts and
implementations are delivered. Skill Registry is implemented. Channel Manager
and Task Scheduler are planned and not implemented.

## Scope and naming

Stage 4 adds **three services**:

| Service ID        | Name            | Core responsibility                                                                                                                                | Status          |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `skill-registry`  | Skill Registry  | Hosted Skill repository. Manages immutable versions, supports template references and read-only Runtime delivery, and maps Agent sources for dynamic discovery | Implemented     |
| `channel-manager` | Channel Manager | External channel interaction hub that connects external channels to platform Agent sessions                                                       | Not implemented |
| `task-scheduler`  | Task Scheduler  | Scheduled task hub that manages schedules and triggers Agent tasks                                                                                | Not implemented |

Service IDs follow the repository's lowercase, hyphenated style. Channel
Manager covers the responsibility earlier described as a Channel Gateway, and
Task Scheduler covers the earlier Scheduler. They are new names for the same
planned responsibilities, not additional services.

## Service responsibility boundaries

These boundaries follow the [service ownership conventions](service-layout.md)
and form the scope baseline for further design. The
[minimal design](skill-registry-minimal-design.md) covers Skill Registry's
technical choices, and its Registry-owned interface contracts are published
under [contracts/skill-registry](../contracts/skill-registry/registry-api.md).
The interfaces, data structures and implementation technology of the other two
services are still to be designed.

### Skill Registry: hosted Skill repository

The first version of Skill Registry has three responsibilities, detailed in the
[minimal design](skill-registry-minimal-design.md):

1. Host Skill packages and their immutable versions, and provide
   organization-scoped metadata queries and pinned artifact downloads.
2. Let a Skill be part of an Agent Template. The template references an
   explicit version, which is frozen together with the template and the
   AgentSpec.
3. Let Runtime Controller prepare the collection before a lifecycle change and
   deliver it read-only according to the target template on create or rebuild.
   System Skills are read-only and form the Agent's base capabilities; personal
   Skills and the workspace are preserved.

Registry owns only packages and versions. Template selection belongs to Agent
Controller, and the isolated copy and mount belong to Runtime Controller. The
first version reuses Runtime discovery and on-demand reads, and ACP no longer
carries Skill bodies through the legacy instruction channel. External import,
search recommendations, review and evaluation, community features and hot
update are out of scope. Publishing a new version does not change existing
Agents.

Preparation runs before Initialize, Drain and Fence. Prepared collections are
reused per Agent and per collection digest, and preparation resumes after
transient failures. A shared YAML sample set validates real types. The
[runtime delivery contract](../contracts/skill-registry/runtime-delivery-api.md)
defines this boundary.

The separate [Skill learning design](skill-learning-design.md) automatically
creates and updates managed personal Skills, activates them while the Agent is
idle according to policy, and shows result notices. Manual saving is a
supplement. Skill learning adds no new service and does not depend on Registry.
Its shared contract is the
[Skill learning API](../contracts/skill-learning/learning-api.md).

Skills propagate between Agents in four steps: **an Agent Skill is projected
automatically into Registry, then found and used temporarily in the current
Run, then promoted by a user to a formal system Skill, and finally provided as
a preset capability through a Template and rebuild**. Projection registers only
dynamic metadata and a source reference for an applied managed personal Skill.
Temporary use reads back from the source on demand, and the source content and
its lifecycle remain owned by the Agent. Only promotion hands the full package
to Registry, which hosts it as an independent immutable formal version.
Templates continue to reference formal versions only. The contracts for this
workflow are:

- [Skill discovery and promotion](../contracts/skill-registry/discovery-api.md):
  the shared Registry/source contract, including source mappings, search, load
  and promotion.
- [ACP Skill discovery tools](../contracts/agent-acp/skill-discovery-tools.md):
  the `find_skill` and `load_skill` model tools. A Run can find the current
  formal version and another Agent's source, and the caller's own personal
  mapping is excluded.
- [Runtime temporary Skill delivery](../contracts/runtime/temporary-skills.md)
  and the [ACP temporary Skill consumer](../contracts/agent-acp/skill-temporary-consumer.md):
  real package files for the current foreground Run, usable through ordinary
  read and Bash tools, with durable cleanup, cancellation and restart recovery.
- [Console Skill source discovery and promotion](../contracts/admin-console/skill-discovery.md):
  source search, package preview, and explicit promotion as a new Skill or as
  an appended version.
- [Skill Registry HTTP Trace boundaries](../contracts/skill-registry/trace-boundaries.md):
  source HTTP tracing with body capture disabled.

Source lifecycle operations follow the source: after Disable, source reads are
unavailable; Enable restores the original identity; after Delete, reads are
rejected and a tombstone is delivered. Promoted artifacts and presets are
independent of the source lifecycle. The [deployment guide](skill-deployment.md)
covers the separate source bearer token and the rebuild requirement for
existing Runtimes.

Runtime access to Registry is denied by service name and by actual IPv4
address. The Registry network does not enable IPv6. If IPv6 is enabled, actual
IPv6 address denial must be tested as well.

### Channel Manager: external channel interaction hub

- Manages channel connections, Agent bindings, the mapping between external
  conversations and ACP Sessions, inbound message receipts and outbound
  delivery records.
- Translates external messages and `/` control commands into authorized
  platform operations, and reports execution state and results back to the
  originating channel.
- Does not take over platform identity authority, Agent lifecycle, ACP
  Session/Run state or model execution. Does not depend on browser pages,
  browser cookies or Agent UI's temporary selection state.
- To be designed: the first supported channels, external identity binding,
  channel credentials and callback verification, deduplication and delivery
  retries, reconnect recovery, approval interaction, and how control commands
  reuse the backend.

Agent UI provides 11 control commands and their semantic contract, defined in
[workspace control commands](../contracts/agent-ui/workspace-commands.md).
Channel Manager is a planned consumer of these commands. The private browser
HTTP interface does not become the channel integration contract. Cross-channel
session and model configuration coordination requires its own verification.

### Task Scheduler: scheduled task hub

- Manages schedules, their enabled state and trigger records, issues Agent
  usage requests on schedule and correlates execution results.
- Agent Controller continues to own Agent configuration and lifecycle. ACP
  Service continues to own execution admission, Sessions, Runs and execution
  audit. A trigger does not mean that the business execution succeeded.
- Does not build a second Agent execution loop, does not take over Tool
  execution and does not read other services' databases.
- To be designed: time rules and time zones, execution identity, creating or
  reusing Sessions, overlapping executions, missed triggers, deduplication and
  failure retries, restart recovery, and whether the scheduling engine reuses
  the existing Temporal deployment.

## Relationship to Stage 3

Stage 4 builds on the [Stage 3 admin control plane](stage-3-admin-control-plane.md).
Its new service scope is limited to the three services above. Kubernetes,
multi-node or high-availability deployment and an independent Audit Service are
not part of Stage 4. Existing services may need consumer adaptations, but the
scope and interfaces of those adaptations must be defined in shared contracts.
The business records of a new service must not be stored in Console's or any
other service's database.

## Delivery rules

Following the repository [AGENTS.md](../AGENTS.md), implementation proceeds as
follows:

1. **Shared contract first**: define the resources each service owns,
   authorization, inputs and outputs, idempotency and failure semantics,
   dependency readiness conditions, and the cross-service verification path.
   This document is a plan, not an executable interface contract.
2. **Independent service delivery**: each service is delivered on its own. Write
   behavior tests first, then implement, and maintain that service's
   documentation and tests together with it. Consumer adaptations in other
   services are recorded and delivered separately.
3. **Explicit integration**: after producers and consumers pass their local
   gates, verify the complete business workflows for Skill use, external
   channel interaction and scheduled task triggers.
4. **Stage completion**: a delivery is complete only after its unit, contract,
   component and applicable Docker E2E evidence passes. A completed service
   does not mean that a whole business workflow is complete.

Skill Registry uses Go and PostgreSQL, ZIP artifacts, pinned template versions
and per-Agent read-only volumes. Channel Manager and Task Scheduler have not
entered detailed technical design. Service unit tests, root integration and E2E
tests, and private evidence follow the
[test ownership and storage rules](../tests/README.md).
