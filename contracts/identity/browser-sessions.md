# Browser session lifecycle

This is the shared contract for Identity revision 15 and Gateway session
revision 19, tracked by [#58](https://github.com/tf4fun/antnest-platform/issues/58).
It covers existing local-password and OIDC browser sessions. SCIM credentials
retain their existing lifecycle; this change does not introduce API-token
creation or management.

The JSON schemas in [identity-contract.json](identity-contract.json) and the
[Gateway session contract](../edge-gateway/session-contract.json) define wire
shapes. Authorization declarations on the Identity methods describe the
required final policy. Active [caller grants](callers.json) must be changed
with their owning implementation, never ahead of a route. The rollout is:

1. Shared schemas, authorization and lifecycle contract.
2. Identity producer, migration, unit/RPC and PostgreSQL admission.
3. Gateway account routes, cookie handling, stream guards and revocation feed.
4. Console account and organization-admin session controls.
5. Agent UI account controls, session generations and activity reporting.
6. Scripted consumers and an explicit two-browser HTTPS integration batch.

The shared contract and Identity producer have passed their local admission
checks. Gateway, Console, Agent UI, scripted consumers and the final HTTPS
integration remain pending. Completing the Identity producer alone does not
complete the browser workflow.

## Deadlines and activity

Identity stores an absolute `expires_at`, mutable `idle_expires_at`, and actual
`last_used_at` for every browser credential. Both deadlines must be strictly
later than the authority's current time at admission. Equality is expired.
User, Organization and Membership must also be active, and the token must not
be revoked. Resolving a raw token, validating a CCT and replaying a completed
OIDC callback apply the same checks.

| Setting                                 | Default | Rule                                                                                                        |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `ANTNEST_IDENTITY_SESSION_IDLE_TTL`     | `30m`   | Positive duration; inactivity deadline.                                                                     |
| `ANTNEST_IDENTITY_SESSION_ABSOLUTE_TTL` | `12h`   | Positive duration; maximum credential lifetime.                                                             |
| `ANTNEST_IDENTITY_TOKEN_TTL`            | unset   | Absolute-TTL alias for one release. If both absolute settings are explicit, unequal durations fail startup. |

Issuance records `last_used_at = issued_at` and
`idle_expires_at = min(issued_at + idle TTL, expires_at)`. Idle TTL may exceed
absolute TTL; it is clipped, not rejected. Only an explicit
`POST /api/session/activity`, admitted by Origin and session-bound CSRF,
extends idle expiry. Identity locks the token, reads fresh time after waiting,
and revalidates its live authority before atomically recording activity and
`min(now + idle TTL, expires_at)`. A blocked activity request cannot revive an
expired token. There is no five-minute sampling window.

Ordinary finite business GET/POST requests, SSR, token resolution, CCT
issuance, background polling, reconnects and incoming stream output do not
record activity. CCT expiry is no later than its normal lifetime or the live
browser session's remaining authority. Browser responses expose absolute and
idle deadlines plus `activity_interval_ms`, an integer computed as
`max(1, min(30000, floor(idle TTL in milliseconds / 3)))`. The interval is a
client scheduling hint, never evidence of authentication.

## Rotation and browser cookies

Every login issues a fresh opaque credential. A password change is one
Identity transaction: revalidate the caller's current signed session and the
expected password hash; update the credential; revoke every prior browser
session for this User across Organizations; and insert a fresh caller session.
The replacement inherits the old absolute deadline and starts a new idle
window clipped to that deadline. Both the old caller token and other tokens
fail resolution after commit. OIDC-only accounts expose session controls even
when `local_password_available` is false.

A membership or system-role change revokes the affected sessions. The affected
user logs in again under the new role; no target-user credential is returned
to an administrator. Revoking a browser session does not disable an Agent or
change ownership.

Gateway writes browser session/CSRF cookies only on explicit local login,
OIDC completion, successful password rotation and logout. Cookie `Expires`
always uses the absolute deadline. Activity returns deadlines without rewriting
cookies. Outside these explicit cookie-writing transitions, successful
requests, authentication failures and rejected SSR requests never replace or
clear cookies: a late response for an old session
must not overwrite cookies belonging to a new login. Existing Secure, HttpOnly,
SameSite and `__Host-` rules in [session-security.md](../edge-gateway/session-security.md)
continue to apply.

Explicit logout keeps its separate outcome matrix after Origin admission:
absent session returns 204 and clears cookies without calling Identity; a
successful revocation returns 204 and clears them; malformed, invalid or inactive
session returns 401 and clears them. Identity dependency failure returns 503
and preserves cookies. Rejected Origin or CSRF returns 403 and preserves them.
An invalid session can clear browser state without promising persistent token
revocation.

A lost or ambiguous password-change response requires login with the new
password. Identity does not retain a replayable raw token or grant a grace
period to the old SID. Request IDs are audit correlation, not credential
recovery capabilities. Concurrent explicit cookie-writing transitions may
require a fresh login; a revoked credential must never regain authority.

## Inventory and revocation

The public session `id` is an independently generated opaque reference. It is
neither the private token row ID/CCT `sid` nor a value derived from a raw token
or token hash. Public metadata is limited to Organization ID/name/slug,
creation and last activity times, both deadlines, a bounded user-agent hint
(at most 256 characters), and `current`. No raw credential, hash, CCT or private
SID appears in browser JSON. The hint is display data, not identity proof.
Gateway obtains it from the login request's User-Agent header, truncates it to
256 Unicode characters and sends the optional `user_agent_hint` only in its
internal local-login or OIDC-start request. OIDC persists that hint with the
login state until issuance; a password replacement inherits the caller's hint.
Missing hints become an empty string. The UI renders the hint as text, never
markup; it grants no authorization and does not identify a trusted device.

`list_user_sessions` requires explicit `scope`, `user_id`, actor echo and a
limit from 1 to 100. Optional `after_id` and `next_after_id` are public references;
ordering is ascending reference order. Missing, empty, malformed or unknown
query fields reject. Only live, unrevoked browser sessions are listed.

- `self`: target User must equal signed CCT `sub`; their sessions may span
  Organizations. Current session is derived exclusively from the verified SID.
- `organization`: caller must be an organization administrator (or authorized
  system administrator), and the target must have a Membership in the caller's
  current Organization. Results and revocations remain limited to that
  Organization even for a system administrator.

`revoke_user_sessions` accepts `mode: others | all` for `self`. Organization
scope permits `all` only. There is no caller-controlled `except_token_id`,
`current_token_id`, Organization override or raw credential. The response
contains only `revoked_count` and `current_revoked`. Repeating an authorized
revocation has no further effect; a request whose own CCT is already revoked
is not authorized by its old request ID.

## Routes and workload authorization

Gateway selects a new `session` CCT profile whose audience is exactly
`["identity-service"]`. It cannot accept `agent_id`; the three existing
`console`, `workspace` and `acp` audience arrays remain unchanged. Bodies echo
an actor for auditing but never supply authority. Identity rechecks the signed
SID and live facts before effects, including after lock waits.

| Identity RPC               | Immediate workload | Caller context                        |
| -------------------------- | ------------------ | ------------------------------------- |
| `get-current-account`      | Gateway, Console   | Required live CCT.                    |
| `change-local-password`    | Gateway            | Required live CCT.                    |
| `touch-browser-session`    | Gateway            | Required live CCT; current SID only.  |
| `list-user-sessions`       | Gateway, Console   | Required live CCT and explicit scope. |
| `revoke-user-sessions`     | Gateway, Console   | Required live CCT and explicit scope. |
| `list-session-revocations` | Gateway            | Workload operation; no browser CCT.   |

Gateway owns these browser routes, all with `Cache-Control: no-store`:

| Route                               | Request                                        | Response                                                                   |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/session/account`          | No query/body.                                 | Current account metadata.                                                  |
| `POST /api/session/password`        | Current and new password.                      | Public principal/deadlines/hint; new credential only in protected cookies. |
| `POST /api/session/activity`        | Empty object.                                  | Both deadlines and activity interval.                                      |
| `GET /api/session/sessions`         | `limit`, optional `after_id`; self scope only. | Public sessions and optional next cursor.                                  |
| `POST /api/session/sessions/revoke` | `mode` is `others` or `all`; self scope only.  | Counts/current flag.                                                       |

All mutations require the existing Origin and CSRF admission. The Gateway
constructs actor, scope, target and correlation fields from verified state.
Console keeps organization-admin inventory/revocation actions, with the same
Identity authority checks, but retires its old password mutation and its
credential-only path. Invalid current password is a business error and does
not sign out an otherwise valid browser session.

## Session revocation feed

`list_session_revocations` is separate from the
[principal offboarding feed](principal-revocations.md). Its private events
contain sequence, token ID, User ID, Organization ID, occurrence time, reason
and optional traceparent. Reasons are `session_revoked`, `password_changed`,
`role_changed`, `user_deactivated`, `membership_deactivated` and
`membership_deleted`. The principal feed's schema, reasons and Controller
consumers remain unchanged. Session-only events do not trigger offboarding.

The feed uses an exclusive `after_sequence` cursor, limit 1–500, and ascending
committed sequence order. An empty page preserves the cursor. Sequence gaps
are allowed, but committed events cannot be skipped. Producers acquire the
feed writer lock before allocating sequence numbers, after all business-row
locks. Transactions publishing both feeds always lock/publish principal first,
session second. Session event rows do not introduce parent-row foreign-key
locks that reverse this order. Rollback publishes no event.

## Live streams and process lifecycle

Gateway binds each authenticated long-lived response to the original private
SID and User/Organization/Membership. Admin streams also retain their required
current roles. Non-touch live Identity checks enforce these facts even when
neither side sends frames. The maximum stale-output bound `R` defaults to
30 seconds. Polling interval is `min(R / 3, activity_interval_ms)`; each Identity
read times out within that interval. A hard deadline anchored to the start of
that check includes slow successful responses and socket-close grace, which
is at most `min(1 second, R / 3)`.

Idle expiry is a mutable observation that schedules a fresh live check; an old
snapshot is not a permanent close timer, because another replica may record
real user activity. Absolute expiry remains a hard cap. A direct ACP WebSocket
also retains its original handshake CCT expiry as a hard cap and must reconnect
afterward; Gateway does not silently refresh that credential. Initial session
resolution times out within `R / 3` while its activity hint is unknown; after a
reply, its elapsed time must also fit `min(R / 3, activity_interval_ms)`. The
initial stale deadline remains anchored to that RPC's start. A late reply or
elapsed hard deadline rejects before upstream admission; the guard exists
before an upstream stream starts.

Revocation, authority changes, stale/failed checks and hard expiry stop output
and close the stream within the bound. Cancellation interrupts a blocked
browser write as well as upstream reads. Both WebSocket directions share one
close deadline. Once cancelled, a later per-frame write deadline cannot undo
the cancellation. Workers and cancellation callbacks are joined; write
deadlines clear only after the handler is finished. Already admitted ACP Runs
keep ACP's documented cancellation and disconnect semantics.

One process-owned Gateway poller reads the private feed and cancels active
streams registered by SID. Constructors start no goroutines. Main starts the
poller with its owned context, cancels and joins it before transport teardown.
The cursor starts at zero after restart, pages remain bounded, and no unbounded
event cache is kept. Feed delays, backlog, outage or register/poll races do not
weaken the independent live-check bound; the feed accelerates closure.

## Browser request generations and activity reporting

Console and Agent UI report actual input, pointer, keyboard, wheel or touch
activity with a leading call and a bounded dirty trailing call. Programmatic
scroll, focus, visibility, background polling and stream output do not count.
The throttle anchors deadlines at dispatch start, permits one in-flight call,
and times that call out within the current activity interval. Input during a
pending call marks it dirty; due trailing activity dispatches after completion
or timeout. Without new/dirty input there is no automatic retry. Unmount and
session replacement remove listeners, cancel timers and abort requests.

Each browser auth transition advances a local generation. Requests capture the
generation and CSRF delivery hint before dispatch, and recheck them before
applying either successful data or a 401 logout. A stale 200 cannot replace new
state and a stale 401 cannot sign out a newer session. The hint is not an
authentication credential; a missing/changed hint requires fresh session
validation. Explicit mutations are never automatically replayed. Dependency
503 preserves the current session. Cross-tab notifications may accelerate
invalidation but carry no raw token, private SID or CCT.

Account controls must be reachable from Console and Agent UI's sidebar,
Agent chooser and no-Agent screen. Same-Agent login replacement recreates the
Workspace controller under the new session generation.

## Migration and transaction order

The migration marks existing tokens as browser sessions, assigns each an
independent public reference once, fills a missing activity timestamp from
issuance, and initializes idle expiry from absolute expiry. Before opening its
listener, Identity clamps each unrevoked browser row to
`min(stored idle expiry, absolute expiry, last activity + configured idle TTL)`.
Initialization failure prevents listening. A larger configured TTL cannot
revive or extend an existing deadline; a smaller value applies at startup.
Do not regenerate public references, reset revocation or change absolute expiry.
This initialization tightens expiry; it does not emit an offboarding event.

Every bulk token operation and startup clamp uses the same deterministic token
row order so concurrently running upgraded replicas cannot deadlock by taking
the same set in different orders. Password rotation locks target User, current
Organization/Membership and ordered User tokens, then rechecks the expected
password and current SID with fresh time. Bulk revocation locks target User and
ordered tokens, then observes fresh actor CCT/facts without acquiring a second
actor User or extra parent locks. That fresh authorization observation is the
admission point; a previously revoked actor cannot authorize effects after a
lock wait.

Existing flows that share these rows must keep explicit User → Organization →
Membership ordering: OIDC discovers IDs first and revalidates mappings under
ordered locks; SCIM replacement locks User before Membership; role updates
acquire the Organization's required update lock initially, without a
SHARE-to-UPDATE upgrade. Preserve other lock scopes unless deterministic
PostgreSQL overlap tests demonstrate another cycle. No mixed old/new Identity
replica compatibility is claimed for this schema and behavior change.

## Required evidence

Owning-service tests cover both deadlines, exact-boundary rejection, activity
without revival, stable public references, strict authorization and secret
projection. PostgreSQL gates exercise password rotation against local/OIDC
issuance, role updates, SCIM replacement, mutual administrator revocation,
post-wait actor revocation, blocked activity across idle expiry, ordered feed
commits, and startup clamping against rotation/bulk revoke. Lost-response
password retries must fail with the old SID, without replaying a secret.

Gateway component tests use silent upstream streams and blocked downstream
writes, slow successful Identity checks, feed failure and renewed idle expiry
from another replica. Browser components cover leading/trailing activity,
continuous input, background inactivity, StrictMode/unmount, dependency 503,
and stale successful/401 responses. Final Docker acceptance uses two real
browser contexts and a 5-second idle policy: password change invalidates the
other browser and its streams, an inactive browser expires, and genuine input
renews idle without extending absolute lifetime. Verify owned-resource cleanup.
