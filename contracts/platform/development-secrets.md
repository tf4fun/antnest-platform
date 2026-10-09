# Development secret admission

Revision 2 adds dependency owners; published values and gate semantics are unchanged.
Normative values are in [development-secrets.json](development-secrets.json).
This contract removes the published deployment credentials tracked in issue #13.

## Deployment

Every listed password and encryption configuration is required for deployment,
with no public fallback. Controller and Identity may supply their
[key ring](encryption-key-rotation.md) instead of the single-key variable;
Compose forwards these optional fields unchanged; each owner requires exactly
one mode and rejects missing/mixed modes or invalid members before startup.
This is an intentional change to #13's rendering guarantee: `compose config`
checks **10 of the original 12 fields** (the nine passwords and
`ANTNEST_ACP_CLIENT_MCP_KEY`). The two original fields
`ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY` and `ANTNEST_IDENTITY_ENCRYPTION_KEY`,
and their ring alternatives, use `:-` instead of `:?`: Compose 2.38 eagerly
evaluates required substitutions inside an unused alternative branch. If the
other ten fields are set, rendering can succeed with either owner's encryption
configuration missing or conflicting. Its service refuses startup, so
`docker compose up --wait` fails; no traffic is admitted by that service.
All twelve secret requirements and the ban on public defaults remain. The
example leaves these fields empty.
`scripts/generate-dev-env.sh` generates independent random values into a private
0600 `.env`, refuses an existing output unless `--force` is explicit, and prints
only the newly generated bootstrap administrator password once. Force is for a
disposable environment: it cannot rotate passwords or keys of retained data.
Workload/CCT/Runtime credentials still use the separate
[authentication provisioner](development-authentication.md).

The standard Compose files do not pass `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS` into
containers. Only an explicit disposable test/development override may do so.
The gate accepts exactly `true` to enable, absent/empty/`false` to disable, and
rejects every other value without trimming. It does not enable removed bearer
authentication, Skill learning debug mode, or private Provider endpoints.

## Startup checks

Identity, Controller, RC, Registry, ACP and Egress check the password resolved by
their PostgreSQL connection parser, including percent-encoded URL passwords and
driver-supported keyword/query forms. They reject any published value from the
shared set. Invalid connection syntax is reported by variable name without
echoing the connection string or driver error.

Platform-owned PostgreSQL and Temporal entrypoints apply the same published-value
set through `scripts/development-secret-admission.sh` before opening connections,
creating database roles or starting the server. Dependency owners are recorded in
the JSON contract. PostgreSQL checks its admin password on every start, including
retained data, then execs the official entrypoint with the supplied command and
arguments. Compose explicitly retains its default `postgres` command. Temporal's
derived image preserves the base image's entrypoint/command/user metadata and
execs a saved upstream entrypoint after checking the server password. Both wrappers
preserve signal handling. Init/schema jobs check before running their clients.

Checks use the actual consumed `POSTGRES_PASSWORD`, `PGPASSWORD`, `SQL_PASSWORD`
or `POSTGRES_PWD`, but errors and warnings name the corresponding contract
variable. Temporal database initialization also checks
`ANTNEST_TEMPORAL_POSTGRES_PASSWORD` before writing the role credential.
Unset/empty values are not published values, matching the other owners' value
policy; Compose's required substitutions and each dependency's own configuration
validation remain responsible for missing configuration. An invalid opt-in still
fails even with unset/empty or private passwords. A contract drift test keeps the
POSIX shell list synchronized; Debian dash and the pinned Temporal images' `sh`
entrypoints use no Bash-specific features.

Identity, Controller and ACP retain canonical base64/exactly-32-byte checks and
also reject keys with 32 identical bytes. With the explicit gate, a matching
published password or uniform key is accepted and produces one startup WARN for
each affected variable, without logging its value. Repeated checks do not
duplicate that warning.

Identity checks the bootstrap password **only when creating a new administrator**,
under its existing bootstrap transaction/lock. An existing administrator is
neither rejected nor reset because of an unused bootstrap password. Configuration
format, database passwords and encryption keys remain checked on every start.

The shared Registry bearer has already been removed by #31/#102. Registry,
Controller, RC and Console keep rejecting that setting even with this gate;
ACP keeps rejecting its removed Registry/source token settings as well.

## Delivery and admission

Deliver the shared policy first, then Identity, Controller, RC, Registry, ACP and
Egress as separate owning-service commits, each with regression evidence. The
final deployment batch changes Compose, generator, documentation and disposable
test configuration after all owner gates pass. It verifies empty-env Compose
rejection, private/non-overwriting generation, and an actual fresh Stage 3 stack
and generated-password login. Fixed fixtures explicitly opt in in their own
environment; generated operator deployments do not.

The dependency admission batch covers PostgreSQL, Temporal database/schema/server
entrypoints and Skill Registry database initialization, with shell unit/component
checks, Compose wiring and isolated Docker startup/restart evidence. Disposable
fixtures opt in for every dependency checker through their explicit override;
Tier A dependencies retain private `integration-*` passwords without an opt-in.

Stored-secret key rotation/versioning follows the implemented
[#42 contract](encryption-key-rotation.md). Keep original keys and database
passwords when upgrading a retained deployment; if they are public defaults,
plan the owner-specific credential rotation instead of regenerating `.env`
against existing volumes.
