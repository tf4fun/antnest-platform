# Changelog

## Unreleased

### Fixed

Runtime release images now use a feature-free default Docker target, while the
test-only Skill commit gate requires an explicit `--target e2e` build
([#12](https://github.com/tf4fun/antnest-platform/issues/12)). Supplying
`ANTNEST_RUNTIME_FEATURES` to the default target cannot enable test features.
Test binaries reject `serve` unless `ANTNEST_RUNTIME_ALLOW_TEST_FEATURES` is
exactly `true`, then emit one startup warning listing the compiled features.
E2E images carry the `dev.antnest.runtime.test-features` label and set that
explicit opt-in; release images have an empty label and no opt-in.

ACP's development-only Skill learning debug Agent now requires the explicit
`ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true` gate
([#11](https://github.com/tf4fun/antnest-platform/issues/11)). The gate defaults to
`false` and accepts only exact `true` or `false` values. Existing deployments
that supply a debug Agent without the gate now fail configuration at startup.
The debug Agent ID retains its existing normalization: surrounding whitespace is
trimmed, and empty or whitespace-only values mean unset. The gate performs no
trimming or case conversion; padded or differently capitalized booleans fail
configuration.
Enabled debug learning emits one startup warning identifying the Agent. Standard
Compose no longer passes either setting from the operator's environment; both
are confined to the Skill learning E2E override. Normal learning policy, budgets
and foreground priority remain unchanged.

Edge Gateway now supplies security headers only when absent from the final
response ([#1](https://github.com/tf4fun/antnest-platform/issues/1)). Proxied
Agent UI documents retain their exact nonce-bearing CSP, allowing streaming
scripts and `blob:` image/media previews without an additional conflicting
Gateway policy. Gateway-generated responses and upstream assets without a
policy retain the existing defaults. SSE flushing and ACP WebSocket upgrades
remain supported; this change needs no API revision or coordinated rollout.
Agent UI also initializes browser schema validation in Zod's `jitless` mode
before constructing schemas, preventing its caught eval probe from emitting a
CSP violation during hydration or reload. The document CSP remains unchanged.

ACP Workspace Bridge's shared schema now requires the `errorClass` already
emitted on intent receipts and nested execution observations
([#4](https://github.com/tf4fun/antnest-platform/issues/4)). ACP normalizes invalid
stored classifications to `internal_error` at the read boundary, with a bounded
server diagnostic, and emits `null` for non-failure phases. Agent UI preserves
the required value and validates both response paths with the same rules.
Unknown valid codes retain the generic failed-turn presentation.
Run setup errors also validate raw codes before persistence, storing
`run_setup_failed` for malformed codes such as `ECONNREFUSED` or `40001`.
This avoids repeated normalization warnings when observing new setup failures.

Edge Gateway now preserves Identity's Organization slug/name in local-login,
token-resolution and OIDC principals and browser session responses
([#92](https://github.com/tf4fun/antnest-platform/issues/92)). Agent UI's Node
bootstrap, SSR and frontend mappings consume the verified metadata, so the
chooser and account footer display the real Organization name instead of
`Organization workspace`
([#93](https://github.com/tf4fun/antnest-platform/issues/93)). IDs, roles and
active state remain the authorization inputs.

Identity Service now includes the required `organization_slug` and
`organization_name` in local-login, access-token-resolution, and initial and
replayed OIDC callback principals
([#3](https://github.com/tf4fun/antnest-platform/issues/3)). It implements the
existing revision-13 contract without a migration. Organization display
changes do not invalidate password verification; authorization IDs, roles,
active state, and the password hash are still revalidated before token
issuance. Gateway and Agent UI now consume these fields through the
[verified projection](contracts/agent-ui/organization-projection.md), with the
complete display workflow verified in the separate
[#93 integration batch](https://github.com/tf4fun/antnest-platform/issues/93).

Runtime Controller now retries transient observation leadership/readiness
queries and initial reconciliation failures instead of exiting
([#17](https://github.com/tf4fun/antnest-platform/issues/17)). Observation retries
use capped exponential backoff with jitter; operators can set
`ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY` (default `30s`, minimum
`1s`). Failed initial attempts release leadership and keep Watch readiness
withdrawn until recovery. Standard Compose also uses `restart: unless-stopped`
for the Controller. See the
[recovery and readiness semantics](services/runtime-controller/docs/operations.md#observation-dependency-recovery).

### Changed

Defined the platform service-authentication foundation for
[#32](https://github.com/tf4fun/antnest-platform/issues/32): workload identity,
Identity-issued caller-context schemas and public verification vectors,
per-service route caller catalogs, and repository checks that detect missing
caller policies or unreviewed custom matchers. Added a shared negative JSON
media-type probe for later service-owned tests. This is a contract-only batch:
authentication middleware, network/port changes and Docker security acceptance
remain pending in the rollout ledger; internal listeners are not yet secured.
Go route checks include wrapper calls across files in the same package and
reject unresolved arguments alongside known calls. Runtime Controller's Skill
preparation routes allow Agent Controller only, matching the actual HTTP client.

Runtime `/status` now requires `test_features: string[]`, including unavailable
responses; release binaries report `[]`. Upgrade Runtime Controller's status
reader before deploying the new Runtime images, because older strict readers
reject the added field. The updated reader accepts both shapes during rollout
and retains existing identity/readiness checks. Image admission policy remains
separate work in [#29](https://github.com/tf4fun/antnest-platform/issues/29).
Local E2E builds that previously supplied only `ANTNEST_RUNTIME_FEATURES` must
now select `--target e2e`; the feature argument must be nonempty.

Bridge receipt error classes must be `null` or a 1–128 character ASCII code
matching `^[a-z][a-z0-9_]*$`; only `failed`, `cancelled` and `unknown` phases may
carry non-null codes. The vocabulary remains open and `intentReceipt: 1` stays
unchanged. Deploy the ACP producer normalization before the stricter Agent UI
consumer when upgrading separately, so malformed stored codes do not cause
observation parsing failures. See the
[receipt failure contract](contracts/agent-acp/workspace-bridge.md#receipt-failure-classification).

Gateway's browser session contract advances to revision 14. Authenticated
Workspace API and SSR requests now carry `X-Antnest-Organization-Slug` and
`X-Antnest-Organization-Name`, each containing one canonical unpadded Base64URL
value over the exact UTF-8 label. Gateway strips browser-supplied values; Agent
UI requires the verified projection before discovery or rendering. See the
[Organization projection contract](contracts/agent-ui/organization-projection.md).

Runtime Controller control contract revision 14 adds the required boolean
`monitor_ready` to both `/status` response shapes
([#88](https://github.com/tf4fun/antnest-platform/issues/88)). After startup,
monitor retries and Watch reconnection now return HTTP 503 with `live: true`
and `monitor_ready: false`, returning to HTTP 200 after recovery. The process
keeps running, and `/status` reads cached state without probing Docker. The
Controller's own status-code-only healthcheck needs no parser change. Existing
probe failure thresholds absorb short reconnect windows.

ACP now reads `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID` exactly as supplied,
without trimming whitespace, as part of the unified Skill maintenance key ID
validation ([#5](https://github.com/tf4fun/antnest-platform/issues/5)). This affects
existing deployments in two cases:

- A value with leading or trailing whitespace, such as `" key"` or `"key "`,
  was previously trimmed and accepted when paired with a valid signing key.
  It now causes ACP startup to fail.
- A whitespace-only value previously counted as unconfigured when no signing
  private key was configured. It now causes ACP startup to fail.

Before upgrading or restarting, remove whitespace from the signing key ID in
environment variables and deployment secrets. The ID must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and exactly match a trusted Runtime verifier ID.
To leave signing unconfigured, keep both `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`
and `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY` unset or exactly empty; do not use
spaces as an empty value. These configuration errors are rejected at startup,
before ACP begins serving requests.

See the [Skill deployment guide](docs/skill-deployment.md) for configuration and
key rotation instructions.

### Organization display deployment order

Complete each component's rollout before starting the next:

1. **Identity Service**: deploy a build containing
   [#91](https://github.com/tf4fun/antnest-platform/pull/91), which supplies the
   required Organization slug/name in revision-13 principals.
2. **Edge Gateway**: deploy a build containing
   [#94](https://github.com/tf4fun/antnest-platform/pull/94), which implements
   the revision-14 session contract and verified display headers.
3. **Agent UI**: deploy a build containing
   [#95](https://github.com/tf4fun/antnest-platform/pull/95), which requires
   those headers for Workspace bootstrap and SSR.

Deploying the new Gateway against Identity without #91 makes login unavailable:
otherwise valid local logins and session resolution return
`503 identity_unavailable`, and OIDC callbacks redirect to the login failure page
without establishing a browser session. Deploying the new Agent UI against
Gateway without #94 leaves Workspace bootstrap and SSR returning
`401 unauthenticated`. Re-authentication cannot repair missing server-side
projection headers; complete the upstream rollout first.
