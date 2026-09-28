# Legacy system-Skill backup evidence (B0)

The Runtime Controller (RC) is the only service with a read-only mount of the
pre-cutover shared system-Skill volume. A backup is a separate operation from
inventory and from an Agent's migration choice. An operator must stop or fence
all writers before requesting it; two matching scans are an additional drift
check, not a substitute for quiescence.

RC creates one private backup directory per stable request ID. It contains a
tar archive of the complete legacy tree and a JSON manifest with the configured
volume name, the inventory digest, each path/kind/mode/size/content digest, the
archive SHA-256, and creation time. Regular files are copied by bytes;
directories and symlink **targets** are preserved without following links.
Unsupported file kinds fail closed and require explicit operator handling.
The archive and manifest are written to a private staging directory, read back
and checked, then exposed together by an atomic directory rename. A failed or
interrupted attempt leaves no accepted receipt. A matching request ID replays
the immutable receipt only after rechecking both files; a different expected
inventory for that ID conflicts.

`GET /internal/legacy-system-skills/backups/{backup_ref}` returns that same
receipt after verifying the stored manifest and complete archive again, without
consulting the current shared volume or Docker. An absent reference returns
`404 legacy_backup_not_found`; a damaged or inaccessible record returns
`503 legacy_backup_unavailable`. This read-only identity check enables a later
Controller batch to compare its append-only choice to RC evidence. It does not
attest to an off-host export or authorize migration by itself.

The source scan before writing, each archived file's digest, and a second
source scan after writing must all match the caller's expected inventory.
RC must never report a successful backup of an incomplete or changed tree.
The same 10,000-entry and 1 GiB regular-file bounds as the inventory endpoint
apply. Archive and manifest bytes must remain in restricted persistent storage
and be included in the recovery set until all legacy migration gates have
resolved. A same-host RC copy alone does not prove an off-host protected export;
the migration completion step must verify the operator's protected export
against this RC receipt before it clears any Agent gate.

The RC-owned maintenance exporter copies one verified backup directory to an
operator-provided private destination mount. Inputs bind `backup_ref`, the
configured legacy volume name and the expected manifest SHA-256. Before copying,
it validates the complete source archive; after writing to a private staging
directory it reads back and validates the complete destination archive, then
atomically renames the directory. A matching destination replays only after
verification; an existing different or damaged destination fails closed. The
tool enforces 0700 directories and 0600 files, bounded bytes, fixed-file
no-follow checks and resolved source/destination separation. The destination
filesystem must support advisory locking, atomic
directory rename and directory `fsync`; failure of any step rejects the copy.
Its result is `copy_verified`, **not** an off-host attestation.
Operators must provision and independently verify protected storage outside the
RC host and recovery failure domain; destination path syntax or a second local
volume cannot prove that property. The migration gate never consumes this
tool's result directly.
The [v1 independent verifier attestation](legacy-export-attestation.md)
defines that contract; its verifier and Controller consumer are delivered in
separate service-owned batches.

Delivery batches:

1. RC builds and verifies the private archive/manifest, with local and Docker
   evidence. Its internal idempotent `POST /internal/legacy-system-skills/backups`
   returns the receipt. The separate maintenance exporter verifies a private
   destination copy, but an independently proven off-host location is still
   required; neither receipt alone is proof of protected preservation.
2. Controller verifies the RC receipt when recording an append-only choice.
   It must independently verify protected-export evidence before starting the
   selected migration transition.
3. The explicit integration batch proves a populated old volume survives
   backup, migration, restore, and final shared-volume cleanup.

The choice's `backup_ref` and `backup_digest` name the RC-local evidence.
Even a verified choice does not authorize Enable, Rebuild, or migration
completion without protected-export verification.
