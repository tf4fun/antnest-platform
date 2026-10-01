# Interrupted Runtime Update contract

This document defines what the interrupted-update profile
(`make e2e-lifecycle-interrupted`) must prove: recovery when a completed Runtime
Update response is lost during a normal Controller restart.

Runtime Update provisioning completes independently of Runtime readiness, so a
startup gate cannot hold a mutation in a running state. This profile therefore
holds the response instead.

## Response-hold fixture

The disposable Foundation profile places a transparent HTTP fixture between the
Agent Controller and the Runtime Controller and arms one Agent's next Update. The
fixture forwards the original body, `Idempotency-Key` and Trace context, and
holds only an actual HTTP 200 completed Update response. It records identifiers,
digests and delivery state, never configuration or credentials. All other
requests, including observation streams, pass through unchanged. A caller
disconnect and a hold expiry are distinct outcomes.

## Required behavior

- Before stopping anything, the Agent Controller must be at
  `running/runtime_update` with no saved Runtime result and the deterministic
  child request, and the Runtime Controller must have that exact child completed
  with the new target physically present.
- The Agent Controller stops normally, then the Runtime Controller; both must
  exit zero. The held response must be lost through caller cancellation, never
  expiry. The frozen parent phase, durable child and target are verified.
- The Runtime Controller restarts before the Agent Controller. Temporal must
  retry the same Activity and request and reuse the terminal child and exact
  target, with no extra generation or physical effect.
- Exact public replay, the original workspace bytes, one rebuilt event, one
  updated observation, an unchanged child attempt and one new execution
  publication are required.
- A new Template revision is created before the Rebuild. Creating the catalog
  revision must leave the Agent configuration unchanged, and recovery must
  publish the selected revision with its changed request budget and otherwise
  unchanged configuration.
- The temporary Agent is deleted through the public lifecycle API.

## Trace rules

Both real Workflow spans, both Update attempts and their downstream ancestry are
preserved, including the successful first Runtime response and the cancelled
caller. Strict cancellation and timing results remain failures. Journals,
spans, production timeouts and export intervals are never edited.

## Out of scope

Recovery of an unfinished Runtime mutation after abrupt process death is a
different fault scenario; see the [crash contract](crash-contract.md) and
`make e2e-lifecycle-crash`.
