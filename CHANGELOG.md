# Changelog

## Unreleased

### Fixed

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
