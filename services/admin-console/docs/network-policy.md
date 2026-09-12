# Network Policy Management

## Service Boundary

Console is a thin management client of Agent Controller control contract 16.
Only system or organization administrators may use these routes. Edge owns
external authentication and CSRF enforcement; the BFF derives organization and
actor from trusted headers, never from browser JSON or query parameters.
Controller enforces Agent ownership; Egress alone persists/enforces policies.
No service database, lifecycle mutation or Runtime generation is added here.

The [BFF contract](../../../contracts/admin-console/README.md) revision 36 adds
GET/PUT `/api/admin/agents/{agent_id}/network-policy`. The browser selects public
IPv4 access on/off; deployment/control addresses remain protected by Egress.
Only allow/deny built-in revision 1 is selected by this UI. Reads use the
Controller's exact policy spec, not a policy ID/name heuristic.

## Browser States

Network policy is an independently loaded Agent-detail section. Failure must
not erase the Agent, its configuration or lifecycle history. Deleted/deleting
Agents have no network control. Disabled Agents can save policy but do not
resume traffic; lifecycle state/Runtime changes refresh the attachment read.
No periodic polling is introduced.

The switch reflects the last confirmed desired policy, never an optimistic
network-health assertion. A write disables duplicate actions until a conclusive
response. Successful writes announce that the policy was saved; a closed
attachment remains explicitly closed. The page does not certify packet flow.

Before PUT the browser retains its action, original expected version and request
key in local storage keyed by organization, administrator, Agent and request ID.
Each unresolved request has its own entry, so concurrent tabs cannot overwrite
each other's recovery records. Closing a tab does not discard the request.
PUT carries `X-Antnest-Expected-Principal`, the URI-encoded JSON pair of
organization/user IDs. The BFF compares it with the authenticated principal;
it is a precondition, never an identity assertion. A stale-account request is
rejected before dispatch, retaining its original recovery entry.
Storage failure prevents dispatch rather than creating an unrecoverable hidden
intent. No credentials are persisted. Read-only entry without a provided account
scope cannot dispatch policy mutations.

- Network failure, 408/429, 5xx or malformed success leaves the exact request
  pending. Explicit retry resends the same tuple and key, without implicit GET.
- GET and reconnect refresh only the desired/attachment snapshot. They never
  clear an uncertain write, even when the fetched policy matches its target.
- A reopened SSE connection triggers network refresh independently of the Agent
  recovery GET; an offline failure of that GET cannot suppress later recovery.
- A version-conflict 409 clears the failed intent but blocks another write until a fresh read;
  the administrator must then make a new explicit selection. No silent rebase.
- Account changes require reloading the page and do not discard pending work.
- Other definitive 4xx failures end the intent and remain visible. Authentication
  failure follows the existing session-expiry flow. Pending entries cannot be
  read or replayed by a different account scope.
- Remount/reload restores an uncertain intent before enabling the switch. Old
  component responses cannot update another Agent or newly logged-in account.
- Lifecycle/reconnect invalidations during a write are coalesced into one
  independent read after it settles. That read cannot acknowledge the write.
- Each pending request retains a retry affordance independently of the previous
  command's failure message. Clearing one conflict never hides another request.

## Sequence

```mermaid
sequenceDiagram
    participant UI as Agent detail
    participant BFF as Admin Console
    participant Controller as Agent Controller
    UI->>BFF: GET network policy
    BFF->>BFF: Administrator check, trusted scope
    BFF->>Controller: GET policy (organization, Agent)
    Controller-->>BFF: Exact desired policy + independent attachment
    BFF-->>UI: Allowlisted display projection
    UI->>UI: Persist scoped intent before send
    UI->>BFF: PUT action + original version + request key
    BFF->>Controller: One assignment CAS with derived actor and policy ref
    Controller-->>BFF: Acknowledgement or bounded failure
    BFF-->>UI: Confirmed assignment or explicit error
    UI->>UI: Clear on conclusive result; retain uncertain intent for retry
```

Service verification covers BFF principal/scope, projection, request identity,
error classification; browser component tests cover switch state, CAS conflict,
response loss/reload, independent failures and late responses. Gateway-rooted
Jaeger and real TUN evidence belong to the subsequent C3 deployed integration,
not to this Console-only delivery batch.
