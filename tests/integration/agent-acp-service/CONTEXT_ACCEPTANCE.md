# Context Management Acceptance

The user-approved #51 acceptance adjustment replaces the Docker-specific
200-turn stage-model scenario with real-protocol PostgreSQL integration.
This is a `component` suite, not a Docker/system or release-capability result.
The original mock-model regression remains in the same test file.

## Execution Path

`acp-context-compaction.postgres.test.ts` exercises:

1. The official ACP v1 HTTP client and the actual ACP HTTP server.
2. Production context building, model preparation, request budgeting and
   the `OpenAICompatibleModel` encoder, pinned HTTP transport and SSE decoder.
3. An owned loopback Provider HTTP server checking the URL, credential header,
   model selection, streaming/usage options and original task on every
   foreground request, including the failed request and retry.
4. Real PostgreSQL Run, context-checkpoint and model-attempt repositories.

The new cases do not stub `model.complete`, `fetch`, `Response`, overflow
classification or the SQL repositories. The default model mock must remain
unused. Runtime information, Tool catalog, caller authentication and execution
configuration remain controlled application fixtures: this does not deploy
Controller, Gateway, Runtime or Console.

## Blocking Assertions

- All 200 Chinese turns finish with `end_turn`; all 200 durable Runs are
  completed, quiescent and free of an error class.
- A physical HTTP 400 `context_length_exceeded` at turn 81 causes exactly one
  extra foreground request, not a generic retry-policy retry.
- Real compactor HTTP/SSE calls use the separate model without tools.
  A unique summary marker reaches both subsequent foreground requests and
  later summarization inputs, proving checkpoint/previous-summary reuse.
- Checkpoint prompt version and pinned IDs match the original persisted task.
- Every physical Provider request has matching, hidden start/finish receipts.
  Usage and cost returned in SSE reach the durable finish receipt, including
  compaction; failures retain their HTTP status and reason.
- Repeated overflow stops after one retry. A one-request Run budget prevents
  the retry and any extra summarization request.
- HTTP summarizer failure uses the deterministic fallback while keeping the
  task and durable checkpoints.
- The original model transport releases Provider sockets before any forced
  fixture teardown. ACP client/server close and schema-scoped PostgreSQL
  cleanup still run after a business failure; cleanup failure fails the test.

Provider usage values are deliberately fixed sentinels (17 input, 11 output,
USD 0.000039). They validate parsing, routing and persistence, not real-model
token accuracy, pricing or semantic summary quality. The estimator corpus and
compaction unit tests remain independent admission checks.

## Remote Gate

The existing `agent-acp-postgres` component selection runs
`make test-agent-acp-postgres` and includes this file. No new workflow, image,
registry access, external model credential or Docker application deployment is
needed. PostgreSQL is still a real dependency, supplied by CI or an isolated
local test database.

For focused development feedback, against an explicitly isolated database:

```sh
ANTNEST_ACP_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST/isolated_test \
  npm --prefix services/agent-acp-service run test:postgres -- \
  acp-context-compaction.postgres.test.ts
```

Do not check off #51's replacement criterion until the exact candidate's
remote component result is reviewed. Span/Trace findings are auxiliary only.
Container startup, service deployment wiring and main/version-set system
acceptance remain separate; this test does not establish release capability.
