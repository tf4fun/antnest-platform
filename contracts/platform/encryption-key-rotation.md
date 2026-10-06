# Stored-secret encryption and rotation

Revision 1, issue [#42](https://github.com/tf4fun/antnest-platform/issues/42).
This contract covers Agent Controller Provider credentials and Identity OIDC
client secrets and login-session secrets. ACP's client-MCP encryption is outside
this change. The services own their tables and migration/rotation commands.

## Configuration

For each `ANTNEST_AGENT_CONTROLLER` or `ANTNEST_IDENTITY` prefix, choose exactly
one configuration:

- Legacy `<PREFIX>_ENCRYPTION_KEY`: canonical padded Base64 for 32 bytes; maps
  to the key ID `local-v1`. Existing outer-whitespace trimming is retained.
- `<PREFIX>_ENCRYPTION_KEYS`: comma-separated `kid:base64key` entries, with
  `<PREFIX>_ENCRYPTION_ACTIVE_KID` selecting one entry. IDs match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` exactly. Ring entries and active IDs are
  not trimmed. Empty entries, duplicate IDs, unknown active IDs, malformed keys,
  mixed modes and active-only configuration fail before startup.

Only the active key wraps new data keys. All other keys are decrypt-only.
Every configured key, including decrypt-only keys, passes the existing
[development-secret admission](development-secrets.md). Missing keys are always
rejected; uniform keys require its existing explicit disposable-test opt-in.
This change introduces no second development profile or weaker exception.
Configuration errors never echo key material.

The dependency-free encryption module owns configuration loading and parsing.
Each service supplies its variable prefix and a required key-check callback from
its existing development-secret policy. Every configured key is checked,
including decrypt-only members; policy errors and variable-only warnings retain
their existing meaning. The module does not depend on `service-authentication`.

Compose forwards the single-key/ring fields with optional `:-` interpolation.
Compose 2.38 evaluates required substitutions inside an unused nested branch,
so `:?` cannot safely express the alternative here. Missing or conflicting
Controller/Identity encryption configuration is rejected by the owning service
before startup, causing `docker compose up --wait` to fail. `compose config` may
render with these two owners' encryption fields empty; its missing-secret check
from #13 now covers the other **10 of the original 12 fields**: nine passwords
and `ANTNEST_ACP_CLIENT_MCP_KEY`. This changes the rejection stage, not the
requirement to configure secrets or the ban on public defaults.

## Storage and authentication

New records use envelope encryption: a random 32-byte data key encrypts the
payload with AES-256-GCM and a random 12-byte nonce. The configured master key
wraps that data key with a separate random nonce. Store the master-key ID,
wrapped data key, payload nonce and ciphertext together in the same row.

The envelope format is versioned. Payload associated data binds the format,
owning service and existing record identity. Wrapping associated data binds
that same identity **and the exact master-key ID**. Changing a key label,
record identity, wrapped key or ciphertext fails authentication, even if two
IDs contain the same key bytes. Binding the ID at the wrapping layer permits
later KMS re-wrapping without changing the payload ciphertext.

The shared Go module exposes `KeyEncrypter.WrapDataKey` and `UnwrapDataKey`;
the local adapter uses the configured ring. A remote KMS adapter is follow-up
work, not an implemented external dependency or new RPC in this revision.

Historical records with no wrapped data key are accepted only as `local-v1`
using their exact previous associated data. Controller keeps `key_version`;
Identity adds `client_secret_key_id` and `secret_key_id`, defaulting historical
rows to `local-v1`. Nullable wrapped-key columns distinguish the legacy format.
New writes always use the envelope format, including single-key configuration.
No fallback attempts another key or accepts an unknown ID.

## Online rotation command

Each owning binary implements `rekey [--batch-size N]` (default 100, range
1–1000). It loads only its database and encryption configuration; it does not
start HTTP, Temporal, bootstrap accounts or other service clients. Ctrl-C and
SIGTERM cancel database/cryptographic work and close all owned resources.

The command processes non-active or legacy envelopes in bounded transactions,
locks selected rows, authenticates the complete old envelope, and atomically
replaces only encryption metadata. Enveloped rows keep payload bytes and
nonce while re-wrapping the data key; legacy rows are converted once. Provider
credential versions, OIDC provider revisions, session states, timestamps,
request receipts and execution revisions do not change. Normal readers always
see a complete old or new envelope. Concurrent secret replacement is serialized
by row locks, so rotation cannot restore an obsolete credential.

Committed batches survive cancellation; rerunning resumes from remaining rows.
An unknown key or authentication failure rolls back that whole batch and exits
nonzero. No row is skipped as successful. A service-owned advisory lock rejects
overlapping rotation commands; it does not block normal reads or writes.
Progress reports table, committed row counts and active key ID only. Failures
do not expose plaintext, ciphertext, DSNs or database error details.

## Deployment sequence and acceptance

1. Back up each owned database with its required keys and matching binary.
   Stop old replicas before starting upgraded replicas with the existing single
   key and additive migrations. **The first upgrade requires downtime; a rolling
   old/new binary deployment is unsupported even when retaining a single key.**
   Old binaries cannot accept the migration journal or read new envelopes.
2. Add a fresh key to every replica's ring, retaining all old keys. Once every
   replica can decrypt both IDs, activate the new key on every writer. Do not
   run rotation while a writer still uses an old active key.
3. Run the owning `rekey` command while normal reads continue. Require a
   successful final zero-remaining result for every owned sealed table.
4. Remove the old key only after all writers have switched and rotation has
   completed. Retained historical backups still require their old keys.

Removal is not hot reload: recreate/restart the owning service with its updated
configuration. Downgrading against the migrated database is unsupported;
rollback requires the matching pre-upgrade database, keys and binary.
Encryption rotation cannot undo a leak of previously exported
secrets; revoke/replace affected Provider and IdP credentials separately.

Delivery is split into shared contract/module, Controller, Identity, then an
explicit integration batch. The final batch must prove mixed/legacy PostgreSQL
conversion, concurrent readers and writers, interrupted/resumed commands,
authentication rollback, and real Docker key add/activate/rekey/remove while
existing Agents remain available and synthetic Provider requests authenticate.
