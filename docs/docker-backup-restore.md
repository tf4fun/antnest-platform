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
`scripts/postgres-init.sh`. Recreate those exact roles and database owners before
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
   Controller, Runtime Controller, Egress and Identity. Verify stopped containers
   and clean service exits. Keep the telemetry collector available until writer
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
   initialized database names and owners, use
   `pg_restore --exit-on-error --single-transaction --username=<backup-role>
   --dbname=<database> <archive>` for each database. Do not suppress errors or
   treat a partially restored set as usable. See the
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
own disposable test project. It uses all five actual services/databases and
synthetic credentials, never `.secret`. It must:

- Create an Agent and completed Tool-backed ACP Session through Gateway.
- Disable the Agent and stop writers before snapshots.
- Export all five databases and volume archives plus protected encryption keys.
- Actually remove the temporary PostgreSQL, workspace and system Skills volumes;
  restore into new empty storage, not verify against surviving original data.
- Require an independent complete five-database/two-volume manifest before any
  destructive step; a missing workspace must not survive and produce false success.
- Compare database row/sequence and schema/object ownership/ACL fingerprints plus
  filesystem archives before any service can mutate restored data. Transactional
  permission-only mutations must change the fingerprint and roll back cleanly.
- Compare all three actual container-injected encryption keys with pre-backup
  digests, including Identity. Direct Prompt on an untouched old ACP Session
  exercises its original encrypted MCP revision; load alone is insufficient.
- Log in again, replay history without a model request, enable the Agent and run
  a real Tool against restored files, proving decrypted model configuration works.
- Delete only its own labelled resources and temporary backup files on success,
  failure or interruption. Conflicting ownership labels block deletion even in
  finally cleanup. Preserve retained human-acceptance stacks.

```sh
node scripts/lifecycle-closeout/run.mjs restore
```

Final measured results belong in [C5-02](docker-single-node-closeout.md), not in
committed dumps, secret bundles or step-by-step execution logs.
