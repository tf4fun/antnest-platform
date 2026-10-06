# Rotating encryption keys

Agent Controller encrypts Provider credentials; Identity encrypts OIDC client
secrets and login-session secrets. Each service owns its database, independent
key ring and `rekey` command. ACP's client-MCP key and workload/CCT/Skill signing
keys are separate and are not rotated by these commands.

## Upgrade before rotation

Back up the databases, existing encryption keys and matching binaries first.
The Controller `0025` and Identity `0003` migrations add envelope metadata.
Historical ciphertext retains its exact previous associated data and is read
as `local-v1`; new writes use authenticated envelopes even in single-key mode.

Use a coordinated binary cutover for each service: stop its old replicas before
starting upgraded replicas and reopening traffic. Old binaries cannot read new
envelopes or accept the new migration journal. This initial upgrade is distinct
from the online key rotation below. Do not run a mixed old/new binary deployment
or downgrade a binary against a migrated database. Rollback requires the saved
pre-upgrade database, keys and matching binary as one recovery set.

## Configuration

For `ANTNEST_AGENT_CONTROLLER` and `ANTNEST_IDENTITY`, choose exactly one mode:

| Mode | Variables | Behavior |
| --- | --- | --- |
| Single key | `<PREFIX>_ENCRYPTION_KEY` | Canonical padded Base64 for 32 bytes, mapped to `local-v1`; existing outer-whitespace trimming remains. |
| Key ring | `<PREFIX>_ENCRYPTION_KEYS` and `<PREFIX>_ENCRYPTION_ACTIVE_KID` | Exact comma-separated `kid:base64key` entries; only the active key seals new data. Other entries are decrypt-only. |

IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Ring entries and the active ID
are not trimmed. Duplicate/empty IDs, missing keys, an active ID absent from the
ring, malformed keys and mixed modes fail startup. Each configured key,
including decrypt-only entries, follows the existing
[development-secret policy](../contracts/platform/development-secrets.md).
No public key fallback or new development exception is introduced.

Standard Compose forwards both modes unchanged without public defaults. Each
owning service rejects missing or conflicting encryption configuration before
opening its listener or starting dependency clients. Compose rendering alone
does not validate this choice: older parsers eagerly evaluate nested required
branches even when the single-key branch is set. `.env.example` leaves both
modes empty. The development generator
still creates single keys for a fresh deployment; never regenerate them against
retained data. Store production rings in the deployment's secret store and never
print their contents or copy keys into issue reports.

## Online rotation

Perform these steps independently for each owning service. Generate a fresh
random 32-byte master key and give it a new ID; never replace bytes under an
existing ID.

1. Move from the single-key variable to a ring containing `local-v1` with the
   **original bytes** plus the new entry (for example `kid2`). Empty/unset the
   single-key variable. Keep active `local-v1` while every replica receives both
   entries. Existing rows and pending OIDC callbacks remain readable.
2. Switch every writer's active ID to `kid2`, keeping both entries. Confirm all
   writers have switched before starting the final conversion sweep. Configuration
   is read at process start, so changing a file requires restarting that replica.
3. Run the owning command with the same database and encryption configuration:

   ```sh
   docker compose exec -T agent-controller /usr/local/bin/agent-controller rekey --batch-size 100
   docker compose exec -T identity-service /usr/local/bin/identity-service rekey --batch-size 100
   ```

   The command loads only the owner's database and encryption configuration;
   it starts no HTTP listener, bootstrap, Temporal worker or dependency client.
   Use the exact Compose files, profiles, environment and project of the intended
   deployment. Do not run either command against a different recovery database.
4. Require exit zero and terminal JSON progress `updated: 0, remaining: 0` for
   Controller's `provider_connections` and **both** Identity tables
   `oidc_providers`/`oidc_auth_sessions`. Intermediate rows report committed batch
   counts. A zero count from only one table is insufficient. If an old writer was
   still active, fix its configuration and repeat the final sweep.
5. Remove the old entry from all replicas only after step 4. Verify saved Provider
   model discovery, normal Agent execution and OIDC login. Retain retired keys
   securely with backups that still contain their ciphertext.

Each command has a service-specific session advisory lock; overlapping commands
are rejected. Batches lock at most the configured 1–1000 rows (default 100).
Readers see a complete old or new envelope; writers of selected rows wait for
that batch. Payload ciphertext and nonce stay unchanged for envelope rewraps;
legacy rows are converted once. Business versions, timestamps, session states,
receipts and Agent/Runtime identities do not change. Rotation itself requires no
Agent rebuild, Skill preparation or user re-entry of Provider secrets.

Ctrl-C/SIGTERM cancels owned work. Committed batches survive, the current
transaction rolls back, and rerunning resumes. An unknown key or authentication
failure rolls back the whole affected batch and returns a nonzero exit. Restore
the correctly identified key or investigate corruption; do not relabel rows,
delete sessions or bypass authentication to make progress. Failures and progress
exclude credentials and plaintext. Do not retire any required key after an
unsuccessful command.

## Backups, compromise and KMS

A database backup needs every encryption key required by its rows, plus the
corresponding IDs and active configuration. A successful live rekey does not
rewrite an old backup. Validate restore with its protected key set before
serving traffic; see [backup and restore](docker-backup-restore.md).

Rekey changes storage encryption, not external credentials. After compromise,
rotate/revoke Provider API keys or OIDC client secrets with their issuers as well
and assess exposed backup copies. Removing a live key does not undo information
already disclosed.

The shared `KeyEncrypter.WrapDataKey`/`UnwrapDataKey` interface permits a future
KMS adapter. Current envelopes wrap a random per-record data key and authenticate
the owning service, existing record identity and exact master-key ID. Vault,
AWS/GCP KMS adapters are not implemented. See the
[normative contract](../contracts/platform/encryption-key-rotation.md),
[Controller operations](../services/agent-controller/docs/operations.md#rotating-encryption-keys)
and [Identity operations](../services/identity-service/docs/operations.md#encryption-key-rotation).
