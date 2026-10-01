# Skill Registry

Skill Registry owns immutable system Skill packages and versions. It validates
ZIPs, stores metadata and exact artifact bytes in its own PostgreSQL database,
and serves fixed-version resolution and downloads to trusted control-plane
callers. The [B0 API contract](../../contracts/skill-registry/registry-api.md)
defines limits, canonical digests, routes and errors. The
[Stage 4 design](../../docs/skill-registry-minimal-design.md) records separate
Controller, Runtime Controller, ACP and Console delivery batches.

Registry D1 now also owns a metadata-only dynamic source directory, literal
name/description search, current-source inspection, verified temporary package
reads and explicit promotion into immutable formal versions. Projection never
stores the source ZIP/body or takes over its lifecycle. Only promotion persists
the complete package, source provenance and command receipt atomically. The
[discovery contract](../../contracts/skill-registry/discovery-api.md) defines
this boundary. The [D1 report](../../docs/skill-discovery-registry-delivery-20261001.md)
records admission and pending consumers. ACP's automatic producer/source routes
are admitted separately in [D2](../../docs/skill-discovery-acp-delivery-20261001.md).
ACP's model find/load text tools are admitted in
[D3](../../docs/skill-discovery-tools-delivery-20261001.md). Runtime/ACP temporary
file delivery is admitted in [D4A](../../docs/skill-discovery-temporary-consumer-delivery-20261001.md),
and Console source preview/promotion in [D6](../../docs/skill-discovery-console-delivery-20261001.md).
[DI1](../../docs/skill-propagation-integration-delivery-20261001.md) passes actual
automatic learning, source use, login/promotion and frozen Template/create/rebuild/Run.

[D1A](../../docs/skill-discovery-caller-registry-delivery-20261001.md) adds optional
trusted `requesting_agent_id` search context. Personal projections of that Agent
are excluded before candidate limits and source inspection; formal versions stay
eligible. Null/empty/invalid IDs are rejected. This grants no reading authority.
Console preview omits the context. ACP derivation and real foreground acceptance
have separate gates: [D3A](../../docs/skill-discovery-caller-acp-delivery-20261001.md)
passes consumer unit/HTTP/PostgreSQL checks;
[DI3](../../docs/skill-discovery-caller-integration-delivery-20261001.md) now also
passes actual active-Run formal/peer loads, local Skill availability and source Trace parents.

Run from this module with `go run ./cmd/skill-registry`. Required settings:

- `ANTNEST_SKILL_REGISTRY_DATABASE_URL`: URL of this service's dedicated
  PostgreSQL database and restricted account.
- `ANTNEST_SKILL_REGISTRY_API_TOKEN`: secret of at least 32 bytes, held only by
  trusted internal callers. Do not place it in a URL, image or repository.
- `ANTNEST_SKILL_REGISTRY_LISTEN`: optional, defaults to `:8080`.
- `ANTNEST_SKILL_REGISTRY_SOURCE_URL` and `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`:
  optional paired settings for one private ACP source origin and a distinct
  read-only source-route bearer secret of at least 32 bytes. Both unset leaves
  formal reads/search available and Agent source reads explicitly unavailable.
  URL credentials, query/fragment and path prefixes are rejected. Do not enable
  this unless it points to ACP's admitted [D2 source implementation](../../docs/skill-discovery-acp-delivery-20261001.md),
  with matching ACP Registry/source settings; shared development deployment stays opt-in.

In the standard Compose stack, the source URL/token pair and ACP's matching
settings derive from one `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`. The
[deployment guide](../../docs/skill-deployment.md) describes opt-in configuration;
the formal Registry API bearer remains separate.

Registry HTTP tracing follows the [D1T boundary contract](../../contracts/skill-registry/trace-boundaries.md).
Inbound W3C context becomes a native SERVER span; the source reader injects its
actual HTTP CLIENT child, retained through response EOF/close/cancellation. HTTP
tracing never records headers, queries, Skill/projection bodies or package bytes,
including when the RPC-content switch is enabled. Export uses the pinned Go OTel
SDK with `OTEL_TRACES_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT` (or its traces
endpoint) and `http/protobuf`. `OTEL_SDK_DISABLED=true` or exporter `none` keeps
context propagation while disabling export. Shutdown flushes after HTTP shutdown
with a five-second bound. Ordinary deployment wiring and the independent
[DI3 integration](../../docs/skill-discovery-caller-integration-delivery-20261001.md)
now pass, including Registry SERVER/CLIENT parents in the actual calling Run Trace.

Startup pings PostgreSQL and applies the embedded, ordered checksum-checked schema
migration. `GET /status` checks database readiness. Service routes require the
bearer token; the service must be placed on a private control network. The
deployment must keep it off `antnest-runtime-management` and deny Runtime
direct and Egress access to its addresses. The development Compose topology
connects Admin Console, Agent Controller and Runtime Controller as separate
consumers. The disposable I1 check covers their basic creation, Run and rebuild
chain and Runtime denial of the Registry service name and actual private IPv4
through `antnest0`. The same check proves this deployment has no Registry IPv6
address and fails if one appears without a corresponding denial probe.
The current per-Agent Skill volumes also pass offline backup/restore and
Registry-offline Enable gates. Legacy shared-volume migration is outside the
current clean-development-deployment scope.

Run local unit tests with `GOWORK=off go test ./...` from this directory;
`go.work` also includes unrelated service modules. The scoped
Registry＋PostgreSQL＋Admin Console Docker E2E has passed. Controller and Runtime
Controller have local gates, and the basic full-chain Docker E2E passes via
`make e2e-stage3-skill-delivery` after the Stage 3 images are built.
The isolated PostgreSQL component test under root `tests/integration/go/skill-registry/`
verifies restart replay, exact artifact persistence, organization isolation,
and concurrent revision CAS with rollback of the losing receipt. Run it through
`tests/integration/go/run.mjs skill-registry --package internal/registry` with
`ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL` pointed at an isolated database.
The root `tests/integration/skill-registry/run-registry-rc-prepare.sh` checks
Registry→Runtime Controller preparation and Initialize consumption using isolated
processes, PostgreSQL, a Docker named volume and a test Runtime image. The full
Agent workflow is covered by the separate Stage 3 Skill delivery E2E; this
focused check remains useful for volume and mount fault localization.
Set `ANTNEST_TEST_REAL_RUNTIME_IMAGE=antnest/antnest-runtime:local` after building
the Runtime image to include its real `info`/`read`/`write`/`edit` checks.
The focused Docker check also verifies that root and UID 1000 cannot mutate
the mounted system Skill by writing, deleting, renaming, changing permissions,
or creating a link, and that a workspace link cannot write through to it.
Run `make integration-stage4-skill-slow-prepare` for the opt-in duration gate.
It delays five exact-version artifact downloads by 25 seconds each, then checks
that one RC preparation exceeds the default 120-second lifecycle mutation
budget, reports per-package progress, and finishes with a verified five-Skill
Docker volume. Its proxy and Docker resources are disposable.
Run `make integration-stage4-skill-restart-prepare` to interrupt that same
five-package preparation after its first persistent checkpoint with a graceful
RC restart. It verifies continuation without downloading the first package
again, the final progress and manifest, and disposable resource cleanup.
