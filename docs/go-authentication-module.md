# Shared Go authentication module

Status: integration-admitted for PR #102 on 2026-10-05. All six Go service
batches, ACP/Agent UI regression batches, repository gates and final Docker
authentication/business and production deployment regression passed.

## Scope and ownership

`modules/service-authentication` is one Go module with `serviceauth` and
`callercontext` packages. It implements the existing
[authentication contract](../contracts/platform/service-authentication.md),
not another wire protocol or service.

- `serviceauth`: bounded credential/configuration reads, strict JSON, token and
  mTLS verification, configured-origin outbound clients and credential rotation.
- `callercontext`: strict JWKS/CCT parsing, signature/claim verification, bounded
  JWKS refresh and forwarding of a verified token.

Outbound construction takes the calling service explicitly. Clients disable
proxies and redirects, pin the dependency identity and replace workload
credentials per request. The ordinary profile removes legacy identity hints,
cookies and Authorization while preserving the verified CCT. The workload-only
profile also removes CCT. Only Gateway may select the explicit forwarding
profile: its own request adapters strip browser authority before regenerating
presentation hints and preserving SCIM's protocol bearer. HTTP and Gateway
WebSocket handshakes use the same credential and transport policy.

Each service keeps its caller catalog, route enforcement, organization/Agent
checks and public error envelope. Identity keeps CCT signing keys, issuance and
session/revocation checks; it projects library failures into its domain errors.
No library reads a database, starts a listener or grants a domain action.

## Delivery batches

1. Freeze this boundary and direct-transport/header requirements.
2. Fix Gateway and Console transport regressions in separate service commits.
3. Fix ACP and Agent UI missing-CCT outcomes in separate service commits:
   zero fields means `401 caller_context_required`; duplicates, empty or invalid
   values mean `401 caller_context_invalid`.
4. Extract and admit the shared implementation and its unit/vector tests.
5. Adopt it in Identity, Gateway, Console, Controller, RC and Registry, one
   owning-service commit at a time, with README, standalone module build,
   container inputs and local tests. Remove copied implementations and keep
   service-specific authorization tests.
6. Admit the explicit integration batch and update repository/CI coverage.

## Build and verification

Services require the shared module at a repository-local version and use a
relative `replace` directive. `go.work` supports development but must not be
needed by `GOWORK=off go vet/test/build`. Each Dockerfile copies the library and
its module metadata before building its own service in the repository layout.

Common tests run inside the shared module, including the existing platform
token/CCT rejection vectors, TLS identity, rotation, redirects, direct transport
and header isolation. Regression tests first reproduce the reported behavior.
Service unit tests stay within their owner; integration sources stay under root
`tests/integration/`. Only the shared protocol tests move beside the module.

Repository checks must reject restored private copies of `serviceauth` or CCT
verification, missing standalone dependency declarations and missing shared
Docker/CI inputs. A module change must run all six Go consumer workflows. Final
Docker authentication/business regression runs only after each owning batch
passes. This extraction adds no full-platform mTLS acceptance claim.

## Admission commands

`make test-go-authentication` runs the shared Go protocol suite independently
of the workspace. `make test-service-authentication` enforces route ownership
and the shared module's build/ownership guard. `make test-repo` includes its
13 positive/negative repository checks. The guard checks every service's Go
sources for restored private authentication packages, preserves Identity's
owned authority, and checks the six current consumers' direct dependencies,
relative replaces, Docker layouts, outbound policy and CI coverage.

Each consumer passed `GOWORK=off go vet/test/build`, its root Go component
suite and lint before its own commit. Common TLS/mTLS tests cover all five
outbound callers; real HTTP and socket tests check unchanged verified CCT,
credential replacement and each forwarding policy. ACP and Agent UI have
catalog and real HTTP tests distinguishing absent, duplicate, empty and invalid
CCT before business effects.

A shared-module change runs `.github/workflows/shared-go-authentication.yml`
and all six consumer workflows. The service CI cache key includes the shared
`go.sum`; root formatting, lint and Go test entry points include the module.
Final Docker commands are `make e2e-service-authentication-integration` and
`make e2e-deployment-wiring`, run serially after the service batches.

The final Docker authentication/business run passed 560 checks on 24 networks
and 30 actual issuer/context/permission/Runtime checks. Login, automatic Skill
learning and notice delivery, discovery, temporary use, publication, frozen
Templates, two-Agent rebuild and learning/business Trace topology passed.
The production deployment run passed all 51 checks, including actual Jaeger
ingestion and normal shutdown. Both runs cleaned their candidate images,
credentials and owned resources and preserved retained Docker identities.
The full deployment profile remains disposable token/HTTP; common TLS/mTLS
tests are independent module evidence.
