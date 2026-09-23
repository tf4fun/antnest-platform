# Offline restore acceptance migration

Own the Restore acceptance consumer and its operational documentation. Preserve
preceding uncommitted work, service implementations and retained development.
Use current Foundation setup, private Temporal, reserved network ranges and an
immutable Runtime image. Exercise Create/Disable/Enable/Delete with exact replay.

The recovery set contains five application databases plus Temporal history and
visibility, two owned persistent volumes and three saved encryption keys. Stop
application writers normally, then Temporal, and require the complete clean-exit
inventory before export. Recreate empty storage and original roles, restore all
seven databases before any schema initializer or writer starts, and compare
frozen data/sequence/ownership/ACL fingerprints. Preserve permission-drift probes,
archive checksums, volume ownership, hidden files, modes, symlinks and Skills.

Keep the isolated in-memory Jaeger running across storage replacement so both
sides of recovery remain traceable; it is not authoritative recovery data. Stop
and recreate the deterministic model so post-restore requests start empty.
Require unchanged public Agent events, configuration, network rules and original
completed Run; exact history replay may not create a Run or call the model.
Prompt an untouched restored Session to exercise its original encrypted MCP
revision and exactly one new Tool Run, using the new execution revision.
Collect actual SDK request traces and all lifecycle topologies without waiving
strict warnings/errors. Business Delete removes owned Agent resources.

Develop negative assertions first, run checks serially, inspect owned cleanup
and retained container identity/image/mount/health. Keep other legacy consumers
and assets for their own batches. Do not commit unless requested.
