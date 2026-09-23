# Deployed Session Cost Acceptance

2026-09-17: 52 model requests, one real ACP restart and 156 Trace topology/privacy
checks passed. Strict Trace remains failed on timing warnings; see the linked
revalidation report for exact scope and cleanup evidence.

The [2026-09-22 follow-up](../../../docs/timeout-failure-followup-20260922.md)
records shared cleanup diagnostics and targeted regression. The observer
connection still closes before Agent deletion, and an earlier business failure
is preserved if cleanup also fails.

Run `make test-cost-fixtures`, then `make e2e-session-cost` with the locally
built service images. The profile uses an independent disposable Docker project
and a deterministic model; it spends no external Provider credit. Temporal has
no host port, dynamic addresses avoid the fixed egress/Jaeger addresses, RPC
content capture is disabled, and the project does not read the developer `.env`.

## Current contract

- Provider Connections own the endpoint and credential. Models expose their
  current prices under a stable ID; edits use `expected_version`. Templates use
  that stable ID and Agents use the returned Template revision. The removed
  Model history route is not execution evidence.
- ACP selects current rates for each Run, including `agent_default`. A selected
  Model also uses prices published after selection. A held, actual Provider
  request keeps its execution-time rates when the Model is edited; the next
  Run uses the updated rates. Wait for ACP's public configuration fingerprint
  to change before testing the next execution.
- Official SDK v1 WebSocket, v2 WebSocket and v1 Streamable HTTP clients check
  raw decoded frames before SDK field sanitization. Provider-reported cost
  takes precedence, explicit zero remains zero, unknown differs from free,
  cache estimates use subset token counts, and missing cache rates fall back
  to the input rate. Private measurements, receipts and rates never enter ACP.
- Replay replaces cumulative usage; it must not call the model or add cost.
  New Sessions start without inherited usage. Forks inherit their baseline
  and then evolve independently. Parent/fork model choices and totals survive
  an actual restart of the disposable ACP container, including repeated loads.
  Container health is followed by public execution readiness and confirmation
  of the pre-restart configuration fingerprint; only startup HTTP 503 is retried.
- Foreign users receive exact ACP `access_denied`; cross-Agent Session requests
  receive `session_access_denied`, without updates or execution. A separate
  authorized observer retains its USD 0.77 history. Current catalog publication
  can refresh that observer's own config options and unchanged v1 mode; any
  other notification, foreign Session or changed choice fails isolation.
- Every Session request uses its actual SDK JSON-RPC ID. WebSocket traces must
  link to the connection; HTTP traces use the Gateway response Trace ID. Each
  model attempt belongs to an ACP-owned Run with current Runtime preparation,
  actual Provider HTTP identity, committed reply persistence and durable Run
  closure. No Tool execution or Controller admission/finalization is expected.
  Pricing commands independently require Gateway/Console/Controller ancestry
  and a committed current Model SQL write.

The wrapper bounds requests, container inspection, restart health and cleanup.
Strict Jaeger timing/order failures retain a nonzero exit even when business,
privacy and ancestry checks pass. Detailed migration evidence is recorded in
[Session cost revalidation](../../../docs/session-cost-revalidation.md).
