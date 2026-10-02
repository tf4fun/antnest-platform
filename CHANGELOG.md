# Changelog

## Unreleased

### Fixed

Identity Service now includes the required `organization_slug` and
`organization_name` in local-login, access-token-resolution, and initial and
replayed OIDC callback principals
([#3](https://github.com/tf4fun/antnest-platform/issues/3)). It implements the
existing revision-13 contract without a migration. Organization display
changes do not invalidate password verification; authorization IDs, roles,
active state, and the password hash are still revalidated before token
issuance. Gateway and Agent UI consumption remain
[separate follow-up batches](services/identity-service/README.md#principal-response-contract).

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
