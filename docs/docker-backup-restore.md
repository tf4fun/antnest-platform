# Docker Offline Backup And Restore

This document describes the offline backup and restore procedure for the
single-node Docker deployment.

Scope: the single-node Docker deployment, the same service versions and the
same deployment identity. This is a planned maintenance procedure, not online
cross-service snapshots, host migration, or high availability. Never copy live
PostgreSQL data files. PostgreSQL's [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
is database-scoped; consistency across services and workspace files requires
stopping every writer for the whole backup window.

## Recovery Set

Keep one protected recovery set, with a timestamp and checksums:

| Owner              | Database                                          | Additional state                                                                                                                                                               |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity           | `antnest_identity`                                | `ANTNEST_IDENTITY_ENCRYPTION_KEY`, IdP configuration, database role/DSN                                                                                                        |
| Agent Controller   | `antnest_agent_controller`                        | `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`, provider credentials/configuration, deployment identity                                                                             |
| ACP                | `antnest_agent_acp`                               | `ANTNEST_ACP_CLIENT_MCP_KEY`, durable Sessions/history/context, Skill maintenance signing keys                                                                                 |
| Runtime Controller | `antnest_runtime_controller`                      | Controller scope, network/volume names, immutable Runtime image digests, Skill maintenance verifier configuration                                                              |
| Egress             | `antnest_egress`                                  | Tunnel CIDR/resolver and deployment network configuration                                                                                                                      |
| Skill Registry     | `antnest_skill_registry`                          | Receiver hash file, per-pair Identity/ACP sender files or TLS material, and pinned Identity/source configuration                                                               |
| Temporal           | `antnest_temporal`, `antnest_temporal_visibility` | Temporal role/DSN, namespace and matching server/schema versions; restore alongside Controller data                                                                            |
| Runtime filesystem | none                                              | Every retained `antnest-workspace-<agent-id>` volume, every referenced per-Agent Skill volume and the configured system Skills volume, including ownership, modes and symlinks |

The three encryption keys are independent of database login passwords. Preserve
the keys and working connection configuration, plus the exact Compose files and
deployment environment, outside Git in an access-controlled secret backup. A
database dump without its required key is not a complete recovery set. Dump
contents and workspace files are sensitive too. Use a private backup directory
(0700) and restrict archive/key files to 0600; encrypt and restrict off-host
storage according to operator policy. Do not print environment values or put
credentials in terminal transcripts.

The shared development PostgreSQL server uses private service roles created by
`scripts/postgres-init.sh`, `scripts/temporal/init-databases.sh` and
`scripts/skill-registry/init-database.sh`. Recreate those exact roles and
database owners before restoring; database passwords may change if their DSNs
are updated consistently. Application encryption keys must still match the
existing ciphertext. Do not restore everything as one shared application owner.
Nonstandard roles, grants or tablespaces also need their own reviewed
global-object backup; the development setup does not use custom globals.

Gateway, Console and Agent UI have no service-owned database. Jaeger memory is
diagnostic, not the authoritative Agent audit store; preserving an external
telemetry backend is that backend's separate operational responsibility.
Container IDs, sockets, PID values, `/tmp` and in-memory Tool processes are not
restored. Required images must remain available by the saved immutable digest.

### Skill Registry and per-Agent Skill state

The recovery set must also include:

- the Registry database, including immutable package bytes and publication
  receipts, exported within the same quiesced maintenance window;
- Runtime Controller preparation checkpoints, logical set identities, physical
  materializations and retained references as part of its database backup;
- every per-Agent system-Skill volume referenced by a running or disabled Agent
  or by an unfinished lifecycle operation, including empty-set manifests,
  numeric ownership, modes, labels and full content checksums;
- candidate volumes if preparation is to resume from its saved progress. Any
  deliberately omitted candidate must be listed, and restored progress must be
  invalidated before preparation resumes.

Retained ready volumes are backed up so a disabled Agent can be enabled while
Registry is offline. The restore tooling derives the required volume manifest
from Runtime Controller current and lifecycle references and set
materializations.

## Quiesce And Back Up

1. Schedule downtime and prevent new operator/client mutations. Through the
   normal lifecycle API, disable every non-deleted Agent and wait for completed
   operations. Do not delete Agents or their retained workspaces. Resolve unknown
   outcomes before proceeding; a timeout is not proof that a writer has stopped.
2. Confirm no owned Runtime containers remain and retained workspaces still
   belong to the expected Agent and Controller scope. Record the Agents that were
   enabled so the operator can explicitly re-enable them later.
3. Close external access and stop Gateway, Console, Agent UI, ACP, Skill
   Registry, Agent Controller, Runtime Controller, Egress and Identity, then stop
   Temporal after its Controller client has stopped. Stopping Runtime Controller
   and Skill Registry also stops Registry uploads and all preparation, retry and
   cleanup workers. Verify every writer's stopped container and clean service
   exit. Keep the telemetry collector available until writer exporters have
   flushed; stop it afterward. Leave only PostgreSQL running for logical export.
   No privileged maintenance client may mutate the databases during this window.
4. For each database above, execute `pg_dump --format=custom --file=<private-file>
--username=<backup-role> --dbname=<database>`. Do not omit ownership or ACLs.
   Inspect errors/warnings and verify every archive before declaring success.
5. With no mounted writer, archive each whole persistent volume using a temporary
   trusted container. Preserve numeric UID/GID, file modes, symlink targets and
   all hidden home directories. The Runtime home includes personal Skills and
   caches; copying only visible workspace documents is insufficient. Record the
   exact volume name, driver and ownership labels, not host mountpoint paths.
6. Save protected keys/deployment configuration, image digests and checksums.
   Keep the services quiescent until all parts are complete. Store recovery sets
   together; never mix databases and files from different maintenance windows.

## Restore And Reopen

1. Verify the complete recovery set, checksums and encryption keys **before**
   changing the destination. Use only trusted SQL/tar archives. Keep application
   services stopped, public ingress closed and all old Runtime writers absent.
2. Restore into empty databases owned by their original roles. With the same
   initialized database names and owners, including both Temporal databases, use
   `pg_restore --exit-on-error --single-transaction --username=<backup-role>
--dbname=<database> <archive>` for each database. Do not suppress errors or
   treat a partially restored set as usable. Run only role/database creation
   before restore; defer Temporal schema initialization and all writers until
   every restored database has been verified. See the
   [PostgreSQL restore reference](https://www.postgresql.org/docs/17/app-pgrestore.html).
3. Recreate the exact persistent volume identities and ownership labels. Extract
   the archives, preserving numeric UID/GID and permissions; compare against the
   archives before allowing a Runtime to mount them. Follow Docker's
   [volume backup/restore pattern](https://docs.docker.com/engine/storage/volumes/).
4. Start the same service images with the saved keys, private database roles,
   Controller scope and network configuration. Initially keep Agents disabled.
   Never rewrite service-owned tables to manufacture ready state.
5. Verify local authentication, organization/ownership, model/Template revisions,
   Agent lifecycle history, Session replay and saved network rules. Re-enable the
   recorded Agents through normal lifecycle commands. Verify new Runtime identity,
   restored files and an actual Tool-backed ACP prompt. Session replay must not
   execute an old Tool again. Only then reopen public ingress.

If recovery fails, stop and diagnose while ingress stays closed. Do not discard
the original recovery set, generate replacement encryption keys, automatically
replay uncertain work, or edit migration journals. An active-runtime/host-loss
recovery procedure is a different scenario from this deliberately quiesced set.

### Restoring Skill volumes

On restore, validate actual volume existence, ownership, complete file hashes,
permissions and set manifests before honoring any persisted `ready` record. A
database marker or matching volume name alone is insufficient evidence.

Before starting each restored or recreated container, Runtime Controller also
checks its actual Skill mount, volume labels and stored set manifest. Docker can
recreate a missing named volume during container creation, so a pre-create
check cannot prove the mounted volume is the restored one. Replayed and adopted
targets use the same gate. Do not start a mismatched target or delete a foreign
volume based only on its name or missing labels; uncertain effects follow the
existing recovery contract.

If a ready record has no intact volume and no live compute references it,
invalidate that materialization and prepare an exact replacement from the backup
or pinned Registry version under a new private materialization identity. If
Registry is unavailable too, retain a pending/unavailable state; never mount an
empty set or silently choose the latest version. If restoration or a lifecycle
check finds a mismatched active mount or set manifest, keep admission closed
and recover through Controller; never write to a live read-only volume. Skill
files in an already running Runtime are not continuously hashed to detect
privileged host-side edits.

### Skill learning key recovery

The [Skill learning design](skill-learning-design.md) relies on maintenance
signing keys held by ACP and verifier key sets held by Runtime Controller.
Runtime Controller persists each accepted operation's complete public-key set in
its PostgreSQL database alongside its deployment identity. Back up the Runtime
Controller bootstrap environment configuration separately and compare it with
the active Runtime and unfinished operation snapshots before resuming
maintenance. ACP signing keys stay in its protected secret backup, outside
RuntimeSpec, logs and Git.

Restore must reconcile these records with current revocation and incident
records before opening maintenance. New global Runtime Controller key
configuration cannot rewrite an unfinished operation's snapshot, and a
compromised key in an old backup cannot be made trusted again by replay. Keep
affected execution isolated, settle old effects through the lifecycle recovery
process, and explicitly rebuild with a safe key set.

The manual incident drill `make e2e-skill-learning-key-compromise` exercises one
operator-controlled quarantine and recovery path. It clears ACP signing, shows
that the original Runtime still trusts the leaked key, disables the Agent and
verifies that the Runtime endpoint stops. It restores a protected Runtime
Controller dump to a separate database outside lifecycle replay, compares
accepted verifier sets and deployment identities, and identifies the stale key.
A new Enable against the safe configuration installs a Runtime that rejects the
old key and preserves learned Skill use. The drill does not implement automated
revocation or arbitrary full-platform restore; unfinished revoked targets still
require isolation and factual settlement before resuming.

## Restore Test Profile

The bounded `restore` lifecycle profile implements this procedure only for its
own disposable test project. It uses all the actual service databases and
synthetic credentials, never real secrets. It:

- Creates Agents and a completed Tool-backed ACP Session through Gateway.
- Disables the Agents and stops writers before snapshots.
- Stops Temporal after application writers, then exports every database and
  volume archive plus protected encryption keys.
- Actually removes the temporary PostgreSQL, workspace and Skill volumes and
  restores into new empty storage rather than verifying against surviving
  original data.
- Requires an independent complete database and volume manifest before any
  destructive step; a missing workspace must not survive and produce false
  success.
- Compares database row/sequence and schema/object ownership/ACL fingerprints
  plus filesystem archives before any service can mutate restored data.
  Transactional permission-only mutations must change the fingerprint and roll
  back cleanly.
- Compares all three container-injected encryption keys with pre-backup
  digests, including Identity. A direct Prompt on an untouched old ACP Session
  exercises its original encrypted MCP revision; loading alone is insufficient.
- Logs in again, replays history without a model request, enables the Agents and
  runs a real Tool against restored files, proving that decrypted model
  configuration works.
- Enables restored Agents with Registry stopped, checks that new ACP Runs read
  the pinned Skill, and verifies that removing one retained Skill volume leaves
  that Agent pending without an empty replacement while its peer remains usable.
- Preserves public Agent events and the original completed Run. History replay
  must not create or change an execution audit. A new Run must use the restored
  Agent's newly admitted execution revision.
- Keeps an isolated in-memory Jaeger available across storage replacement and
  collects lifecycle and SDK request traces before and after restore. Trace
  topology or platform errors fail the test. Jaeger is diagnostic and outside the
  recovery set.
- Deletes only its own labelled resources and temporary backup files on success,
  failure or interruption. Conflicting ownership labels block deletion even in
  final cleanup.

```sh
make e2e-lifecycle-restore
```

Do not commit dumps, secret bundles or step-by-step execution logs.
