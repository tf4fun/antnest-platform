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
