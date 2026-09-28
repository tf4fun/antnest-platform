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
per-Agent Skill volumes. There is no legacy business data to migrate. The
legacy export commands retained below document existing historical tooling;
they are not a deployment prerequisite or an outstanding acceptance gate.

The procedure and seven-database acceptance above describe the previously deployed
services. Registry service code and development Compose provisioning now exist.
Recovery tooling now defines an eight-database manifest and derives physical
Skill volume names from RC current/lifecycle references and set
materializations, while preserving the seven-database Stage 3 profile. The
isolated `make e2e-stage4-skill-storage-restore` fixture has deleted and
restored all eight databases plus two workspace volumes, the nonempty legacy
shared volume, the RC private legacy-backup volume and three per-Agent Skill
volumes (ready, empty and candidate).
This is storage recovery evidence using synthetic Skill records. The real-Agent
follow-up `make e2e-stage4-skill-restore` publishes a fixed Skill, restores the
Registry database and two real Agents' independent retained Skill and workspace
volumes with the other seven databases and legacy/private-backup volumes, then
enables both Agents while Registry is stopped. Each Agent completes a new ACP
Run that reads its pinned Skill through Runtime; Delete closes both Agents'
retained volumes. The same run disables one restored Agent, removes its retained
Skill volume while Registry remains offline, and confirms Enable stays in
`retry_wait` without creating a Runtime or an empty replacement volume; the
other Agent still completes a new Tool-backed ACP Run. Business and Trace
topology pass; strict Trace still records only the previously reviewed clock
warnings. The same real-Agent restore scenario now creates a verified RC backup
of the nonempty legacy shared volume and exports it to a private test directory.
After storage replacement it rereads the restored RC receipt, exports again
from the restored private backup volume and compares archive, manifest and
receipt files byte for byte. This same-host fixture does not establish an
off-host protected export. The bounded proof-loss and exact-source recovery
paths pass separate disposable Docker checks; missing or changed RC sources
still require operator restoration when those historical paths are used.
Independent off-host legacy export is outside the current scope. The
[Skill Registry design](skill-registry-minimal-design.md) defines B0/B3/I1 recovery
requirements; this addendum does not claim complete business recovery.

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
  invalidated before preparation resumes;
- for a historical deployment with legacy assets only, the shared system-Skill volume and an inventory of its Agent/container
  references until explicit migration has finished. Empty historical
  `skill_refs` do not prove that this volume is empty.
- for that same historical case, the RC-owned `runtime-legacy-backups` volume while any legacy choice or
  migration still references its archive receipt. Export its archive and
  manifest to protected storage and verify both hashes; the same-host copy
  alone is not an off-host recovery set.

For one legacy backup, mount a pre-created private export directory from
operator-managed storage, then run the RC image's isolated maintenance command
with the `backup_ref`, volume name and manifest digest returned by RC:

```sh
docker run --rm --network none --read-only \
  --mount "type=volume,source=${ANTNEST_RUNTIME_LEGACY_BACKUP_VOLUME},target=/backup,readonly" \
  --mount "type=bind,source=${PROTECTED_EXPORT_DIR},target=/export" \
  --entrypoint /usr/local/bin/legacy-backup-export antnest/runtime-controller:local \
  --source=/backup --destination=/export \
  --backup-ref="${BACKUP_REF}" --volume-name="${LEGACY_SKILL_VOLUME}" \
  --manifest-digest="${MANIFEST_DIGEST}"
```

`PROTECTED_EXPORT_DIR` must already exist as a 0700 directory on storage whose
failure domain and access policy the operator has verified independently. The
command requires locking, rename and directory sync support, writes 0700/0600
content, and reads back the full archive. `copy_verified` proves only that this
destination copy matches RC's backup; it does not certify an off-host location
or clear any Agent migration gate. Keep the RC and exported copies until all
legacy choices and restore obligations are resolved.

On an independent verifier outside the RC host/failure domain, mount the
protected export read-only and a dedicated 0600 Ed25519 PKCS8 private key
read-only, then run the maintenance verifier. The key must never be mounted in
the RC service or copied into the backup set. Supply the RC receipt's manifest
digest and the operator-owned external storage reference:

```sh
docker run --rm --network none --read-only \
  --mount "type=bind,source=${PROTECTED_EXPORT_DIR},target=/export,readonly" \
  --mount "type=bind,source=${VERIFIER_KEY_FILE},target=/run/verifier-key.pem,readonly" \
  --entrypoint /usr/local/bin/legacy-backup-attest antnest/runtime-controller:local \
  --destination=/export --backup-ref="${BACKUP_REF}" \
  --volume-name="${LEGACY_SKILL_VOLUME}" --manifest-digest="${MANIFEST_DIGEST}" \
  --storage-ref="${STORAGE_REF}" --verifier-id="${VERIFIER_ID}" \
  --key-id="${VERIFIER_KEY_ID}" --key-file=/run/verifier-key.pem
```

The output follows the [signed attestation contract](../contracts/skill-registry/legacy-export-attestation.md).
Keep it with the migration evidence. A storage URI and a successful local test
do not prove that storage is off-host; the operator must establish that
separately. Controller consumes the attestation in its explicit migration
operation, then releases the legacy gate only with a verified target Runtime
mount at atomic publication; an actual off-host operator run remains pending.
Controller's current/next public-key configuration and revocation history are
implemented.
Retain the Controller database's `legacy_export_verifier_keys` history in every
backup and restore. It records permanent revocations and prevents a restored
deployment from silently trusting a reused key ID.

Retained ready volumes are backed up so a disabled Agent can be enabled while
Registry is offline. The restore tooling derives the required volume manifest
from ownership and retained references; the storage fixture covers multiple
Agents, multiple retained sets, an empty set and a nonempty legacy shared
volume. The real-Agent scenario verifies independent personal workspaces and
offline reuse of two retained sets.

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

The historical migration procedure, excluded from current development, is:
before switching legacy Agents, inventory and back up the shared contents, then
record each Agent's explicit target: imported fixed versions in a new Template
revision, or a reviewed empty set. Invalid old files require an explicit operator
decision; they are not silently discarded. Unresolved Agents are blocked from
the new Enable/rebuild path with `legacy_system_skills_migration_required`.
Delete the shared volume only after all references have left and the migration
and preservation records have been verified. Controlled migration has passed
isolated Docker acceptance. Its independent protected off-host export was not
accepted and is no longer a current delivery requirement.

## Skill Learning Key Recovery Addendum (Planned)

The separate [learning design](skill-learning-design.md) requires L1R/L3/LI1 to
cover bootstrap key recovery. RC backups must retain the complete public-key set
frozen with each accepted operation and its deployment identity. ACP signing
keys stay in its protected secret backup, outside RuntimeSpec, logs and Git.
Restore must reconcile these records with current revocation/incident records
before opening maintenance. New global RC key configuration cannot rewrite an
unfinished operation's snapshot; a compromised key in an old backup cannot be
made trusted again by replay. Keep affected execution isolated, settle old
effects through the lifecycle recovery process, and explicitly rebuild with a
safe key set. These are future requirements, not existing key-rotation or backup
acceptance evidence.
