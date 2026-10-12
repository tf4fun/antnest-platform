# Password verification and resource admission

This is the shared policy for [#60](https://github.com/tf4fun/antnest-platform/issues/60).
The [machine-readable policy](password-verification-policy.json) has its own
revision. Its historical wire baseline is Identity revision 16 and Gateway
version 21. The candidate Identity revision-17 catalog declares
`credential_busy`/503 and `credential_rate_limited`/429. Identity implements both
projections, persisted login/password-change attempts and transactional
rehash/rotation. Scheduled cleanup remains pending.
Gateway remains at version 21 until its version-22 consumer implementation.
Console adoption and cross-service
integration also remain pending. A policy reference alone does not activate a
service or establish completion of this policy.

Identity owns password attempt state, Argon2 capacity and stored-hash migration.
Gateway retains its cheap login admission filter. Gateway table pressure and
eviction remain [#2](https://github.com/tf4fun/antnest-platform/issues/2).
Password RPC caller authorization remains unchanged: local login and browser
password changes are Gateway calls; password changes require the live, trusted
session CCT defined in [browser sessions](browser-sessions.md).

## Persistent attempt admission

Use PostgreSQL credential_attempts, keyed by (scope, key_hash), with
window_start, failures and nullable locked_until. No raw password, email,
organization slug, access token or CCT belongs in this table or its diagnostics.

| Scope                | Identity                                                    | Threshold | Successful operation                                       |
| -------------------- | ----------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| login_account        | Stable Organization namespace and normalized email          | 5         | Reset only this account bucket with token issuance         |
| password_change_user | Global User ID                                              | 5         | Reset only this User bucket with password rotation         |
| organization         | Organization namespace, shared by login and password change | 100       | Keep failures, including those belonging to other accounts |

A known Organization namespace uses its immutable ID, including for an unknown
email within that Organization. An unknown, well-formed slug uses a distinct
namespace. Apply the existing Identity slug/email normalization. Once a request
has resolved an Organization ID, a display rename cannot retarget that request
or reset its bucket. Reuse of a slug by a different Organization creates a
different known namespace; unknown-slug counters never transfer to a new entity.
A password-change request takes its Organization only from the verified CCT.
Its User bucket is global, so switching Organization cannot reset that limit.

Keys are SHA-256 over a sequence of length-prefixed UTF-8 parts. Prefix each part
with its unsigned 32-bit big-endian byte length. The first two parts are
antnest.credentials.v1 and the scope. A known namespace adds org-id and the
Organization ID; an unknown namespace adds unknown-slug and the normalized
slug. The login_account scope appends the normalized email. The
password_change_user scope instead appends only the global User ID after the
scope. Lengths and explicit namespace tags prevent delimiter and cross-scope
collisions.

For local login, unknown accounts, unavailable local credentials and inactive
principals use one current-policy dummy verification after the same bucket
admission. Matching the dummy password can never authenticate. Every completed
dummy verification, including a match, counts one wrong-password outcome in
the same account and Organization buckets. Busy, cancellation and storage errors propagate in the same form for
known and unknown accounts. Syntactically invalid login identities retain the
generic authentication rejection and one bounded dummy verification; they
cannot resolve an account or acquire a canonical account bucket.

The account/User threshold is five; the aggregate Organization threshold is 100. At the threshold failure, set a one-second backoff. Each subsequent failed
verification after a delay doubles it, capped at 900 seconds. Saturate the
counter at threshold plus ten. The fifth wrong account password still returns
the normal authentication error; a sixth attempt arriving during its committed
backoff returns credential_rate_limited before any KDF. A blocked request does
not increment counters or extend the lock. Do not sleep through backoff while
holding a transaction.

The counter window is 15 minutes, anchored at its first failure. Reset on expiry
only after both the window and any backoff have ended. Use fresh database time
after lock waits, rather than a replica clock or transaction-start timestamp.
Each Identity instance owns one serial cleanup worker. It waits one minute
before the first pass and one minute after each completed pass; a pass may remove
at most 500 eligible rows using locked-row skipping. This bounds work per
instance; it is not a cluster-wide deletion quota. A full batch or an error never
causes immediate retries or catch-up passes. Shutdown cancels and joins the
worker before closing the database pool, including server-error exits where the
parent context is still live. Cleanup must not remove a live backoff or an in-use
bucket, and cannot create an admission path that bypasses a disappeared/recreated
row. Logs may contain a fixed failure classification but no underlying storage
error, identifier or credential material.

## Transaction and concurrency boundary

Admission, authoritative credential lookup, verification and the durable outcome
belong to one repository-owned transaction. Serialize on the Organization
attempt row before creating or locking the account/User attempt row. A blocked
Organization must not cause one new account row per rejected email. Keep these
locks through verification and commit. Password verification within one
Organization therefore serializes; independent Organizations can progress
concurrently under the same process resource budget.

Order locks as: Organization attempt, account/User attempt, User, Organization,
Membership, credential with update intent, sorted browser tokens, revocation
feed. Preserve the existing parent-before-token/feed ordering. Bound row-lock
and pool admission waits to two seconds and the request deadline; return
credential_busy for capacity/lock wait exhaustion. There is no retry loop that
resets either budget. Do not acquire a KDF permit while waiting for database
locks: its holder performs only the bounded KDF and releases it before subsequent
database work.

After four committed failures, simultaneous fifth and sixth requests cannot
both reuse that count. The fifth owns admission through outcome commit; the
sixth rechecks fresh time and the committed delay after acquiring the same rows.

The transaction callback's error path rolls back. A wrong-password outcome must
instead update both buckets, commit successfully, then return the existing
authentication rejection. A storage or ambiguous-commit error cannot be
reported as a confirmed password failure. No token or session-revocation event
is written for a wrong password.

A successful login resets its account only with successful token issuance.
Password rotation resets its User bucket only with the successful rotation.
Neither operation clears the Organization aggregate. Backoff rejection,
resource busy, cancellation, database errors before commit, malformed stored hashes,
expired/revoked callers, credential CAS conflicts and issuance failures are not
bad-password failures. A confirmed rollback leaves the prior counters and
credentials intact. If the commit acknowledgement is lost, a verified failure
increment or successful reset may already be durable. Return an operation error
without credentials or a confirmed authentication rejection; do not promise
rollback, compensate counters or automatically repeat the operation. An error
itself is never a new failed guess.

## One Argon2 engine per Identity process

Create one engine in the process composition root and inject it into every
password owner. Its memory and operation permits cover local verification,
unknown-account verification, dummy initialization, transparent rehash,
password-change verification/hash, local-user creation and bootstrap. A
separate pool per service or a direct KDF fallback would exceed the process bound.

Dummy initialization prepares a random 16-byte salt and 32-byte rejection target
in canonical Argon2id encoding with the current, unrounded policy parameters.
It performs no startup KDF: no password needs to match this target. Preparation
still acquires the configured memory weight and one operation slot from the same
engine, and retains cancellation and shutdown join semantics. These conservative
permit counters describe reserved capacity, not actual Argon2 allocation.
Unknown, inactive and missing-credential login attempts still run one full-cost
verification after admission and can never authenticate, even if it matches.
The dummy target is never persisted or rehashed.

Grant memory weight and one operation slot together in FIFO order. Account the
declared memory KiB from the validated stored hash for verification, and from
configured policy for a new hash. Both limits must hold simultaneously. A
request whose weight exceeds the entire budget returns busy immediately.
There are at most 32 queued KDF operations; a full queue returns busy immediately.
Other waiters have at most two seconds, clipped by the original request deadline.
Each verify/rehash acquisition obeys the same original request context.

| Setting                                   | Default                   | Accepted range                                    |
| ----------------------------------------- | ------------------------- | ------------------------------------------------- |
| ANTNEST_IDENTITY_ARGON2_MEMORY_KIB        | 65,536                    | 8–1,048,576 KiB, at least eight times parallelism |
| ANTNEST_IDENTITY_ARGON2_ITERATIONS        | 3                         | 1–10                                              |
| ANTNEST_IDENTITY_ARGON2_PARALLELISM       | 2                         | 1–16                                              |
| ANTNEST_IDENTITY_ARGON2_MEMORY_BUDGET_KIB | 131,072                   | 8–4,194,304 KiB                                   |
| ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT    | min(64,max(2,GOMAXPROCS)) | 1–64                                              |

Reject invalid configuration before serving. The configured new-hash memory
must fit the working budget. Preserve the existing 64 MiB / three-pass / two-lane
hash policy by default. The parameter ceilings are this platform's resource
policy, not a claim that larger Argon2 parameters are invalid in general.
A valid stored cost above the configured working budget returns busy, not
"wrong password"; an operator must provision a sufficient budget to verify it.

[Go's Argon2 IDKey API](https://pkg.go.dev/golang.org/x/crypto/argon2#IDKey)
does not accept a cancellation context. A queued cancellation removes its waiter
without starting work. Once KDF work begins, keep both permits until it actually
returns and is joined; then discard its result if cancelled. A cancelled result
cannot issue a token, change a password or count a failed guess. Shutdown rejects
new work, cancels waiters, joins started work and only then closes the repository.
A closed HTTP listener alone is not proof that hashing stopped.

## Stored parameters and transparent rehash

Parse before allocating KDF memory. Accept only canonical Argon2id version 19
PHC strings with exactly m,t,p in that order, at most 256 encoded bytes, with
positive canonical decimal parameters, a 16-byte salt and 32-byte key in
canonical unpadded standard Base64. Reject extra/duplicate parameters, unknown
algorithms or versions, signs, leading zeroes, whitespace, padding, invalid
trailing bits and trailing data. Bound memory to 1 GiB, passes to ten and
parallelism to sixteen, with memory at least eight times parallelism.

[RFC 9106 section 3.1](https://www.rfc-editor.org/rfc/rfc9106.html#section-3.1)
defines memory in KiB and its lower bound relative to lanes. The KDF rounds its
allocation to lane boundaries; validate the minimum before admission and charge
the declared amount conservatively. Pass the original stored parameters to
IDKey: changing the memory argument to its rounded allocation changes the hash.

NeedsRehash is true for a valid encoding when any of m,t,p differs from the
configured policy. Invalid encoding is an error. After an active local login
verifies the old parameters, hash under the current policy through the same
engine and original context. Acquire the credential's update lock from the
first locking read, avoiding a later share-to-update upgrade deadlock between
two Organizations for the same User.

The expected verified hash CAS, fresh authorization checks, new token and account
counter reset commit together. A CAS conflict rejects without a token or a new
bad-password count; it cannot overwrite a real password rotation. A failed
rehash does not issue a token or reset counters. Transparent rehash preserves
existing browser sessions.

A real password change remains owned by browsersessions. Revalidate the live
Caller before work, after waits and before committing even a bad-password
counter. A missing local credential retains #58's invalid_argument response,
without dummy verification or a failure increment. The local-login dummy rule
does not apply to password changes. Keep the #58 atomic credential change, all-prior-session revocation,
original absolute deadline, replacement token and commit ambiguity rules.
Resource admission cannot grant an expired or revoked Caller extra lifetime.

## Failure wire and consumers

The policy's wire.failure_schema describes an HTTP observation with status,
the flat JSON body, and retry_after containing the single Retry-After
header value. It is not a new application envelope.

| Code                    | HTTP | Fixed message                 | retryable | Retry-After                                                 |
| ----------------------- | ---- | ----------------------------- | --------- | ----------------------------------------------------------- |
| credential_rate_limited | 429  | Too many password attempts    | true      | Remaining longest bucket lock, rounded up to seconds, 1–900 |
| credential_busy         | 503  | Password verification is busy | true      | 1                                                           |

Both owning services publish these exact fields for these new errors.
Identity's active error catalog and status mapping change in its implementation
batch; Gateway's catalog and metadata parsing change in its consumer batch.
Busy covers process capacity and bounded credential-admission lock waits. It
does not disguise corruption, general database failure or invalid authorization.

Gateway accepts exactly one canonical bounded integer-seconds header with the
matching code, status, fixed message and retryable flag. It rejects missing,
duplicate, comma-joined, signed, fractional, date-form or out-of-range values.
Malformed failure metadata becomes 503 identity_unavailable without forwarding
a retry hint. Neither valid failure nor malformed metadata may write or clear
any Cookie; responses use Cache-Control: no-store. No password request is
automatically replayed. Existing Gateway prefilter rejections keep
login_rate_limited.

Admin Console's POST /api/admin/directory/users calls Identity create-local-user,
which also uses the shared hashing engine and can return credential_busy.
Its existing generic response-header projection drops Retry-After. A separate
Console batch must preserve the validated busy status, flat body and single
Retry-After: 1 header on this route, with no-store, no Cookie mutation and no
automatic replay. Malformed busy metadata becomes 503 identity_unavailable
without a retry hint. Limit this handling to the create-user response rather
than forwarding arbitrary upstream headers for every Console route. Console
runtime compatibility remains pending until that owning batch passes.

## Delivery and evidence

Deliver and review these batches in order:

1. This versioned shared policy and contract checks.
2. Identity configuration, strict hash agility and all-entry resource admission,
   including its active busy error publication.
3. Identity PostgreSQL attempt state, transactional verification and rehash.
4. Gateway failure/Retry-After consumer, Cookie rules and operations documentation.
5. Admin Console create-user busy-error consumer and operations documentation.
6. Explicit cross-service integration, including current browser consumers.

Each owning service batch needs unit, contract, component and applicable Docker
evidence before integration. Service runtime behavior is pending at the shared
policy stage. The final issue cannot close on declarations or an in-process fake.

PostgreSQL tests must run two Identity instances against the same database and
hold real concurrency barriers around fifth/sixth attempts, failure commit,
successful reset, unknown identities, current-password checks and concurrent
rehash/rotation. Prove a different successful account cannot erase Organization
failures and a cancelled or stale CCT cannot mutate counters.

The Docker gate submits 200 concurrent authorized Identity login RPCs across
distinct Organization scopes with distinct global Users/credentials, or the
unknown-account dummy path, so a shared User or credential lock cannot serialize
the KDF work. Configure enough database connections to exceed
the two default active 64 MiB hashes plus 32 KDF waiters, so one Organization
lock or a small database pool cannot stand in for the KDF limit. Require actual
KDF pressure/busy receipts with the internal capacity/queue cause distinguished
from database-lock busy, bounded memory/operation high-water marks, no OOM or
restart, and successful ordinary login afterwards. Counting rate-limit
rejections alone does not prove resource admission.

Working memory weight is not process RSS. The default admission deployment
configures a 128 MiB work budget and a 512 MiB process RSS budget: at most
128 MiB measured process baseline plus 256 MiB GC/service headroom. Record those
values before the burst and record the same container ID, PID and process start
time throughout pressure, drain and recovery. Preserve timestamped raw VmRSS,
VmHWM and smaps_rollup Rss readings, including a final reading after recovery;
use the largest kernel high-water value or observed RSS for admission. Missing
measurements or a changed process identity fail the gate. The
[Linux proc documentation](https://docs.kernel.org/filesystems/proc.html)
defines VmHWM as the RSS high-water mark and notes asynchronous RSS accounting;
smaps provides more precise snapshots. These measurements establish evidence
for this deployment and load, not a universal or byte-exact memory bound.
Exceeding the configured RSS bound is a failed gate; do not
replace it with aggregate permit accounting or container survival. Larger
deployment budgets require explicitly sized headroom and independent evidence.

Final HTTPS evidence covers both password routes, known/unknown denial parity,
bounded retry metadata, zero Cookie mutation on failure, old-parameter login
followed by persisted rehash, and unchanged #58 password/session semantics.
Console evidence additionally covers create-user busy metadata, absence of
Cookie changes and successful creation after capacity recovers.
