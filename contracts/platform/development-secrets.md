# Development secret admission

Revision 1. Normative values are in [development-secrets.json](development-secrets.json).
This contract removes the published deployment credentials tracked in issue #13.

## Deployment

Every listed password and encryption key is required by the standard Compose
configuration, with no public fallback. The example leaves these fields empty.
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

Key rotation/versioning remains the separate scope of #42. Keep original keys
and database passwords when upgrading a retained deployment; if they are public
defaults, plan the owner-specific credential migration instead of regenerating
`.env` against existing volumes.
