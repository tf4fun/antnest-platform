# F03 Deployed File Observation Acceptance

Current revalidation: 2026-09-17. All 16 business scenarios and 64 independent
request trace topology/privacy checks passed. Strict Trace failed on recorded
timing warnings; the deployment command remains nonzero. See the
[current report](../../../docs/file-observation-revalidation.md). The original
2026-09-09 results below retain their historical candidate and scope.

## Workflow

Login through Edge Gateway, create a Provider connection and Model, reference
its stable identity from a Template, then create an Agent using the returned
Template revision through Console BFF. Wait for executable readiness and call
ACP v1/v2 through Gateway. A deterministic SSE model asks
the real Rust Runtime to use builtin write/edit/read and validates the actual
result. It does not fabricate MCP results, file observations or ACP events.

Each protocol runs eight ordered cases in one Agent workspace: creation,
full-file edit, read, empty creation, replacing an existing empty file,
unchanged edit, oversized write with omitted diff, and failed edit. Each case
uses a fresh Session/connection, exactly one Tool invocation and a final model
response. Fresh-connection load/resume and fork must reproduce the same Tool
events without new model/Tool calls. Another user must receive the exact ACP
`access_denied` response with no private updates; an authenticated WebSocket
upgrade is not Agent access.

Assertions distinguish actual observed path from an initial request target,
creation from empty before-image, complete file text from edit fragments,
location-only observations from modifications, and known failure from success.
v1 carries standard before/after; v2 carries changes plus a Git patch where
representable. Official SDK schemas validate updates; Git patch parsing and
application must recover the exact path and file content. Unicode and a parent
directory ending in a space exercise real Runtime path handling.

Diff metadata must not enter model-facing Tool output or telemetry. Read output
and explicit model Tool arguments naturally contain file text and are not
misclassified as metadata leakage. Model fixtures reject extra dispatch, missing
Tools, malformed requests and incorrect results; negative unit cases ensure the
acceptance oracle cannot report green on missing/duplicated/wrong file facts.
Initial Tool locations may describe intent; an initial diff must never claim an
already completed modification, regardless of the eventual result.

After Agent deletion flushes Runtime telemetry, Jaeger must show one information
read, one catalog read, one ACP Tool dispatch and one actual Runtime Tool span
per Run, with Gateway ancestry. Use the existing bounded stable-span collection
helper. The actual Runtime Tool span must be a descendant of the ACP dispatch,
not merely present somewhere in the trace. Correlate the Provider's actual HTTP
CLIENT span to `model.complete` and `agent.run`, without retired admission tags.
Collect all 48 replay/fork message traces independently of model requests: each
must match its method and Session, link to its actual WebSocket connection and
contain zero Runs/model/Runtime calls. A missing or ambiguous trace is failure.
Check short ASCII sentinels in complete file context and synthetic credentials
are absent from traces; checking only a full escaped file string is insufficient.
For edit requests, also check every model message role for the context sentinel
that is absent from that edit's parameters and normal output. Read output remains
legitimate model content. IP forwarding is outside tracing scope.

## Run And Ownership

Build production Runtime and ACP images serially; other service images must
already match the working source. The profile starts a fresh Compose project
with one PostgreSQL instance and service-owned databases, no external Provider,
no `.secret`, no browser dependency and no cross-service SQL. Its Compose override
ignores local `.env`, removes the host Temporal port and reserves a dynamic IP
range separate from fixed Egress/Jaeger addresses. Test drivers have
no Docker socket; all file operations flow through ACP and actual Runtime MCP.

```sh
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:local .
make test-file-observation-fixtures
make e2e-file-observations
```

The parent deployment script owns cleanup of all project containers, Runtime
containers, volumes and networks on success/failure. Do not run alongside other
test/build profiles. Existing acceptance instances are never removed or reset.
Keep only final scenario/request/trace counts and verdicts in documentation,
not raw traces, filesystem contents or intermediate test logs.
Short Docker probes have a 30-second limit within the overall deadline. Compose
health startup uses the remaining 15-minute profile budget, not that short probe
limit; an explicit wrapper-only `--lifecycle` flag selects the wait. Neither mode
can bypass an expired deadline. Cleanup has its own bounded allowance.

Current scenario reports use `status: file_case_passed` for successful
verification and a separate `tool_status` for the expected Tool outcome. An
intentional failed edit must not look like a failed acceptance command to the
suite runner. The final business and strict Trace outcomes remain separate.

## Historical Evidence — 2026-09-09

Sixteen scenarios passed across v1/v2, with 32 validated model requests,
16 execution traces, 16 independently collected replay/fork traces and two
cross-user rejections. Each execution has exactly one actual Runtime Tool call;
replay/fork has none. Production Runtime and ACP images were rebuilt from the
working source. The final rerun after review passed with all owned containers,
volumes and networks removed; existing acceptance instances were unchanged.

Two independent read-only reviews found evidence gaps in replay trace collection,
Tool ancestry, short content sentinels, initial false diffs and startup timeout
classification. These have negative regression coverage; both reviewers are
closed. The focused file/progress/trace/Docker fixtures pass 28 cases. A passing
fixture test alone is not deployed acceptance. No external Provider or browser
acceptance is claimed. F04-F10 and client MCP injection remain outside this batch.

Final repository gates: `make fmt-check`, `make lint` and `make test-node` passed.
The Node gate ran 671 tests with no failures or skips: ACP 358, Console 220,
Agent UI 13 and shared acceptance fixtures 80. Go lint reported zero issues;
both Rust Clippy checks, ACP ESLint and all three TypeScript checks passed.
