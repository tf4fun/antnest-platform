# Managed MCP secrets

Revision 1. This contract is shared by Controller, Runtime Controller, Runtime
and Admin Console. The implementation is delivered in separate owner batches,
then verified together; a producer alone does not complete issue #37.

## Template boundary

`env` contains public values. `secret_env` contains write-only values, including
tokens, passwords and credential-bearing URLs, regardless of their names.
Writes use `{ "value": "..." }` or, on revision only, `{ "keep": true }`.
Keep refers to the same server ID and name in the immediately preceding
revision; missing values are rejected. Omitting a name clears it from the new
revision. An empty string is a valid secret. Read responses contain only
`{ "set": true, "fingerprint": "sha256:12345678" }`. Read descriptors cannot
be submitted as writes. Fingerprints are diagnostic, not authentication.

Names are unique across env and secret_env. Existing encoding and byte limits
apply to the combined resolved configuration, including kept values. Malformed
Unicode, reserved names and unknown fields are rejected without echoing values.

Controller seals every value in its own `managed_mcp_secrets` table, in the
same transaction as the immutable Template revision. AAD binds organization,
Template, revision, server ID and variable name. Keep decrypts the predecessor
and seals under the new location. Provider/master-key rotation also rotates
this table. Catalog receipts, Agent snapshots and execution audit contain only
descriptors; they never contain plaintext or ciphertext.

## Delivery boundary

Lifecycle configuration pins `managed_mcp_template` and the server descriptors.
RC journals and deployment digests contain no values. Only authenticated RC may
resolve a frozen Template's values through Controller's internal bootstrap
route. No end-user CCT or browser route grants access to that route. The resolver
does not follow the current Template head. RC checks every returned value against
the pinned fingerprint and rejects missing, extra or overlapping variables.

RC materializes a root-owned bootstrap volume scoped to Agent and generation,
mounted read-only at `/run/antnest-mcp`. Its directory is 0700 and configuration
file is 0400. Unlike a container tmpfs, this protected bootstrap survives ordinary
container restarts; it is never included in general workspace backups and is
removed with its generation. This deliberately follows the existing private
instance-authentication volume delivery rather than adding an online bootstrap
server. Docker/host administrators remain trusted. No value enters Docker
Config.Env, labels, health checks, deployment identity, logs or spans.

## Process boundary

The root entry reads and verifies the private bootstrap before dropping privilege.
It executes each server as UID 2000 + its position (0..7), with workspace GID
1000, empty supplementary groups, no capabilities and no-new-privileges. Values
enter only that server's environment immediately before exec for compatibility
with existing stdio servers. File remains root-only and unreadable by servers
and tools. UID 1000 tools cannot read another UID's environ or ptrace it; different
managed servers cannot read each other's environment. Do not rely on dumpability
surviving exec: exec may reset it, so distinct UIDs are the security boundary.
All managed UIDs share the Executor's tunnel routing and kill switch. Shared
workspace group permissions permit intended file access without sharing a UID.

## Upgrade

No heuristic can reliably infer which arbitrary env values are secrets. Existing
development Templates must be explicitly reconfigured with secret_env and Agents
recreated/rebuilt; old snapshots and RC journals containing plaintext must be
removed with the old disposable environment. Historical backups may contain
plaintext and must be handled as secrets. There is no automatic data migration or
rolling mixed-contract deployment. Upgrade Controller, RC, Runtime and Console
together while admission is stopped. Production data migration is outside this
pre-release repository's scope.
