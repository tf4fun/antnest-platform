# Identity and access contract

This document defines what the [identity and access profiles](README.md) must
prove. The profiles are independent fixtures; they do not change production
service behavior, and passing one profile says nothing about the others.

## Profiles

1. **Identity HTTP, SCIM and OIDC** (`make e2e-identity-core`,
   `make e2e-identity-access`): local sessions, CSRF, Membership and global User
   revocation, SCIM isolation and lifecycle, password-change semantics, real
   token expiry and outage recovery, verified HTTPS OIDC and correlated
   secret-free logs. Each runs in a disposable project with explicit synthetic
   configuration, loopback ports, isolated allocator ranges and bounded process
   cleanup.
2. **ACP Session consumers** (`make e2e-acp-session`): v1 and v2 logout, expiry
   and outage behavior, continuation of accepted Runs, no effects from rejected
   messages and exact history restoration. Assertions use the current Provider
   and Model setup, the ACP audit and per-message Trace contracts.
   Official SDK protocol work runs over private ACP. Browser authority is proved
   by the original Cookie's Bridge SSE and an independent post-close HTTP denial.
   The collector joins original SSE, logout or short-TTL login, denial and linked
   Resolve source Traces; locally closing the SDK is cleanup, not remote browser
   closure evidence. The actual Gateway cache must be 10 seconds, shared Resolve
   work is bounded by 5 seconds, and expiry probes use the original headers'
   fixed monotonic deadline. Successful login requires a committed token INSERT.
   The coordinating runner retains raw Identity inspections before and after
   each fault. A successful stop keeps the original container and image, exits
   normally without OOM, and has a completed Docker lifecycle. The subsequent
   5-second and restored 12-hour configurations each require a new healthy
   container using the independently selected image, the same project and run,
   and exactly the intended token TTL and read-only TLS trust. A checkpoint is
   acknowledged only after its inspection passes and its receipt is saved.
   Docker lifecycle timestamps and the runner's command observations remain
   separate clock domains; neither substitutes for the browser's original
   stream, credential lifetime or raw authorization-cause evidence.
   This profile builds isolated current-source candidates for all ten deployed
   services and the standard release Runtime. Only an explicitly provided image
   from the current CI run may supply a candidate base. Actual model and SDK
   client containers must use the independently inspected ACP image. The SDK
   client receives only the read-only Gateway-to-Identity and Agent-UI-to-ACP
   workload grants; the model receives neither. Cleanup removes only recorded
   candidate tags whose actual ownership still belongs to this run.
3. **Agent access and offboarding** (`make e2e-agent-access`): organization,
   administrator, member and owner isolation, same-user cross-organization
   evidence, automatic Disable and explicit Enable, Controller restart recovery
   and SCIM and OIDC offboarding. ACP authorization and durable effects, Runtime
   replacement boundaries and exact source-event, Temporal workflow and activity
   ancestry are verified.

## Trace rules

Completed-request Trace collection waits for the topology, SQL ownership,
protocol and privacy assertions before archiving. It keeps unmodified spans,
error events and warnings. Strict warning and error results are failures and are
reported after all independent business cases run; topology success does not
imply strict success. Clock settings, timestamps and export intervals are never
changed.

## Verification rules

Fixture and contract tests come first, including negative evidence and real HTTP
collector tests. The affected local tests and each applicable Docker profile
then run serially. Other running containers keep their IDs, images and health,
and every disposable project and verification child process is removed after
success, failure or interruption.
