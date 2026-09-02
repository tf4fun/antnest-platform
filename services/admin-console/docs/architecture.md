# Admin Console Architecture

## Modules

```text
web/                 React application and shadcn UI components
internal/principal/  trusted Edge Gateway principal parser
internal/upstream/   traced Identity and Agent Controller clients
internal/server/     BFF request shaping, scope checks, and static fallback
internal/telemetry/  HTTP spans, correlated logs, and OTLP lifecycle
cmd/admin-console/   composition and shutdown only
```

The BFF receives a verified principal from Edge Gateway. It generates request
IDs and authority fields, then calls the existing language-neutral internal
contracts. Browser JSON cannot select another organization or impersonate an
actor.

Internal RPC payloads are never raw-proxied on successful reads. The server
projects explicit browser DTOs and omits Provider credential references, Agent
access subjects/revisions, Runtime execution identities, MCP endpoints, and
event data. This is an allowlist boundary: a new internal field remains private
until the BFF deliberately exposes it.

The overview is a non-persistent presentation aggregate. Four buffered reads
share one bounded context and execute concurrently; goroutines never write the
`ResponseWriter`. Agent inventory is required. Directory, Model Profile, and
Template sections return stable `available`/`unavailable` envelopes so one
optional dependency does not erase authoritative fleet state.

Lifecycle reads are authoritative snapshots. SSE is a wake-up/experience
channel; reconnecting clients recover by listing events and refetching Agent and
operation projections.

## Failure Semantics

- missing or malformed trusted identity context fails closed;
- upstream `4xx` domain errors are preserved for the UI;
- dependency transport failure returns `503` and never fabricates success;
- required overview failure returns `503`; optional section failure remains a
  named degraded section in a successful aggregate;
- a resource outside the principal organization is exposed as `404`;
- secret input is forwarded once and never logged or returned by the BFF.

## Extension Rules

New pages may aggregate reads, but writes remain one command to one owning
service. A workflow that needs durable retries or cross-service state belongs in
the domain controller, not in this presentation service.
