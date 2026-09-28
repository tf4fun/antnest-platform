# Skill Registry

Skill Registry owns immutable system Skill packages and versions. It validates
ZIPs, stores metadata and exact artifact bytes in its own PostgreSQL database,
and serves fixed-version resolution and downloads to trusted control-plane
callers. The [B0 API contract](../../contracts/skill-registry/registry-api.md)
defines limits, canonical digests, routes and errors. The
[Stage 4 design](../../docs/skill-registry-minimal-design.md) records separate
Controller, Runtime Controller, ACP and Console delivery batches.

Run from this module with `go run ./cmd/skill-registry`. Required settings:

- `ANTNEST_SKILL_REGISTRY_DATABASE_URL`: URL of this service's dedicated
  PostgreSQL database and restricted account.
- `ANTNEST_SKILL_REGISTRY_API_TOKEN`: secret of at least 32 bytes, held only by
  trusted internal callers. Do not place it in a URL, image or repository.
- `ANTNEST_SKILL_REGISTRY_LISTEN`: optional, defaults to `:8080`.

Startup pings PostgreSQL and applies the embedded, checksum-checked schema
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
