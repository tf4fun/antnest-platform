# Managed MCP secrets

Revision 2. This contract is shared by Controller, Runtime Controller, Runtime
and Admin Console. The implementation is delivered in separate owner batches,
then verified together; a producer alone does not complete issue #37.

## Template boundary

`env` contains public values. `secret_env` contains write-only values, including
tokens, passwords and credential-bearing URLs, regardless of their names.
Writes use `{ "value": "..." }` or, on revision only, `{ "keep": true }`.
Keep refers to the same server ID and name in the immediately preceding
revision; missing values are rejected. Omitting a name clears it from the new
revision. An empty string is a valid secret. Read responses contain only
`{ "set": true, "fingerprint": "hmac-sha256:0123456789abcdef0123456789abcdef" }`. Read descriptors cannot
be submitted as writes. Fingerprints are opaque diagnostic identifiers, not plaintext checksums. Controller
computes domain-separated HMAC-SHA-256 using a key derived from each envelope
data key; the read fingerprint contains the first 128 bits. The data key is
protected by the Controller encryption key/KMS and is never exported. A new
revision (including keep) has a new envelope and may have a different fingerprint.
Master-key re-wrapping preserves it. Template request fingerprints containing
value writes use a separate full HMAC over the exact request, keyed by the first
secret record in sorted server/name order. Replays use that original revision
record, including after master-key retirement; concurrent identical requests
recheck against the winning receipt. No unkeyed plaintext-secret digest is stored.

Names are unique across env and secret_env. Existing encoding and byte limits
apply to the combined resolved configuration, including kept values. Malformed
Unicode, reserved names (HOME, PATH, TMPDIR, TMP, TEMP, the five XDG cache/config/
data/state/runtime variables and ANTNEST_*), and unknown fields are rejected without echoing values.

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
does not follow the current Template head. Controller authenticates ciphertext
and its fingerprint against the frozen location. RC and Runtime treat the
fingerprint as opaque; they enforce exact variable names and resolved bounds,
with integrity supplied by Controller AEAD, workload authentication and the
protected bootstrap volume. They cannot recompute the HMAC. The resolver is not
bound to an Agent or lifecycle operation: authenticated RC can resolve any
organization's frozen Template revision. This is deliberate in the current
trust model, where RC owns the Docker socket and is equivalent to host root.

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
It executes each server as UID 2000 + its rank in sorted server IDs (0..7), with workspace GID
1000, empty supplementary groups, no capabilities and no-new-privileges. Values
enter only that server's environment immediately before exec for compatibility
with existing stdio servers. File remains root-only and unreadable by servers
and tools. UID 1000 tools cannot read another UID's environ or ptrace it; different
managed servers cannot read each other's environment. Do not rely on dumpability
surviving exec: exec may reset it, so distinct UIDs are the security boundary.
All managed UIDs share the Executor's tunnel routing and kill switch. The cwd remains workspace. RC mounts a bounded, exec/nosuid/nodev tmpfs at
`/run/antnest-mcp-home` with root-owned 0711 permissions. Each server has its own
UID-owned 0700 HOME (`<base>/<uid>`), TMPDIR/TMP/TEMP and XDG cache/config/data/
state/runtime directories below that HOME. The entry verifies the tmpfs and
ownership before dropping privileges. These directories are transient and reset
on container restart; OAuth caches may require reauthentication. The tmpfs
permits execution of a server's own cache programs; all such execution still
uses that server's unprivileged UID, empty capabilities and no-new-privileges. Managed MCP
uses umask 077 (tools retain 007), protecting default-created files even when a
server ignores TMPDIR and uses `/tmp`. The sorted UID allocation is invariant to
list reordering, not to adding/removing server IDs; the transient private tree is
recreated with each Runtime. Shared workspace GID permits intended access, but
MCP must explicitly grant group permissions when sharing its new files. Trusted
MCP code can still deliberately write credentials to shared locations or grant
world/group access; UID isolation does not protect against such disclosure.

The umask also applies to workspace output: default new files are 0600 and
directories 0700, so UID 1000 Bash/file tools cannot read an MCP-generated report
or traverse a cloned repository until the MCP grants group access. The private
0700 HOME/TMPDIR already isolates ordinary credential caches; umask 077 adds
protection for programs using shared `/tmp` directly. Retain this default for
the current release. If a concrete server compatibility issue requires revisiting
007, preserve the private directory boundary and explicitly reassess shared
`/tmp` credential handling; there is no per-server umask switch in this contract.

All configured servers (at most eight) share one cache tmpfs of
`resources.tmpfs_bytes`, equal to the separate `/tmp` mount's size limit.
Directory isolation does not provide per-server capacity quotas. A server that
fills this shared filesystem can cause other servers' cache writes to fail with
ENOSPC. The two mounts can together use up to twice that filesystem capacity,
subject to the existing container memory limit and other memory use; memory
pressure can cause OOM before either mount is full. The size values are upper
bounds, not reservations, and actual tmpfs usage counts toward the container's
`resources.memory_bytes`. See the [Linux tmpfs documentation](https://docs.kernel.org/filesystems/tmpfs.html)
and [Docker tmpfs memory accounting](https://docs.docker.com/engine/storage/tmpfs/).

## Upgrade

No heuristic can reliably infer which arbitrary env values are secrets. Existing
development Templates must be explicitly reconfigured with secret_env and Agents
recreated/rebuilt; old snapshots and RC journals containing plaintext must be
removed with the old disposable environment. Historical backups may contain
plaintext and must be handled as secrets. There is no automatic data migration or
rolling mixed-contract deployment. Upgrade Controller, RC, Runtime and Console
together while admission is stopped. Production data migration is outside this
pre-release repository's scope.
