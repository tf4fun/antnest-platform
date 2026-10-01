# Skill Registry Architecture

This document describes the internal design of Skill Registry: its package
layout, data model, package validation, request flows and failure semantics.
The [service README](../README.md) lists routes and configuration. The route
contracts are the [Registry API](../../../contracts/skill-registry/registry-api.md)
and the [Discovery API](../../../contracts/skill-registry/discovery-api.md).

## Components

| Path | Role |
| --- | --- |
| `cmd/skill-registry/main.go` | Configuration, telemetry setup, database pool (8 connections), startup migrations, HTTP server, signal handling and the `--healthcheck` probe |
| `internal/registry/package.go` | Package rules version 1: ZIP and `SKILL.md` validation and digest computation |
| `internal/registry/service.go` | Formal Skill publication, listing, resolution and artifact reads |
| `internal/registry/discovery.go` | Source mappings, search, load and promotion |
| `internal/registry/postgres.go`, `discovery_postgres.go` | PostgreSQL store |
| `internal/registry/migrations.go`, `migrations/*.sql` | Embedded, checksum-checked schema migrations |
| `internal/registry/http.go`, `discovery_http.go` | HTTP routing, bearer authentication, admission slots and error mapping |
| `internal/registry/source_http.go` | Client for the Agent ACP Service source routes |
| `internal/registry/errors.go` | Typed error kinds; untyped errors map to `temporarily_unavailable` |
| `internal/telemetry/` | OpenTelemetry setup, inbound server spans and outbound client spans |

## Data Model

Migrations run at startup inside one transaction that holds
`pg_advisory_xact_lock`. The `schema_migrations` table records each applied
file with its checksum. A changed checksum stops startup.

| Table | Key | Content |
| --- | --- | --- |
| `skills` | `skill_id` | Organization, `name`, `current_version`, creator. `UNIQUE (organization_id, name)` |
| `skill_versions` | `(skill_id, version)` | `metadata` and `file_manifest` JSON, exact ZIP bytes in `artifact` (1 byte to 8 MiB), creator |
| `command_receipts` | `(organization_id, request_id)` | Request fingerprint and the committed result |
| `skill_projections` | `(organization_id, agent_id, name)` | Source mapping: owner, description, `sequence`, `content_digest`, `active` |
| `skill_version_sources` | `(skill_id, version)` | Source provenance for promoted versions |

Versions reference their Skill with `ON DELETE RESTRICT`, and no route updates
or deletes a committed version. Identifier formats are enforced by `CHECK`
constraints: `org_`, `agent_`, `user_` and `skill_` followed by 32 lowercase hex
digits, and `sha256:` followed by 64 hex digits.

## Package Validation

`ValidatePackage` applies package rules version 1:

- The ZIP is 1 byte to 8 MiB with 1 to 256 entries. The unpacked total is at
  most 32 MiB, and `SKILL.md` is at most 16 KiB.
- Entry paths are relative UTF-8, at most 512 bytes and 16 segments, with no
  empty, `.` or `..` segments, backslashes or NUL bytes. Paths are unique, and a
  file cannot also be a parent directory.
- Encrypted entries, non-UTF-8 names, symlinks and other non-regular entries are
  rejected. Only the ZIP64 and extended-timestamp extra fields are allowed, each
  at most once. Directories carry no data.
- Each entry is decompressed under its size limit, and its actual size must
  equal the declared size. Reads stop when the request context ends.
- A root `SKILL.md` is required. It is UTF-8 without a BOM and starts with an
  exact `---` frontmatter block. The frontmatter is one YAML mapping with no
  document end marker, multiple documents, anchors, aliases, explicit tags,
  merge keys or duplicate keys. `name` and `description` must be portable YAML
  strings.

The `artifact_digest` is the SHA-256 of the exact ZIP bytes. The
`content_digest` is the SHA-256 of the domain string
`antnest-skill-manifest-v1\x00` followed by, for each file in path order, the
path length and path, the size, the file SHA-256 and an executable flag. Two
ZIPs with identical files and modes therefore share a `content_digest` even
when their bytes differ.

## Upload and Version Append

`POST /internal/skills` creates a Skill. `POST /internal/skills/{skill_id}/versions`
appends a version and requires `expected_version`. Both take a multipart body
of at most 9 MiB.

1. The service validates the request ID (1 to 128 printable ASCII bytes), the
   organization and actor IDs and the target.
2. It computes a fingerprint from the action, organization, actor, target,
   expected version and `artifact_digest`, and looks up the receipt for
   `(organization_id, request_id)`. A matching receipt returns the stored
   result. A different fingerprint returns `request_conflict`.
3. It validates the package and, for a create, generates a random `skill_id`.
4. In one transaction the store claims the receipt row, then inserts the Skill
   or locks it with `FOR UPDATE`. An append must keep the same name and match
   `current_version`; otherwise it fails with `invalid_package` or
   `revision_conflict`. The store inserts the version and writes the result
   into the receipt.

A duplicate name in the organization returns `name_conflict`. Concurrent
appends to one Skill serialize on the row lock, and the loser rolls back its
receipt.

## Resolution and Artifact Download

- Lists are keyset-paged by `skill_id` or `version`, with a default page of 50
  and a limit of 1 to 100.
- `POST /internal/skill-versions/resolve` accepts up to 32 references in a
  16 KiB body. References must be unique by Skill and by resolved name, and the
  resolved unpacked total must not exceed 128 MiB.
- An artifact read returns the exact stored ZIP bytes. The store checks the
  bytes against their recorded identity and returns `temporarily_unavailable`
  instead of serving mismatched content.

## Dynamic Source Mappings

`PUT /internal/skill-projections` applies a source mapping event from Agent ACP
Service. The mapping key is `(organization_id, agent_id, name)`.

- A new key is inserted.
- A lower `sequence` than the stored one returns `superseded` and changes
  nothing.
- The same `sequence` with identical fields returns `replayed`. Different
  fields return `request_conflict`.
- A higher `sequence` replaces the mapping. An `active=false` event is a
  tombstone.

Mappings hold metadata only. The Registry never stores a source ZIP or Skill
body for a mapping.

## Discovery Search and Load

`POST /internal/skill-discovery/search` takes a query of 1 to 256 bytes and a
limit of 1 to 50 (default 20) in a body of at most 4 KiB.

1. One SQL query selects active mappings owned by the actor and the current
   heads of formal Skills in the organization. Both match the query as a
   case-insensitive substring of `name + " " + description`. Mappings of the
   optional `requesting_agent_id` are excluded. Results are ordered by name,
   kind, Agent ID and Skill ID under the `C` collation.
2. For mapping candidates, the Registry calls
   `POST /internal/skill-sources/inspect` on Agent ACP Service once, with a
   128 KiB response limit. Every returned item must be valid, active, owned by
   the actor, requested and not repeated. A sequence behind the mapping returns
   `source_invalid`. Candidates the source does not confirm are dropped.
3. Confirmed items are filtered by the query again, sorted and cut to the limit.

`POST /internal/skill-discovery/load` returns verified ZIP bytes for one
selected reference and an expected `content_digest`.

- A formal reference reads the stored artifact.
- A source reference requires an active mapping owned by the actor whose
  sequence is not newer than the selection. The Registry then calls
  `POST /internal/skill-sources/artifact` with an 8 MiB response limit.
- The bytes are validated as a package. A digest or name mismatch returns
  `content_changed`. An invalid package returns `source_invalid`.

The source client has a 10-second timeout, does not follow redirects and sends
`ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` as its bearer. Source 403 and 404 on
artifact reads map to `not_found`, and 409 maps to `content_changed`. Any other
failure maps to `source_unavailable`. Without source configuration, a search
with mapping candidates and every source load return `source_unavailable`.

## Promotion

`POST /internal/skill-projections/promote` turns a source Skill into a formal
version. The fingerprint covers the full request. After the receipt check, the
Registry loads and validates the source package exactly as a load does. It then
commits the version, the receipt and a `skill_version_sources` provenance row in
one publication transaction. From that point the Registry holds the package
bytes, and later source changes do not affect the version.

## Admission and Failure Semantics

Uploads and promotions share 2 concurrent slots. Downloads, searches and loads
share 4 slots. A request that finds no free slot fails immediately with `busy`.

| Error code | HTTP status | Meaning |
| --- | --- | --- |
| `invalid_request`, `invalid_package` | 400 | Malformed input or a package that breaks the rules |
| `unauthorized` | 401 | Missing or wrong service bearer |
| `not_found` | 404 | Skill, version or source does not exist for this caller |
| `name_conflict`, `request_conflict`, `revision_conflict`, `content_changed` | 409 | Conflicting state; the caller must choose again or reread |
| `limit_exceeded` | 413 | A size, count or total limit is exceeded |
| `busy` | 429 | No admission slot is free; retry later |
| `source_invalid` | 502 | The Agent source returned invalid data |
| `source_unavailable`, `temporarily_unavailable` | 503 | Database, source or configuration is unavailable; retry later |

Error bodies have the form `{"error": {"code": ..., "message": ...}}`. Storage
errors never expose driver details.

## Observability

Inbound requests produce a server span named `HTTP <method> <route>` with
`http.request.method`, `http.route` and `http.response.status_code`, and an
`error.type` attribute on failures. Outbound source calls produce client spans
with `server.address` and `antnest.target.service`. W3C trace context
propagates in both directions. SQL is not traced, and no metrics or logs are
exported over OTLP. See the
[trace boundaries contract](../../../contracts/skill-registry/trace-boundaries.md).

## Invariants

- A committed version never changes. Its bytes match its `artifact_digest`, and
  its files match its `content_digest`.
- A Skill keeps one name across all versions, and names are unique per
  organization.
- A request ID within an organization maps to exactly one fingerprint and one
  result.
- Every read is scoped to one organization. Source mappings are also scoped to
  their owner.
- A mapping sequence only increases, and an equal sequence never carries
  different metadata.
- Source bytes are validated on every load and promotion and are stored only
  when a promotion commits.
