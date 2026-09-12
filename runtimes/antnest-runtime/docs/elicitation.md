# Managed Tool Elicitation

## Status And Decision

F07 is deferred as of 2026-09-09. The maintainer requires an official SDK
implementation: check the latest release first, and wait for upstream support
if it remains incomplete. Do not vendor, fork or patch the SDK, write a custom
protocol adapter, or present partial form support as completed elicitation.

Runtime now uses official `rmcp 3.2.0`. Its normal tools, progress and managed
stdio process lifecycle remain available. F07 adds no session, durable table,
background waiter or deployment dependency while deferred. ACP and Agent UI
elicitation work and its deployment acceptance are deferred with the producer.
This does not defer F06 tool permission requests, which are a separate feature.

## Verified SDK Boundary

The external Runtime protocol is MCP `2026-07-28`. Its
[elicitation contract](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
returns `InputRequiredResult` for form or URL input through
[multi-round requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).
The client repeats the original tool and arguments with `inputResponses` and
opaque `requestState`; it must not treat consent to open a URL as completed
external authorization.

The [official SDK 3.2.0](https://docs.rs/rmcp/3.2.0/rmcp/) still requires
`elicitationId` in `ElicitRequestParams::UrlElicitationParams`. The current
protocol's URL input no longer requires that field. Deserializing a valid URL
input without it fails; adding the old field succeeds. This was reproduced
against the installed, locked 3.2.0 crate, not inferred from 3.1.4 alone.

The deferred SDK test is a reminder to revisit this decision on upgrade, not
a claim of protocol conformance. Basic standard form data already round-trips;
the URL gap is the concrete reason the whole F07 producer remains deferred.
Earlier experiments also observed lost JSON Schema `pattern` data. The MCP
form schema is a restricted subset, so an unsupported extension is not evidence
of a missing standard capability and is not used to justify the deferral.

## Behavior While Deferred

1. Use the official typed codec and request path. Remove the experimental raw
   JSON result preservation, schema adapter and multi-round forwarding.
2. Managed clients advertise no elicitation capability. HTTP caller capabilities
   are not delegated; a child must not request unsupported user interaction.
3. Reject incoming tool continuations before any built-in or managed dispatch.
   Do not ignore their fields and accidentally execute a fresh call instead.
4. If a child nevertheless returns an intermediate input requirement, report
   an explicit tool error with unknown effects. Do not auto-retry, fabricate a
   user decision, log input data, or report a successful completed tool.
5. Child discovery uses the SDK's `Auto` lifecycle: prefer `2026-07-28` discovery
   and allow SDK-managed fallback to `2025-11-25` initialization. No hand-written
   negotiation or reverse-elicitation bridge is maintained.

## Resume Conditions

1. Upgrade to an official release and reproduce lossless standard form and URL
   results at its actual HTTP/stdio boundary, including URLs without a legacy
   ID. Remove the SDK-gap expectation when upstream fixes it.
2. Resume service-owned batches: Runtime producer, ACP interaction/persistence,
   Agent UI, then Gateway/Runtime/Jaeger integration. Do not combine those
   service implementations into one batch.
3. Verify accept/decline/cancel, original arguments, opaque state, bounded
   rounds, per-request capability isolation and cancellation without replay.
   Runtime owns one transport call; ACP owns Session/Run/Tool binding, user
   interaction, schema validation, deadlines and durable recovery.
4. Resolve ACP `elicitation/complete` from a real completion source. The current
   MCP URL flow has no legacy completion notification; opening a URL alone is
   not evidence of external business completion.
5. Require non-root managed-process/HTTP acceptance, UI interaction and
   Gateway-rooted deployed traces before marking F07 complete. Native SDK
   compatibility tests alone are not end-to-end evidence.

## Final Local Checks

The 2026-09-09 native macOS suite passed 95 tests (0 failed, 0 ignored) against
locked `rmcp 3.2.0`. Coverage includes the SDK URL gap, standard form roundtrip,
modern discovery and simulated legacy initialization, rejection without replay,
error-effect preservation, and error trace classification. Fixture negotiation,
discovery and shutdown are bounded. An earlier stalled fixture run was discarded
and its complete test process group terminated before rerunning successfully.

`make fmt-check` and `make lint` passed, including all-target Rust Clippy with
warnings denied. No Docker rebuild, Linux integration, browser, external
Provider or deployed Jaeger acceptance was performed for this SDK update.
These checks validate the deferred behavior, not a completed F07 workflow.
