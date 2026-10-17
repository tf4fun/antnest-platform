# Agent access private ACP migration

This consumer is `make e2e-agent-access`. Same-organization ACP closeout remains
the separate `make e2e-acp-closeout` consumer. Neither profile completes #64.

The existing two organizations, same User with different Memberships, scoped
administrators, Provider credentials and private histories remain independent
oracles. The expected business inventory is 36 administrator denials, eight
Agent denials, twenty foreign Session denials, two Membership revocations, nine
completed Runs and twelve history replays. Automatic Disable evidence covers
two Membership revocations, two Agents affected by global User deactivation,
and one SCIM Membership deletion. Controller restart, explicit Enable, stable
User identity, replacement Membership and retained Runtime sentinel checks stay.

Official SDK calls use the existing private ACP opener and the original login
Principal. The browser credential is delegated by Identity and is not sent to
ACP. Each connection initializes exactly once. Twenty connections must archive
twenty initializations and all sixty-four original business requests: seventeen
new, thirteen prompt, sixteen load/resume, six list, four fork, four close and
four delete. Successful creation and list requests are included even though the
old manual inventory omitted them. Actual parameters, SDK results/errors, raw
responses, Session identities and joined closure are retained privately.

Browser lists use the shipped Bridge bootstrap schema. Membership revocation
is observed on the original Cookie's actual Bridge SSE, followed by an HTTP
prompt denial using that same credential. Silent remote closure, actual
directory mutation and automatic Disable remain distinct evidence. Locally
closing the private SDK is cleanup and does not establish browser revocation.
The closing SSE must retain either the UI access-denied event, a terminal
Gateway Resolve rejection, or the Gateway's winning session-feed event. The
feed event must identify the actual Membership mutation's Identity span and
original organization, User, Membership and Agent; its time must follow the
same Gateway process's mutation request. Generic transport errors alone fail.
Original transport errors, including the precise feed cause wrapper, stay raw.

The original Cookie's one post-close prompt must return 401 or the exact
non-retryable UI 403 `access_denied`, with no Cookie writes. The 403 branch
requires the original admitted Gateway Resolve and UI-to-ACP observation
rejection, with only the ACP readiness `SELECT 1` and no execution. Business
scope comes from the original browser receipt: normalized observation spans
do not independently expose Agent, Session or Principal IDs. All other Session
fault consumers retain their existing status requirements. A 503 still fails.
The same User in the other organization must remain usable. Restoring a
Membership must not enable its Agent; fresh login and explicit Enable precede
history replay.

Reuse existing private request, initialization, Session, no-tool Run and
configuration/list inspectors and collectors. Add only missing access-owned
projections and exact close/delete rejection support. Expected model names come
from each organization's fixture configuration. Confirmed external SDK defects
remain nonblocking and retain their diagnostics. No production collector or
external SDK workaround is part of this migration.

Unit, contract and real HTTP component evidence precedes the profile's actual
Docker acceptance. Preserve original failures and raw reports in
`artifacts/verification/`, with owned process and Docker resource cleanup.
