# ACP file observation E2E

This scenario verifies that file changes made by the real Runtime's builtin
write, edit and read Tools are reported correctly through ACP v1 and v2 on a
disposable full stack.

## Running

Build the Runtime and ACP images serially; the other service images must already
match the working source (`make docker-build-stage3` builds all of them).

```sh
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:local .
make test-file-observation-fixtures
make e2e-file-observations
```

`make test-file-observation-fixtures` runs the fixture and oracle tests without
Docker. The E2E profile starts a fresh Compose project with one PostgreSQL
instance and service-owned databases. It needs no external Provider, `.secret`
file or browser, and it performs no cross-service SQL. Its Compose override
ignores the local `.env`, removes the host Temporal port and reserves a dynamic
IP range separate from the fixed Egress and Jaeger addresses. Test drivers have
no Docker socket; all file operations go through ACP and the Runtime's MCP
interface. Do not run it alongside other test or build profiles.

## Workflow

The client logs in through the Edge Gateway, creates a Provider connection and
Model, references the Model's stable identity from a Template, then creates an
Agent from the returned Template revision through the Admin Console BFF. After
the Agent is executable, it calls ACP v1 and v2 through the Gateway. A
deterministic SSE model asks the real Rust Runtime to use builtin write, edit
and read and validates the actual result. Nothing fabricates MCP results, file
observations or ACP events.

Each protocol runs eight ordered cases in one Agent workspace: creation,
full-file edit, read, empty creation, replacing an existing empty file,
unchanged edit, oversized write with an omitted diff, and failed edit. Each case
uses a fresh Session and connection, exactly one Tool invocation and a final
model response. Load, resume and fork on a fresh connection must reproduce the
same Tool events without new model or Tool calls. Another user must receive the
exact ACP `access_denied` response with no private updates; an authenticated
WebSocket upgrade is not Agent access.

## Assertions

- Assertions distinguish the observed path from the initial request target,
  creation from an empty before-image, complete file text from edit fragments,
  location-only observations from modifications, and known failure from
  success.
- v1 carries standard before and after content; v2 carries changes plus a Git
  patch where representable. Official SDK schemas validate updates, and Git
  patch parsing and application must recover the exact path and content.
  Unicode names and a parent directory ending in a space exercise real Runtime
  path handling.
- Diff metadata must not enter model-facing Tool output or telemetry. Read
  output and explicit model Tool arguments naturally contain file text and are
  not treated as metadata leakage.
- Initial Tool locations may describe intent, but an initial diff must never
  claim an already completed modification.
- Model fixtures reject extra dispatch, missing Tools, malformed requests and
  incorrect results. Negative unit cases ensure the oracle cannot pass on
  missing, duplicated or wrong file facts.

Scenario reports use `status: file_case_passed` for a successful verification
and a separate `tool_status` for the expected Tool outcome, so an intentionally
failed edit does not look like a failed test command to the suite runner. The
business result and the strict Trace result are reported separately.

## Trace checks

After Agent deletion flushes Runtime telemetry, Jaeger must show, per Run, one
information read, one catalog read, one ACP Tool dispatch and one actual Runtime
Tool span with Gateway ancestry. The Runtime Tool span must be a descendant of
the ACP dispatch, not merely present in the Trace. The Provider's HTTP CLIENT
span is correlated to `model.complete` and `agent.run`.

All replay and fork message Traces are collected independently of model
requests. Each must match its method and Session, link to its WebSocket
connection and contain no Run, model or executable Runtime calls. A replay may
refresh the Runtime Skill catalog with at most one `discover` and one
`resources/read` request under the ACP request span; any other Runtime method
fails. A missing or ambiguous Trace is a failure.

Short ASCII sentinels from the complete file context and synthetic credentials
must be absent from Traces; checking only a full escaped file string is not
enough. For edit requests, every model message role is also checked for the
context sentinel that is absent from that edit's parameters and normal output.
IP forwarding is outside the tracing scope. Strict timing warnings make the
command exit nonzero.

## Cleanup and timeouts

The parent deployment script removes all project containers, Runtime
containers, volumes and networks on success or failure. Short Docker probes have
a 30-second limit inside the overall deadline. Compose health startup uses the
remaining 15-minute profile budget, selected by the wrapper-only `--lifecycle`
flag. Neither mode can bypass an expired deadline. Cleanup has its own bounded
allowance. Only final scenario, request and Trace counts are printed; raw Traces,
file contents and intermediate logs stay private.
