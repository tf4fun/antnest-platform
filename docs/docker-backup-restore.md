# Docker Offline Backup And Restore

Scope: the current single-node Docker deployment, the same service versions and
deployment identity. This is a planned maintenance procedure, not online
cross-service snapshots, host migration, or high availability. Never copy live
PostgreSQL data files. PostgreSQL's [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
is database-scoped; consistency across services and workspace files requires
stopping every writer for the whole backup window.

## Recovery Set

Keep one protected recovery set, with a timestamp and checksums:

| Owner | Database | Additional state |
| --- | --- | --- |
| Identity | `antnest_identity` | `ANTNEST_IDENTITY_ENCRYPTION_KEY`, IdP configuration, database role/DSN |
| Agent Controller | `antnest_agent_controller` | `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`, provider credentials/configuration, deployment identity |
| ACP | `antnest_agent_acp` | `ANTNEST_ACP_CLIENT_MCP_KEY`, durable Sessions/history/context |
| Runtime Controller | `antnest_runtime_controller` | Controller scope, network/volume names, immutable Runtime image digests |
| Egress | `antnest_egress` | Tunnel CIDR/resolver and deployment network configuration |
| Temporal | `antnest_temporal`, `antnest_temporal_visibility` | Temporal role/DSN, namespace and matching server/schema versions; restore alongside Controller data |
| Runtime filesystem | none | Every retained `antnest-workspace-<agent-id>` volume and the configured system Skills volume, including ownership, modes and symlinks |

The three encryption keys are independent of database login passwords. Preserve
the keys and working connection configuration, plus the exact Compose files and
deployment environment, outside Git in an
access-controlled secret backup. A database dump without its required key is not
a complete recovery set. Dump contents and workspace files are sensitive too.
Use a private backup directory (0700) and restrict archive/key files to 0600;
encrypt and restrict off-host storage according to operator policy. Do not print
environment values or put credentials in terminal transcripts.

The shared development PostgreSQL server uses private service roles created by
`scripts/postgres-init.sh` and `scripts/temporal/init-databases.sh`. Recreate those exact roles and database owners before
restoring; database passwords may change if their DSNs are updated consistently.
Application encryption keys must still match the existing ciphertext. Do not restore everything as one shared application
owner. Nonstandard roles, grants or tablespaces also need their own reviewed
global-object backup; the development fixture does not exercise custom globals.

Gateway, Console and Agent UI have no service-owned database. Current Jaeger
memory is diagnostic, not the authoritative Agent audit store; preserving an
external telemetry backend is that backend's separate operational responsibility.
Container IDs, sockets, PID values, `/tmp` and in-memory Tool processes are not
restored. Required images must remain available by the saved immutable digest.

## Quiesce And Back Up

1. Schedule downtime and prevent new operator/client mutations. Through the
   normal lifecycle API, disable every non-deleted Agent and wait for completed
   operations. Do not delete Agents or their retained workspaces. Resolve unknown
   outcomes before proceeding; a timeout is not proof that a writer has stopped.
2. Confirm no owned Runtime containers remain and retained workspaces still
   belong to the expected Agent and Controller scope. Record the Agents that were
   enabled so the operator can explicitly re-enable them later.
3. Close external access and stop Gateway, Console, Agent UI, ACP, Agent
   Controller, Runtime Controller, Egress and Identity, then stop Temporal after
   its Controller client has stopped. Verify every writer's stopped container
   and clean service exit. Keep the telemetry collector available until writer
   exporters have flushed; stop it afterward. Leave only PostgreSQL running for
   logical export.
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
   all seven restored databases have been verified. See the
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

## Reusable Acceptance

The bounded `restore` lifecycle profile implements this procedure only for its
own disposable test project. It uses all seven actual databases and
synthetic credentials, never `.secret`. It must:

- Create an Agent and completed Tool-backed ACP Session through Gateway.
- Disable the Agent and stop writers before snapshots.
- Stop Temporal after application writers, then export all seven databases and
  volume archives plus protected encryption keys.
- Actually remove the temporary PostgreSQL, workspace and system Skills volumes;
  restore into new empty storage, not verify against surviving original data.
- Require an independent complete seven-database/two-volume manifest before any
  destructive step; a missing workspace must not survive and produce false success.
- Compare database row/sequence and schema/object ownership/ACL fingerprints plus
  filesystem archives before any service can mutate restored data. Transactional
  permission-only mutations must change the fingerprint and roll back cleanly.
- Compare all three actual container-injected encryption keys with pre-backup
  digests, including Identity. Direct Prompt on an untouched old ACP Session
  exercises its original encrypted MCP revision; load alone is insufficient.
- Log in again, replay history without a model request, enable the Agent and run
  a real Tool against restored files, proving decrypted model configuration works.
- Preserve public Agent events and the original completed Run. History replay
  must not create or change an execution audit. The new Run must use the restored
  Agent's newly admitted execution revision.
- Keep isolated in-memory Jaeger available across storage replacement and
  collect both pre/post-restore lifecycle and SDK request traces. Trace topology
  or platform errors fail acceptance. Preserve `strict_trace: failed` for the
  reviewed clock-only warnings but allow that narrow timing exception. Jaeger
  is diagnostic, outside the recovery set.
- Delete only its own labelled resources and temporary backup files on success,
  failure or interruption. Conflicting ownership labels block deletion even in
  finally cleanup. Preserve retained human-acceptance stacks.

```sh
make e2e-lifecycle-restore
```

Current migration results belong in [Restore revalidation](lifecycle-restore-revalidation.md);
[C5-02](docker-single-node-closeout.md) retains historical evidence. Do not commit
dumps, secret bundles or step-by-step execution logs.

## Stage 4 Skill Registry Addendum

Current development acceptance covers freshly created Registry packages and
per-Agent Skill volumes. Shared-volume migration and protected legacy export
commands are absent from this release. Their historical implementation is
recoverable from Git commit `5e86f46`, not the current service image or RPC
contract. See the [release cleanup](legacy-skill-release-cleanup-20261001.md).

The procedure and seven-database acceptance above describe the earlier Stage 3
profile. The Stage 4 recovery tooling defines an eight-database manifest and
derives physical Skill volumes from RC current/lifecycle references and set
materializations. Its current storage fixture covers two workspaces and three
per-Agent Skill volumes (ready, empty and candidate); the real-Agent fixture
covers two workspaces and their independent frozen Skill volumes. Neither
fixture requires legacy backup storage or a protected-export receipt.

The real-Agent flow enables both restored Agents with Registry stopped, checks
new ACP Runs reading the pinned Skill, and verifies that removing one retained
Skill volume leaves that Agent pending without an empty replacement while its
peer remains usable. Dated pre-cleanup results in the
[2026-09-28 acceptance audit](skill-registry-acceptance-audit-20260928.md) describe
the earlier fixture. Current rerun results belong to the release cleanup report.

The new recovery set must additionally include:

- the Registry database, including immutable package bytes and publication
  receipts, exported within the same quiesced maintenance window;
- RC preparation checkpoints, logical set identities, physical materializations
  and retained references as part of its database backup;
- every per-Agent system-Skill volume referenced by a running/disabled Agent or
  an unfinished lifecycle operation, including empty-set manifests, numeric
  ownership, modes, labels and full content checksums;
- candidate volumes if preparation is to resume from its saved progress. Any
  deliberately omitted candidate must be listed, and restored progress must be
  invalidated before preparation resumes.

Retained ready volumes are backed up so a disabled Agent can be enabled while
Registry is offline. The restore tooling derives the required volume manifest
from ownership and retained references; the storage fixture covers multiple
Agents, multiple retained sets and an empty set. The real-Agent scenario verifies
independent personal workspaces and offline reuse of two retained sets.

Quiescence must stop Registry uploads and all RC preparation/retry/cleanup
workers, in addition to the writers listed above. On restore, validate actual
volume existence, ownership, complete file hashes, permissions and set manifests
before honoring any persisted `ready` record. A database marker or matching
volume name alone is insufficient evidence.
Before starting each restored/recreated container, B3 must also check its actual
Skill mount, RC volume labels and stored set manifest. Docker can recreate a
missing named volume during container creation; a pre-create check cannot prove
the mounted volume is the restored one. Replayed/adopted targets use the same gate.
Do not start a mismatched target or delete a foreign volume based only on its name
or missing labels; uncertain effects follow the existing recovery contract.

If a ready record has no intact volume and no live compute references it,
invalidate that materialization and prepare an exact replacement from the backup
or pinned Registry version under a new private materialization identity. If
Registry is unavailable too, retain a pending/unavailable state; never mount an
empty set or silently choose the latest version. If restoration or a lifecycle
check finds a mismatched active mount or set manifest, keep admission closed
and recover through Controller; never write to a live read-only volume. The
first release does not continuously hash Skill files in an already running
Runtime to detect privileged host-side edits.

## Skill Learning Key Recovery Addendum

The separate [learning design](skill-learning-design.md) requires L1R/L3/LI1 to
cover bootstrap key recovery. L1R now persists each accepted operation's complete
public-key set in the RC PostgreSQL backup alongside its deployment identity.
Back up the RC bootstrap environment configuration separately and compare it with
the active Runtime and unfinished operation snapshots before resuming maintenance.
ACP signing
keys stay in its protected secret backup, outside RuntimeSpec, logs and Git.
Restore must reconcile these records with current revocation/incident records
before opening maintenance. New global RC key configuration cannot rewrite an
unfinished operation's snapshot; a compromised key in an old backup cannot be
made trusted again by replay. Keep affected execution isolated, settle old
effects through the lifecycle recovery process, and explicitly rebuild with a
safe key set. The frozen-snapshot database behavior has passed an isolated
PostgreSQL test. Cross-service normal rotation also has Docker evidence. The
L3/LI1 manual incident drill now passes `make e2e-skill-learning-key-compromise`:
it clears ACP signing, proves the original Runtime still trusts the leaked key,
disables the Agent and verifies that Runtime's actual endpoint stops. It restores
a protected RC dump to a separate database held outside lifecycle replay,
compares accepted verifier sets/deployment identities, and identifies the stale
key. A new Enable against the safe configuration installs a Runtime that rejects
the old key and preserves learned Skill use. Evidence:
`artifacts/verification/skill-learning/antnest-lifecycle-706dabfe.json`, with an
archive checksum, 0700 directory and 0600 file. No test containers remain.
This drill has no unfinished lifecycle operation in its backup. It verifies
one operator-controlled quarantine/recovery path, not automated revocation or
arbitrary full-platform restore; unfinished revoked targets still require the
documented isolation and factual settlement before resuming.
