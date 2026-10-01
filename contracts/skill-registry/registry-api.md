# Skill Registry internal API v1

This document defines the Skill Registry's private control-plane HTTP API for
publishing, listing, resolving and downloading immutable Skill versions. The
[JSON payload schema](registry-api.schema.json) and the
[package-rules-v1 shared cases](../../tests/integration/skill-registry/package-rules-v1.json)
are part of this boundary. Multipart ZIP bytes and HTTP status mapping are
specified here because they are not JSON payloads.

All routes are private control-plane HTTP routes. Callers authenticate with
`Authorization: Bearer <registry service token>`; the token is configured on the
Registry and distributed only to trusted internal callers. The authenticated
caller supplies an organization ID on every operation. Registry scopes every
lookup, list, version and artifact to that ID; callers must derive it from their
own trusted principal or frozen Agent configuration, never from browser text.
The token is not a tenant identity or a grant to the Runtime. A missing or
invalid token returns 401 without revealing resource existence.

`org_<32 lowercase hex>`, `user_<32 lowercase hex>` and
`skill_<32 lowercase hex>` use the platform resource-ID contract. `request_id`
is an opaque, nonempty, at most 128-byte printable non-whitespace ASCII
idempotency key (`!` through `~`) supplied by the caller and unique within an
organization across both publish routes. Versions
are positive integers, starting at 1. JSON objects reject unknown fields.

## Package rules v1

`package_rules_version=1` is the [Registry design's](../../docs/skill-registry-minimal-design.md)
validation policy and language-neutral sample version. The whole ZIP is at most
8 MiB; each entry is at most 8 MiB; unpacked regular files total at most 32 MiB;
at most 256 entries, including directories. Names are UTF-8 relative paths of
at most 512 bytes and 16 segments. Reject absolute paths, `.`/`..`, backslash,
NUL, duplicate or file/directory-conflicting paths, encrypted entries,
nonregular entries, links, invalid CRC and reported/actual size mismatches.
ZIP extra metadata is limited to ZIP64 and extended timestamp fields; unknown
vendor/Unix link metadata and non-UTF-8 entry flags are rejected.
`SKILL.md` must be a root file of at most 16 KiB, valid UTF-8, without BOM.
Its first and closing frontmatter delimiter lines are exactly `---`, with LF or
CRLF. Frontmatter is one mapping document; reject extra documents, `...`,
duplicate keys, explicit tags, anchors, aliases and any mapping key `<<`.
Read `name` and `description` from YAML nodes, without coercion. For plain
scalars, reject the union of YAML 1.2 core, yaml-rust2 0.13 and go-yaml v3
nonstring forms, plus date, number-separator, radix-prefix and repeated-sign
rules in the design. Quoted/block strings remain strings. `name` is 1–64
lowercase ASCII bytes using letters, digits and single internal hyphens; the
first and last byte must be alphanumeric. `description`, trimmed, is 1–512
UTF-8 bytes without NUL.

`artifact_digest` is `sha256:` plus lowercase SHA-256 of the exact ZIP bytes.
`content_digest` hashes the canonical regular-file manifest (directories are
implied). Sort files by unsigned UTF-8 path bytes. Concatenate for each file:
big-endian uint32 path-byte length, path bytes, big-endian uint64 actual size,
32 raw SHA-256 bytes of file content, and one byte `0` or `1` for whether any
execute bit is set. Prefix the stream with ASCII `antnest-skill-manifest-v1\0`.
The digest uses the same lowercase `sha256:` format. Registry stores each
file's path, actual size, hex digest and normalized executable flag; file
contents are retained only in the immutable ZIP. `SKILL.md` is included.

## Routes

The two publish routes consume multipart/form-data with exactly one JSON
`metadata` part (at most 4 KiB) and one `artifact` ZIP part (at most 8 MiB),
plus bounded multipart overhead. No other parts are accepted.

| Method and route | Input | Success |
| --- | --- | --- |
| `POST /internal/skills` | metadata `{request_id, organization_id, actor_id}` | 201 `{skill_id, version, name, description, artifact_digest, content_digest, artifact_size, unpacked_size, package_rules_version}` |
| `POST /internal/skills/{skill_id}/versions` | same metadata plus `expected_version` | 201 same shape, version incremented |
| `GET /internal/skills?organization_id=...&after_id=...&limit=...` | `after_id` optional; limit default 50, max 100 | 200 `{items:[{skill_id,name,current_version,description,artifact_digest,content_digest,artifact_size,unpacked_size,package_rules_version}],next_after_id}` |
| `GET /internal/skills/{skill_id}/versions?organization_id=...&after_version=...&limit=...` | `after_version` optional; limit default 50, max 100 | 200 `{items:[publish metadata],next_after_version}` |
| `POST /internal/skill-versions/resolve` | JSON `{organization_id,refs:[{skill_id,version}]}`; up to 32 unique references | 200 `{items:[publish metadata]}` in input order |
| `GET /internal/skills/{skill_id}/versions/{version}/artifact?organization_id=...` | fixed skill and version | 200 exact ZIP bytes, `Content-Type: application/zip`, `Content-Length`, `ETag` and `X-Antnest-Artifact-Digest`; never redirect |

Resolve rejects repeated skills, repeated names and an aggregate unpacked size
over 128 MiB. The response contains no artifact bytes. A missing skill, version
or cross-organization lookup returns the same 404 result. Artifact and content
digests are stable across list, resolve and download. Committed versions have no
update or delete route; uploading a new package requires `expected_version`
equal to the current head and the same `name`. The organization owns a unique
name across all skills.

Both publish routes share organization-scoped `request_id` receipts. The
request fingerprint binds route/action, organization, actor, target skill and
expected version (if any), and exact artifact digest. The first transaction
atomically writes the version and frozen receipt. Identical replay returns the
original 201 response even if the head has since moved; different input returns
`request_conflict` 409. A wrong current head returns `revision_conflict` 409.

Errors are JSON `{error:{code,message}}`. Codes and HTTP status are:
`invalid_request`/`invalid_package` 400, `unauthorized` 401,
`not_found` 404, `name_conflict`/`request_conflict`/`revision_conflict` 409,
`limit_exceeded` 413, `busy` 429, `temporarily_unavailable` 503.
Error messages must not contain ZIP contents or raw database secrets. Registry
returns a bounded body on all paths. Client cancellation propagates to ZIP
validation and database calls.
