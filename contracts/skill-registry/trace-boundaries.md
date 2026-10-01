# Skill Registry HTTP Trace boundaries

This document defines Skill Registry's HTTP tracing behavior. It does not
change discovery authority, package ownership, lifecycle or response/error
contracts.

The service follows [the shared observability contract](../../docs/observability-contract.md):

- Extract W3C TraceContext before the Registry HTTP SERVER span. Its name is
  `HTTP <METHOD> <route template>`; unknown paths use `unmatched`. Keep route
  parameters and queries out of span names/attributes.
- The private source adapter creates one actual HTTP CLIENT span, named
  `HTTP POST agent-acp-service`, then injects that span's W3C context. ACP's
  source SERVER and `skill.source.observe` therefore retain the calling Run's
  Trace. Baggage and credentials are not propagated as telemetry attributes.
- End the CLIENT after response EOF, close, transport/read failure or
  cancellation. End the SERVER after handler completion, including rejected
  requests, cancellation and panic. Observation preserves the original result.
- SERVER 4xx responses retain their HTTP status without becoming execution
  errors; SERVER 5xx and transport/cancellation failures are errors. CLIENT
  non-success statuses retain the existing downstream error semantics.
- These are ordinary HTTP JSON/ZIP routes. Do not serialize headers, queries,
  projection/Skill bodies, package bytes or dialogue evidence, even when the
  separate RPC-content switch is enabled. Error descriptions are bounded
  classifications, never upstream error text or URLs.
- Use the repository's pinned Go OTel SDK and its default batch exporter. Flush
  via a bounded graceful shutdown, after HTTP requests finish. Export failures
  do not change business responses. No manual timestamps or forced export in
  business requests.
- `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` disables export, while
  preserving W3C propagation. Export uses the existing `otlp` / `http/protobuf`
  settings and endpoint variables. Invalid exporter/protocol configuration
  fails startup. Service identity defaults to `skill-registry`.

Deployment passes these settings to Registry using ordinary Compose. No public
port or Runtime/Egress network membership is needed. Registry has no SQL or
transaction span instrumentation and no OTLP metrics or log exporter.

Unit tests cover real parent IDs, body lifetime, cancellation, safe error
metadata and export/propagation configuration; a root HTTP component test
checks SERVER → CLIENT → source SERVER/observation, and
`make e2e-skill-registry-trace` checks the chain with actual ACP, Runtime,
Registry and Jaeger. Missing parents or missing source observations are
failures.
