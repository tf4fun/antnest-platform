# F10 Deployed Session Cost

Status: deployed integration passed on 2026-09-10. This profile uses current images,
a disposable Docker stack with one PostgreSQL instance and separate service
databases, and a deterministic local model. It spends no external Provider credit.

Run `make test-cost-fixtures`, build service images serially, then
`make e2e-session-cost`. Existing development stacks are not replaced. The wrapper
owns test containers, Runtime resources and volumes and removes them on exit.

## Acceptance

1. Gateway/Console create priced and unpriced models, immutable revisions,
   templates and Agents. Model prices and credentials remain Controller-owned;
   ordinary users cannot edit them. Historical prices must not change after a
   revision is published.
2. Official ACP v1 WebSocket, v2 WebSocket and v1 Streamable HTTP clients verify
   every raw update against the SDK schemas, before SDK field sanitization.
   Test returned cost precedence, explicit zero on a priced model, zero rates,
   missing rates, ordinary and cache estimates (including missing cache rates),
   Agent default revision pins and a Session selection made before publishing
   the next price revision taking the new rates on Run admission. Hold an actual
   admitted model request, publish another revision, then release it: that Run
   keeps its admitted rates, while the next uses the new revision.
3. New Sessions do not inherit cost. Known cost survives unpriced calls; replay
   is cumulative replacement, not addition. Reconnect/load and fork must not call
   the model. Forks inherit their baseline but evolve independently. Foreign
   Agent and User requests must not disclose usage. A separate authorized owner
   keeps an active connection with a distinct cost baseline while these run;
   its notifications must remain unchanged.
4. Close clients, restart the disposable ACP service once, wait for health and
   restore all three histories per profile. The first post-restart requests use
   the saved parent/fork model choices without reselecting them. Repeated loads
   verify returned model options as well as accounting, without replay-induced
   model calls or double counts.
5. Jaeger evidence starts at Gateway, includes Controller admission/finalization,
   ACP persistence, Runtime context preparation and the exact model attempts.
   Pricing changes also retain Gateway/Console/Controller ancestry. No Tool
   execution, secrets, private receipts or catalog rates enter the ACP wire;
   inspect complete raw frames, including response and notification metadata.

Only compact final metrics are kept. Pure mutation tests must reject wrong
amounts, missing known cost, fake zero, leaked receipts and mismatched model
attempt evidence. Create/select/fork notifications are checked before advancing
the retained log cursor. A failed container inspection cannot count a still-live
client as passed; restart health and process completion both have bounded waits.
Browser presentation is covered separately by Agent UI tests
and preview acceptance; this profile proves deployed protocol/business behavior.

The compact final metrics and limits are maintained in
[protocol conformance](../../services/agent-acp-service/docs/protocol-conformance.md#session-cost-f10-deployed-integration-2026-09-10).
