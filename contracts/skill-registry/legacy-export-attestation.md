# Legacy system-Skill protected export attestation (v1)

An RC-local backup receipt or a `copy_verified` maintenance result cannot lift
the legacy migration gate. An independent verifier, running outside the RC
host/failure domain with a signing key unavailable to RC, reads the protected
export and validates its complete manifest and tar archive. Only then may it
issue this signed attestation. The operator owns the storage location and must
verify that it is off-host, access-controlled and part of the recovery plan;
a URI alone is not proof of those properties.

The JSON attestation contains exactly these signed fields:

| Field | Meaning |
| --- | --- |
| `version` | Integer `1` |
| `key_id` | Non-reusable identifier for one Ed25519 public key |
| `verifier_id` | Identity of the independent verification host/process |
| `storage_ref` | Operator-owned external storage reference; no credentials |
| `backup_ref` | RC-local backup request ID |
| `volume_name` | Configured legacy shared Docker volume |
| `inventory_digest` | SHA-256 identity of the source inventory |
| `archive_digest` | SHA-256 of the complete tar bytes |
| `manifest_digest` | SHA-256 of the complete JSON manifest bytes |
| `verified_at` | UTC RFC 3339 timestamp of target readback |
| `expires_at` | UTC RFC 3339 timestamp, at most 24 hours after verification |
| `signature` | Canonical base64 Ed25519 signature over the message below |

Every string is ASCII, nonempty, bounded to 1024 bytes and contains no newline.
`key_id`, `verifier_id` and `backup_ref` use
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`; digests use lowercase
`sha256:` plus 64 hex digits. `storage_ref` is a credential-free `s3`, `gs`,
`az`, `ssh` or `nfs` URI with a nonlocal authority and nonempty object/path.
This syntax is only an identity constraint, not an off-host proof.

Sign these UTF-8 bytes with Ed25519, using LF separators and a final LF:

```text
antnest/legacy-skill-export/v1
key_id
verifier_id
storage_ref
backup_ref
volume_name
inventory_digest
archive_digest
manifest_digest
verified_at
expires_at
```

The literal first line is the domain separator; each subsequent line is the
value of the named field, not the field name. The `version` field is bound by
the domain separator. The signature field is excluded from the message.

Before signing, the verifier checks a private 0700 destination root, 0700
backup directory, 0600 regular archive/manifest/receipt files, complete tar
entry content and modes, archive and manifest hashes, and the expected RC
manifest digest. It refuses symlinked fixed files, malformed or oversized
payloads and wrong identities. It must not accept a caller's `copy_verified`
flag as a substitute for reading the bytes.

Controller's consumer pins a bounded current/next public-key set by
`key_id`, verify the canonical signature and expiry, compare every backup
identity to its latest append-only choice and a fresh RC receipt, and reject a
key that was revoked or reused with different bytes. It will not call a
request-provided key URL. The attestation authorizes only the subsequent
explicit migration operation, not ordinary Enable or Rebuild on its own.
Controller configures this set through
`ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS`: a JSON object with
required `current` and optional `next`, each containing exactly `key_id` and
`public_key` (canonical base64 of 32 Ed25519 bytes). An unset value configures
no verifier; migration remains unavailable. At startup Controller reconciles
the configured IDs and key bytes against its durable key history. A removed ID
is permanently revoked; a revoked ID cannot be reactivated, and an existing ID
cannot be assigned different bytes. Rotation adds `next`, deploys it, promotes
it to `current`, then removes the old key. A compromised key is removed from
configuration immediately; in-flight migration must be halted until all
Controller instances use the revoked set. The database key history is part of
the recovery set and must be restored with the Agent database. Restoring older
history or losing it requires an operator review before migration resumes.
The explicit migration operation rechecks active key status and expiry when it
consumes the proof; a prior validation is not a durable grant. The gate remains
closed until that operation verifies the target Runtime mount and atomically
publishes the migrated Agent. Same-host tests of signing and consumption do not
prove that the operator's export resides outside the RC failure domain.
