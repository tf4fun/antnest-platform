# Identity / access acceptance migration

This migration is delivered in the three owning batches in the
[fixture contract](../tests/e2e/identity-closeout/migration-contract.md).
HTTP Identity evidence does not accept ACP recovery or Agent offboarding.
Production service behavior, clocks and export intervals are unchanged.

## Identity HTTP / SCIM / OIDC

The independent `make e2e-identity-core` and `make e2e-identity-access`
profiles now use explicit synthetic configuration, an immutable Runtime image,
loopback ingress, private Temporal ports, isolated allocator ranges and bounded
cleanup. They do not import the retained development `.env`.

The September 17 disposable runs `antnest-stage3-e2e-20598` and
`antnest-stage3-e2e-21216` passed:

- Nine local/session/SCIM groups, 78 Gateway requests and three complete Trace
  checks: cookies, CSRF, logout, membership versus global user revocation,
  SCIM Users/Groups discovery, CRUD, projection, reprovisioning and credentials.
- Seven OIDC groups and seven complete Trace checks: verified HTTPS,
  account convergence, callback/browser binding, nonce and subject validation,
  configuration/secret rotation, disabled provider and UserInfo fallback.
  The IdP observed four discoveries, 12 token grants, 12 JWKS requests and
  one UserInfo request. Correlated service logs and secret canaries passed.
- Four organization/access groups and two complete Trace checks: same-email
  isolation, foreign SCIM references, password and token revocation scope.
- Actual Identity outage/recovery and naturally expired five-second tokens,
  including cookie retention during outage and one complete expiry Trace.

OIDC HTTP spans are bound to the actual method/path and `traceparent` received
by the HTTPS fixture. Exported spans retain the current host/scheme/port contract;
the verifier no longer requires a retired full-URL attribute. Identity SQL
evidence counts only SQL owned by Identity: Controller background publication
can inherit the Identity causal parent without becoming Identity database work.
Negative fixtures still reject missing SQL, broken ancestry and private SQL data.

All 13 HTTP Trace topologies passed. Strict status remains failed: one OIDC
registration Trace has six Jaeger warning entries; the password-change Trace
has eight entries, including missing-parent clock-adjustment diagnostics.
The real expiry rejection has three error spans. Raw traces are archived
unchanged; neither warnings nor error spans are suppressed. Both profiles
therefore retain exit code 2 after all independent business checks run.

Private evidence is under `artifacts/verification/identity-http/<project>/`; the coordinated
logs and fixture-test logs are in `artifacts/verification/identity-migration-20260917/`.
Failed earlier deployments exposed the obsolete OIDC URL and cross-service SQL
assumptions; their results are not counted as passing acceptance.

## ACP browser session / fault consumer

The isolated `make e2e-acp-session` profile now uses current Provider/Model
setup, the returned Template revision and an immutable Runtime image. ACP-owned
read-only snapshots replace removed Controller admission columns: a completed
Run must retain its request and execution snapshot, finish with a quiescent
executor and settled Tool effect, and contain exactly one completed Runtime
Tool with stopping evidence. The existing exact Bash exit/output/ordered-append
oracle remains.

Final run `antnest-stage3-e2e-28715` passed both SDK versions: six rejected
prompts across logout, Identity outage and natural expiry; two empty-Session
logout recoveries; two already accepted Runs completing after logout/disconnect;
two fresh authenticated Runs; eight actual Provider requests and four exact
Bash effects. Replays created no execution. The ordinary empty-Session cases
now run in this independent profile instead of depending on the legacy parent.

Eight denied message traces and 18 setup/replay/execution traces passed
topology/privacy. The strict result remains failed: deliberate rejections retain
22 error spans; 12 of the 26 Trace checks fail strict evaluation, with 213 raw
warning entries. Raw warnings and errors remain unchanged. Evidence is in
`artifacts/verification/identity-session/antnest-stage3-e2e-28715/`.

## Agent access / offboarding integration

Final `make e2e-agent-access` run `antnest-stage3-e2e-30632` passed both SDK
versions, with 36 administrator denials, eight unauthorized Agent requests,
20 foreign Session commands, two scoped membership revocations and nine exact
Provider executions. Twelve private-history replays preserved their ordered
content and produced no execution. Identical empty MCP configuration now leaves
all ACP-owned rows, revisions, pointers and timestamps unchanged.

The current authorization boundary is ACP after an authenticated Gateway
connection. Cross-organization Sessions return the exact organization access
error, without history or extra error data. Restored membership alone does not
make a revoked Agent visible or executable: explicit Enable is required.
Current bootstrap metadata and the ACP workspace state are checked separately.
Each denied management resource has a corresponding successful owning-scope
read, including current Provider/Model and returned Template revisions.

Five automatic Disable checks cover both protocol membership cases, global
User revocation across two organizations after a Controller restart, and SCIM
Membership deletion. An unaffected second owner and a same-User peer in another
organization remain usable. Reprovisioning preserves User identity while
creating a new Membership; explicit Enable restores old history and allows a
fresh Run. Runtime inspection and real MCP sentinel reads independently prove
execution absence and retained workspace contents.

Every Disable binds the actual Gateway/Identity source and revocation sequence
to its Agent schedule, exact Temporal workflow and five activities. Each
activity requires committed owned SQL. Drain checks matching ACP publication
and settlement acknowledgements; network fencing and Runtime Disable require
the causal mutating RPC. Global revocation shares one source Trace between two
Agents, so activity ownership is scoped to the matching workflow.

All 58 scoped Trace topology/privacy checks passed over 57 archived traces:
53 access/request/execution checks and five Disable checks. The strict result
remains failed on 44 checks, retaining 70 rejection-related error spans and
all warning entries. A denied Gateway message is distinguished from previous
successful or ACP-rejected prompts on that same connection by the Gateway
admission failure, then validated for its exact connection, Identity attempt,
SQL ownership and absence of execution. Evidence is in
`artifacts/verification/identity-agent/antnest-stage3-e2e-30632/`.

## Verification and remaining boundary

- 810 unit, contract and component checks passed serially across Identity,
  shared observability, base Stage 3, ACP commands/closeout and lifecycle fixtures.
- Four independent final Docker profiles passed business and topology checks:
  Identity core, HTTP access, ACP sessions and Agent access. They total 97 scoped
  Trace checks. Strict warning/error gates still return nonzero; this is scoped
  business/topology acceptance, not a claim that strict observability is green.
- A prior Agent rerun encountered an HTTP transport failure during a denied
  Enable probe. It remains a failed run; the final full rerun did not reproduce
  it. No product fix is claimed for that transport failure.
- One retry was started before its predecessor finished cleanup, then terminated
  during setup and excluded from acceptance. The coordinator removed the failed
  predecessor's remaining, explicitly labelled empty networks/test volumes and
  checked cleanup before restoring serial verification. This interruption is
  driver cleanup evidence, not a functional SIGKILL scenario.
- Final cleanup verified all 18 temporary projects have no owned containers,
  networks or volumes left, and no verification child processes remain. The
  retained development environment's 12 containers kept their exact IDs, image
  IDs and health states. Resource checks are recorded in the private
  `cleanup.json` beside the coordinated logs. No retained databases, Runtime
  workspace, rollback images or backups are deleted.

The migrated fixtures no longer depend on Model revision creation, Controller
admission completion or the old lifecycle worker Trace oracle. Historical
retained/extended parent branches and shared helpers still used elsewhere remain
for their separate migration and asset-retirement review; no directory is
retired wholesale in this batch.
