# Skill Registry

Skill Registry is Antnest's private store of immutable system Skill packages.
It validates Skill ZIP archives, stores their metadata and exact artifact bytes
in its own PostgreSQL database, and serves fixed-version resolution and
downloads to trusted control-plane callers. It is written in Go.

The Registry also keeps a metadata-only directory of personal Skills that
Agents have learned. These dynamic source mappings let another Agent of the
same owner find and temporarily load such a Skill, and let an administrator
promote it into an immutable formal version. A mapping never stores the source
ZIP or Skill body; the Registry takes custody of package bytes only when a
promotion commits.

## Responsibilities

- Own a private PostgreSQL schema and its embedded, checksum-checked migrations.
- Validate Skill ZIP archives under package rules version 1 and compute the
  canonical `artifact_digest` and `content_digest`.
- Store immutable Skill versions, their file manifests and exact ZIP bytes,
  with organization-scoped unique names and compare-and-set version appends.
- Record organization-scoped idempotency receipts shared by upload and
  promotion requests.
- List Skills and versions, resolve fixed `skill_id` + `version` references,
  and serve exact artifacts.
- Store dynamic source mappings (organization, Agent, owner, name,
  description, sequence, content digest, active state) with sequence ordering
  and tombstones.
- Search formal heads and owner-scoped source mappings with literal,
  case-insensitive name and description matching, then confirm source
  candidates against the current source.
- Load a selected formal or source Skill as verified ZIP bytes without
  retaining source bytes.
- Promote a source Skill into a formal version, committing the version,
  receipt and source provenance atomically.
- Emit OpenTelemetry traces for inbound HTTP requests and outbound source reads.

## Non-responsibilities

- It does not authenticate end users or decide publication permissions. Callers
  derive the organization and actor from their own trusted principal.
- It does not prepare Skill volumes, mount Skills into Runtimes or manage Agent
  lifecycle. Runtime Controller owns preparation and mounting.
- It does not store, edit or delete Agent-owned source packages. Agent ACP
  Service owns personal Skill content and its lifecycle.
- It does not run learning, model inference or Runtime tool calls.
- It does not offer update or delete routes for committed versions.
- It does not rank results with vectors or popularity, and search has no
  pagination.
- It does not export metrics or logs over OTLP, and it does not trace SQL.
- It does not read another service's database.

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | `GET /status` (no authentication) | Readiness; pings PostgreSQL with a two-second bound |
| Inbound | `POST /internal/skills`, `POST /internal/skills/{skill_id}/versions` | Multipart upload of a new Skill or a new version |
| Inbound | `GET /internal/skills`, `GET /internal/skills/{skill_id}/versions` | Paged lists of Skill heads and versions |
| Inbound | `POST /internal/skill-versions/resolve` | Resolve up to 32 fixed references to version metadata |
| Inbound | `GET /internal/skills/{skill_id}/versions/{version}/artifact` | Exact ZIP download |
| Inbound | `PUT /internal/skill-projections` | Apply a source mapping event |
| Inbound | `POST /internal/skill-discovery/search`, `POST /internal/skill-discovery/load` | Find and load formal or source Skills |
| Inbound | `POST /internal/skill-projections/promote` | Promote a source Skill to a formal version |
| Outbound | `POST /internal/skill-sources/inspect`, `POST /internal/skill-sources/artifact` on Agent ACP Service | Confirm current source metadata and fetch current source bytes |
| Outbound | PostgreSQL | Registry-owned schema |
| Outbound | OTLP HTTP | Trace export when enabled |

All `/internal/` routes require `Authorization: Bearer <ANTNEST_SKILL_REGISTRY_API_TOKEN>`.
Admin Console, Agent Controller, Runtime Controller and Agent ACP Service are
the callers in the standard Compose deployment. The route contracts are in
[`registry-api.md`](../../contracts/skill-registry/registry-api.md) and
[`discovery-api.md`](../../contracts/skill-registry/discovery-api.md).

## Configuration

Configuration is read from the environment at startup.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_SKILL_REGISTRY_DATABASE_URL` | yes | none | PostgreSQL connection URL for this service's dedicated database and restricted role |
| `ANTNEST_SKILL_REGISTRY_API_TOKEN` | yes | none | Bearer secret for all `/internal/` routes; at least 32 bytes with no leading or trailing whitespace. Never place it in a URL, image or repository |
| `ANTNEST_SKILL_REGISTRY_LISTEN` | no | `:8080` | HTTP listen address in `host:port` form; `--healthcheck` uses its port |
| `ANTNEST_SKILL_REGISTRY_SOURCE_URL` | no | empty | Agent ACP Service origin for source reads: `http` or `https`, no credentials, query, fragment or path prefix. Set together with the source token |
| `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` | no | empty | Bearer secret for the ACP source routes; at least 32 bytes, no surrounding whitespace or line breaks. Set together with the source URL |
| `OTEL_SDK_DISABLED` | no | unset | `true` (case-insensitive) disables trace export while keeping W3C propagation |
| `OTEL_TRACES_EXPORTER` | no | unset | `otlp` or `none`; any other value fails startup |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | OTLP HTTP base URL |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | unset | OTLP HTTP traces endpoint; overrides the base URL |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | no | unset | Only `http/protobuf` is accepted |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | no | unset | Only `http/protobuf` is accepted; overrides the general protocol |
| `OTEL_SERVICE_NAME` | no | `skill-registry` | `service.name` resource attribute |

If both source settings are empty, formal routes and formal search results
work, but any search or load that needs an Agent source returns
`source_unavailable`. Setting only one of the pair fails startup.

Trace export is enabled only when it is not disabled and at least one of
`OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. The OTLP exporter and resource
detector also read the standard OpenTelemetry SDK variables, such as
`OTEL_RESOURCE_ATTRIBUTES` and exporter header or timeout settings.

In the standard Compose stack, one `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` value
enables the source pair on both the Registry and ACP. The
[Skill deployment guide](../../docs/skill-deployment.md) and the
[deployment wiring contract](../../contracts/skill-registry/deployment.md)
describe that opt-in.

## Dependencies

- PostgreSQL database and role owned by this service. Startup pings the
  database once and exits if it is unreachable, then applies migrations before
  opening the listener. Later database loss makes `/status` and data routes
  return 503.
- Agent ACP Service, only when the source settings are configured. Source
  failures affect only searches and loads that involve Agent sources; formal
  reads keep working.
- An OTLP collector is optional and is not part of readiness.
- Network placement: the Registry belongs on a private control network. Keep
  it off the Runtime management and Egress networks, deny Runtime direct and
  Egress access to its addresses, and expose no host port.

## Build and test

Run unit tests from this directory. `GOWORK=off` keeps the root `go.work`
from pulling in unrelated service modules:

```bash
cd services/skill-registry && GOWORK=off go test ./...
```

Run from the repository root:

```bash
node tests/integration/go/run.mjs skill-registry
make integration-stage4-skill-prepare
make e2e-skill-discovery-registry
docker compose --profile stage3 build skill-registry
```

- `node tests/integration/go/run.mjs skill-registry` overlays the component
  tests in [`tests/integration/go/skill-registry`](../../tests/integration/go/skill-registry)
  onto this module and runs them. Add `--package internal/registry` to limit
  the run. The PostgreSQL tests cover restart replay, exact artifact
  persistence, organization isolation, concurrent version compare-and-set and
  rollback of the losing receipt.
- `make integration-stage4-skill-prepare` checks Registry to Runtime
  Controller preparation and Runtime Initialize consumption with isolated
  processes, PostgreSQL, a Docker named volume and a test Runtime image. It
  also checks that root and UID 1000 cannot modify the mounted system Skill.
  `make integration-stage4-skill-slow-prepare` and
  `make integration-stage4-skill-restart-prepare` add slow-download and
  graceful-restart variants.
- `make e2e-skill-discovery-registry` runs the Registry discovery Docker E2E.
  `make e2e-skill-registry-trace` adds the trace chain check.
- `docker compose --profile stage3 build skill-registry` builds
  `antnest/skill-registry:local`. The equivalent direct command is
  `docker build -f services/skill-registry/Dockerfile -t antnest/skill-registry:local .`
  with the repository root as the build context.
- `make test-go-unit` and `make test-go` include this module.
  `make e2e-stage3-skill-delivery` runs the full Agent Skill delivery workflow
  after the Stage 3 images are built, and `make e2e-skill-propagation` runs the
  learning, discovery, temporary use and promotion workflow.

Test-only variables:

- `ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL` - isolated PostgreSQL database for
  the component tests. The PostgreSQL tests skip when it is unset.
- `ANTNEST_TEST_REAL_RUNTIME_IMAGE` - set to `antnest/antnest-runtime:local`
  after building the Runtime image to include real Runtime file-tool checks in
  the preparation test.

## Documentation

- [Architecture](docs/architecture.md) - package layout, ownership boundaries,
  storage, request flows, security, observability and failure handling.
- [Skill Registry design](../../docs/skill-registry-minimal-design.md) -
  cross-service design for system Skills, discovery and promotion.
- [Skill learning design](../../docs/skill-learning-design.md) - how Agents
  produce the personal Skills that become source mappings.
- [Skill deployment guide](../../docs/skill-deployment.md) - operator
  configuration for learning and discovery.
- [Registry API](../../contracts/skill-registry/registry-api.md) - package
  rules, digests, formal routes and errors.
- [Discovery API](../../contracts/skill-registry/discovery-api.md) - source
  mappings, search, load, promotion and ACP source routes.
- [Runtime delivery API](../../contracts/skill-registry/runtime-delivery-api.md) -
  Runtime Controller system-Skill preparation boundary.
- [Trace boundaries](../../contracts/skill-registry/trace-boundaries.md) -
  HTTP span model.
- [Deployment wiring](../../contracts/skill-registry/deployment.md) - Compose
  wiring for source and trace settings.
