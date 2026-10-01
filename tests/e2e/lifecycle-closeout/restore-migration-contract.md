# Offline restore contract

This document defines what the offline backup and restore profile
(`make e2e-lifecycle-restore`) must prove. The operator procedure it exercises is
described in [Docker backup and restore](../../../docs/docker-backup-restore.md).
The profile uses the Foundation setup, private Temporal, reserved network ranges
and an immutable Runtime image, and exercises Create, Disable, Enable and Delete
with exact replay.

## Recovery set

The recovery set contains five application databases plus Temporal history and
visibility, two owned persistent volumes and three saved encryption keys.

## Required behavior

- Application writers stop normally, then Temporal, and the complete clean-exit
  inventory is required before export.
- Empty storage and the original roles are recreated, and all seven databases are
  restored before any schema initializer or writer starts. Frozen data, sequence,
  ownership and ACL fingerprints must match.
- Permission-drift probes, archive checksums, volume ownership, hidden files,
  modes, symlinks and Skills are preserved.
- The isolated in-memory Jaeger keeps running across storage replacement so both
  sides of recovery stay traceable; it is not recovery data. The deterministic
  model is stopped and recreated so post-restore requests start empty.
- Public Agent events, configuration, network rules and the original completed
  Run are unchanged. Exact history replay must not create a Run or call the
  model.
- Prompting an untouched restored Session exercises its original encrypted MCP
  revision and exactly one new Tool Run under the new execution revision.
- A business Delete removes the owned Agent resources.

## Trace and verification rules

Actual SDK request Traces and all lifecycle topologies are collected without
waiving strict warnings or errors. Negative assertions come first, checks run
serially, and owned cleanup and other containers' identity, image, mounts and
health are inspected afterwards.
