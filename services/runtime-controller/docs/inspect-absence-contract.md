# Runtime Inspect Absence Classification

This document defines how Runtime Controller's Docker driver classifies a
missing container during `Driver.Inspect`, and how that result appears in
telemetry.

## Behavior

- Inspect returns a successful absent Inspection when the container does not
  exist. A missing container is an expected outcome, not an error.
- The single Docker existence `GET` that Inspect issues uses the same
  expected-absence context as the creation probes.
- The wire response stays HTTP 404. The span status stays unset, the outcome is
  `absent` and no error event is recorded.
- The absent Inspection keeps the Agent and generation identity and has an empty
  execution identity.
- Inspect never retries and never mutates Docker state because of absence.

## Out of Scope

Absence classification does not change:

- the generic Docker client;
- required-resource and post-create checks;
- Delete;
- identity conflicts;
- authorization, server, transport or body failures, which remain errors;
- clock and export policy.
