# Stage2 private ACP consumer contract

This batch migrates the Stage2 execution consumer after removal of the unused
Gateway workspace routes in #64. It preserves the business scope of
`stage2-boundary-flow.mjs`. Local harness tests do not complete this batch;
`make e2e-stage2` must pass against fresh candidate images, including its final
Temporal and ACP PostgreSQL checks. Development and capacity/cancellation remain
separate pending consumers, followed by the full integration batch.

## Access and protocol

Management and authenticated audit continue through their current Gateway and
Console routes. Execution uses the owner's original Gateway login session:
Identity resolves the workspace context for that Agent, and the private ACP
request supplies the actual `agent-ui-acp` workload grant. No execution request
uses fabricated identity headers or the retired public ACP/state routes.

The main client retains ACP v2 WebSocket ACKs and subsequent notifications.
Each request is identified by its actual wire ID, method, connection and input
Session. A held Prompt and a rejected Prompt for another Session must remain
independently attributable, even if their dispatch overlaps. The Disable/Enable
scenario retains a v1 HTTP client and its original POST, GET and DELETE receipts.
HTTP authorization is resolved from the original user session for each request.

Private state and watch use the complete current state DTO and original HTTP
receipts. Cold restart preserves the exact 503 response. Before revocation, a
watch is established with the owner's authority; it must observe sanitized
denial and a remote end. The login receipt fingerprints its original opaque
session Cookie independently of the watch observer; their digests must match.
The already established ACP connection rejects the
Prompt, and a new connection is refused by Identity after revocation.

## Business inventory

| Scenario                                         | Runs | Model requests | Runtime writes |
| ------------------------------------------------ | ---: | -------------: | -------------: |
| Create                                           |    0 |              0 |              0 |
| Same-Run credential rotation                     |    1 |              2 |              1 |
| Execution while Controller is offline            |    2 |              4 |              2 |
| Rebuild while execution is active                |    1 |              2 |              1 |
| Disable, historical v1 HTTP access, Enable       |    1 |              2 |              1 |
| ACP SIGKILL and explicit post-recovery execution |    2 |              3 |              1 |
| Identity revocation                              |    0 |              0 |              0 |
| Delete and retained execution audit              |    0 |              0 |              0 |
| Authenticated audit consumer                     |    0 |              0 |              0 |
| Total                                            |    7 |             13 |              6 |

Six Runs complete and one is interrupted by the unique SIGKILL. The interrupted
Run must become `service_restarted_during_run` and must never replay. The explicit
post-recovery Prompt owns an independently observed Run trace and is included
among all six completed Run traces; excluding the crash scenario trace must not
silently exclude that recovery Run.

Create and Rebuild retain their two original management traces. The five
explicit Temporal histories are Create, Rebuild, Disable, Enable and Delete;
automatic Disable is checked separately. The audit consumer retains all seven
Runs, its 48 successful HTTP reads (6 list, 14 detail, 28 events), and its existing
authentication, foreign-organization, cursor and outage rejection cases.
PostgreSQL dump, raw service logs, decoded Temporal histories and three idle
samples for both services remain part of the evidence.

## Trace and resource ownership

Stage2 intentionally enables RPC content capture. Identity's existing enabled
capture contract includes user credentials in RPC parameters. Only an original
Stage2 login credential in the exact Identity Resolve `access_token` request
field is admitted; raw traces remain unchanged. Session credentials anywhere
else, issued contexts, workload credentials and the model secrets still fail.
Capture-disabled acceptance from another consumer must not replace this policy.
Private execution traces prove the actual exported CLIENT, ACP SERVER, original
request, Agent, Session and Run relationship. Management and audit retain their
Gateway ancestry. HTTP request captures include the receiving HTTP SERVER's
trace context injected by `TracedAcpHttpServer` before dispatch. The checker
binds that metadata to the actual receiver and compares all remaining fields
with the original send receipt; neither trace nor receipt is rewritten.
An empty HTTP 202 acknowledgement may retain the SDK's original `cancelled`
body outcome. It must agree with the exported CLIENT, have zero body bytes,
and accompany a successful original RPC response and joined connection.
Raw data and known external SDK diagnostics are preserved;
confirmed external SDK issues do not block internal-service acceptance.

Every connection, watch, exporter, request and child process is joined on both
success and failure. Business, archive and cleanup failures retain their original
causes. Evidence belongs in ignored `artifacts/verification/`, never `.cache/`.
