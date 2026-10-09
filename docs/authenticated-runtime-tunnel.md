# Authenticated Runtime tunnel (#111)

This freezes the Phase 2 delivery boundary. Service implementations are delivered
in the batches below; a contract commit alone is not a completed business flow.
The deployment is a coordinated development cutover; raw packet revision 1 is
not a compatibility decoder for revision 2.

## Protocol choice and framing

Use BoringTun 0.7.1's WireGuard engine, without its device/UAPI server. The engine
owns Noise IKpsk2, ChaCha20-Poly1305, handshake key confirmation, session key
rotation and the bounded receive replay window. Antnest does not implement its
own nonce, handshake or cipher. See the
[WireGuard protocol](https://www.wireguard.com/protocol/) and
[BoringTun API](https://docs.rs/boringtun/0.7.1/boringtun/noise/struct.Tunn.html).

One UDP datagram is `ANT2` (4 ASCII bytes), the 16-byte opaque key ID, and one
unmodified WireGuard message. The prefix selects a prepared per-generation
context; it grants no authentication. Each context has independent key material,
and accepted decrypted IPv4 source/destination must match that context's Agent
allocation. A changed prefix cannot borrow another Agent's policy. Raw IPv4,
unknown/retired key IDs and unsupported framing are dropped before policy,
flow creation or victim-attributed telemetry.

The inner contract stays unfragmented IPv4 TCP, 1400 bytes, one packet per
datagram. Data overhead is at most 20 + 32 + 15 bytes, so outer IPv4/UDP fits
1500 bytes. Handshake, cookie, keepalive and timer packets are consumed by the
engine and never become TUN packets. No runtime packet retransmission is added;
inner TCP and WireGuard's own handshake timers retain their respective jobs.

## Ownership and secret delivery

RC issues a random `rtk_<32 lowercase hex>` ID and fresh X25519 private keys for
both endpoints plus a random 32-byte PSK for every Initialize/Update/Enable
compute generation. Disable/Delete do not invent a generation. All material is
sealed with the existing RC instance master key and scope/Agent/generation/
connection identity AAD, committed with the accepted operation, and reused on
exact-request recovery. Public inspection reports only the current key ID.

RC writes only the Runtime's private key, PSK and Egress public key into
`/run/antnest-auth/tunnel.json`, next to the existing caller profile in the
generation-private read-only named volume. Directory 0700, files 0600, root owner,
no symlinks; verify actual mount and both file digests before start. RuntimeSpec
carries only key ID, fixed path and digest, never any private material. Runtime
loads this before Executor/MCP child admission. UID 1000 and MCP UIDs cannot read
the volume or Supervisor memory. Docker env, Template, Inspect, observations,
operation views and logs contain no plaintext key.

RC privately registers only Egress's private key, Runtime public key and PSK
through `PUT /internal/agent-tunnel-keys/{agent_id}` with its authenticated
workload. Controller has no secret-bearing endpoint or payload. Every sender,
receiver and audit/content-capture boundary treats this route as metadata-only.
Egress encrypts its rows with an independently generated private master-key file,
AAD-bound to Agent/key ID/Runtime revision/Tunnel IPv4. It restores rows from its
own database after restart without an RC availability dependency. The new
workload pair and network permission are RC → Egress only.

The development generator creates the independent master at
`runtime-egress/tunnel-master.key`. Before Compose startup, run
`node scripts/dev-egress-auth-owner.mjs` against that generated directory. Its
one-shot, network-isolated root container changes only the receiver and master
files to UID/GID 0 and preserves 0600, so Linux bind mounts meet Egress's private
file requirements. It adds no running service. Repeat after restoring or
replacing either file; never regenerate the master for retained encrypted rows.

The generator is for a fresh deployment, not retained-directory rotation. When
keeping an existing development deployment, preserve the RC instance master,
Identity CCT and maintenance keys. Provision only the new RC → Egress token/file
and its hash in Egress's receiver profile, retaining Controller → Egress authority,
plus the independent new Egress master before first encrypted rows are written.
Stop admission and restart the affected credential readers under the existing
[rotation order](../contracts/platform/development-authentication.md#mounting-and-startup).
Replacing the whole directory with fresh credentials requires a coordinated
restart of all static workloads, not only the four tunnel owners.

## Lifecycle and recovery

RC registers the candidate key before workspace/compute mutation and before
Runtime start, after the generation's sealed material is durable. Allocation must
exist and its attachment must be closed. Registration is exact-tuple idempotent;
conflicting key IDs/material fail. A transient registration failure leaves the
accepted RC operation running, with its original key and no platform effects;
same-request retry resumes rather than returning a terminal create failure.

Egress retains at most the current and one candidate context per Agent. Closed
attachments permit authenticated canonical readiness probes only, never
external data. Candidate probes can make Runtime ready before Controller opens
traffic. Controller reads current RC inspection and passes both `runtime_endpoint`
and `tunnel_key_id` in the existing attachment CAS. Open selects the exact
prepared key, clears flows/conntrack and retires the previous context under the
same packet-output barrier. A rejected rebuild can restore the source's current
key while its compute remains current; it cannot revive a superseded generation.
Release removes all key rows and in-memory sessions.

Normal Runtime/Egress process restart rebuilds the WireGuard session with fresh
ephemeral keys; old encrypted data cannot enter a new session. No per-packet
database counter write or persistent replay bitmap is needed. Data-plane
generation keys survive restart in protected storage, while rekey/session timers
remain protocol-owned. A surviving Runtime recovers a restarted Egress through
BoringTun's standard silence timer (10-second keepalive plus 5-second rekey
timeout); connectivity is not immediate during this window. Recovery acceptance
keeps the Runtime alive and allows a bounded 30-second retry window, and checks
that old encrypted data remains rejected after the new handshake. Updating the Egress at-rest master key requires a
coordinated key/data backup and rewrite, outside automatic packet rekey; loss of
that key is fail-closed. A leaked generation key requires explicit disable and
rebuild, not an in-place environment edit.

Phase 1 outer IPv4 checks, Controller's non-blocking health journal/rebind worker,
and the independent nft destination backstop remain. Authentication prevents an
old-address holder from impersonating the previous Agent even before rebind;
current IP binding additionally narrows admission. Host/Docker/RC/Egress
administrators remain trusted. No packet plaintext or private key is captured in
traces; authentication/replay/unknown-key drops use aggregate metrics.

## Delivery batches and evidence

1. Shared contract + pure Rust transport module: public schemas, framing/key
   fixtures and two-peer tests for auth, wrong keys, tampering, replay, reordering,
   old counters, fresh sessions and wrong context. Freeze BoringTun 0.7.1.
2. RC owner: sealed generation keys, private-volume material and verification,
   idempotent registration before platform effects; unit/contract/component/
   PostgreSQL and owning Docker gates, with pending consumers recorded.
3. Runtime owner: verified private bootstrap, encrypted packet session, bounded
   timers/readiness and malformed packet handling; unit/contract/component/
   actual Linux Docker evidence and UID/MCP isolation.
4. Egress owner: workload-private registration, encrypted storage, bounded slots,
   authenticated ingress/egress, replay metrics and fail-closed cleanup; unit/
   contract/component/PostgreSQL/owning Docker and unchanged nft bypass proof.
5. Controller owner: key-aware Inspect/open/rebind/source restore and RPC fixtures;
   local gates before cross-service claims.
6. Integration/deployment: generated private Egress master key, RC → Egress
   purpose network and sender/receiver permissions; source-built Docker proves
   create/rebuild/disable/enable/restart and impersonation/replay after old outer
   address reassignment. Freeze release cutover and SECURITY only after passing.

Each owning implementation is committed separately, followed by integration.
All test/evidence locations follow AGENTS.md. Keep the human acceptance project
untouched. Submit one reviewable PR and stop for human review; do not merge it.

## Current delivery record

The shared transport and all four owning service batches are committed. RC's local
Go/PostgreSQL/lint gates and 157-check Docker admission passed; Runtime's host
and native Linux gates and 401-check Docker admission passed. Egress's unit,
contract, socket, Clippy and 12 PostgreSQL checks passed; its production-image
Docker admission completed 189 checks, including wrong authority, plaintext,
wrong key, tampering, replay, restart and independent nft bypass rejection. All
owning Docker fixtures were removed. Private evidence lives under
`artifacts/verification/issue-111-20261006125553Z/` and the respective owning
harness directories.

Controller consumption passed its local unit/lint gates, 685 tests and 1227
subtests with race detection and no skips under PostgreSQL/Temporal, and 106
owning Docker checks. Its source-IP/key-ID validation, same-address rebind,
lost-open replay and source restoration are covered.

Source-built ACP v1 and v2 integration each passed six Runs and 16 synthetic
Provider requests, with complete normal trace topology and owned-resource
cleanup. Both reassigned the victim's old outer IPv4 to another container while
retaining its old Egress binding: wrong authority and a captured encrypted replay
were rejected without policy/flow effects. Create/rebuild/enable issue different
generation identities; normal Runtime restart retains its generation identity
and converges after address rebind. Egress outage does not block Runtime health
journal consumption.

The updated Stage1, Stage2 and RC shell entry points passed. Stage1 keeps Runtime
alive across an Egress restart and verifies real TCP recovery through standard
engine timers. The warm-receiver component also rejects pre-restart ciphertext.
Stage2's nine business scenarios, Controller worker replacement and 330 ACP
PostgreSQL tests passed. The isolated native MCP suite preserves its ten scenarios
and official SDK close/Trace regression under authenticated packet revision 2.
The final repository gate passed 1969 Node tests and its Python checks. Existing cross-process clock-only Trace
warnings remain under the previously accepted policy; no timing correction or
NTP dependency is added. Native Skill-learning and temporary-Skill HTTP flows
passed with authenticated bootstrap, signed maintenance tickets, isolated MCP
UIDs and the canonical Runtime Host. Host-side fixtures use one-to-one listen
port publication and the official SDK's default HTTP transport; production
transport and SDK code are unchanged. Final Docker container/network/volume identities exactly match the
retained set after integration; unique test image tags were removed.

Final source was rebased onto main snapshot `92f6524`, retaining its Runtime
reverse-path filter/process-scan/tracing and fixture fixes. Egress's 189-check
Docker gate, native MCP/learning/temporary flows, source-built ACP v2 integration
and repository/format/storage/caller/link checks passed again. The shared tunnel
module also selects both transport owners and applicable integration suites in CI.
