# Managed Tool Elicitation

This document explains why Runtime does not implement MCP tool elicitation,
how Runtime behaves while the feature is deferred, and the conditions for
resuming the work.

## Decision

Managed tool elicitation is deferred until the official MCP Rust SDK supports
the current protocol's URL input. Runtime relies on the official SDK
implementation only. When reconsidering the decision, check the latest official
release first and wait for upstream support if it is still incomplete. Do not
vendor, fork or patch the SDK, write a custom protocol adapter, or present
partial form support as completed elicitation.

Production Runtime uses the official `rmcp 3.4.1` crate. Normal tools, progress
and the managed stdio process lifecycle work as usual. Deferred elicitation adds
no session, durable table, background waiter or deployment dependency. ACP and
Agent UI elicitation work is deferred together with the Runtime producer.
Tool permission requests are a separate feature and are not affected by this
deferral.

## SDK Boundary

The external Runtime protocol is MCP `2026-07-28`. Its
[elicitation contract](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
returns `InputRequiredResult` for form or URL input through
[multi-round requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).
The client repeats the original tool and arguments with `inputResponses` and
opaque `requestState`. A client must not treat consent to open a URL as
completed external authorization.

The official SDK's [typed URL codec](https://docs.rs/crate/rmcp/3.4.0/source/src/model.rs)
still requires `elicitationId` in `ElicitRequestParams::UrlElicitationParams`.
The current protocol's URL input no longer requires that field. The SDK
therefore rejects a standard URL input without the field, and round-trips the
same input losslessly once only the legacy field is added. The same gap exists
in the `3.4.1` release that production uses.

Standard form data already round-trips through the SDK. The URL gap is the
concrete reason the whole elicitation producer remains deferred. JSON Schema
`pattern` data can also be lost, but the MCP form schema is a restricted subset,
so an unsupported extension is not evidence of a missing standard capability
and does not justify the deferral.

## Behavior While Deferred

1. Use the official typed codec and request path. Runtime keeps no raw JSON
   result preservation, schema adapter or multi-round forwarding.
2. Managed clients advertise no elicitation capability. HTTP caller capabilities
   are not delegated, so a child must not request unsupported user interaction.
3. Reject incoming tool continuations before any built-in or managed dispatch.
   Runtime does not ignore their fields and accidentally execute a fresh call.
4. If a child still returns an intermediate input requirement, report an
   explicit tool error with unknown effects. Do not auto-retry, fabricate a user
   decision, log input data, or report a successful completed tool.
5. Child discovery uses the SDK's `Auto` lifecycle: prefer `2026-07-28` discovery
   and allow SDK-managed fallback to `2025-11-25` initialization. Runtime keeps
   no hand-written negotiation or reverse-elicitation bridge.

## Resume Conditions

1. Recheck the latest official release by updating the independent probe's
   exact version and lockfile. Remove the SDK-gap expectation once upstream
   fixes it. Then upgrade Runtime and reproduce lossless standard form and URL
   results at its actual HTTP and stdio boundaries, including URLs without a
   legacy ID.
2. Deliver the work as separate service-owned changes: Runtime producer, ACP
   interaction and persistence, Agent UI, and then Gateway, Runtime and Jaeger
   integration. Do not combine those service implementations into one change.
3. Verify accept, decline and cancel; original arguments; opaque state; bounded
   rounds; per-request capability isolation; and cancellation without replay.
   Runtime owns one transport call. ACP owns Session, Run and Tool binding, user
   interaction, schema validation, deadlines and durable recovery.
4. Resolve ACP `elicitation/complete` from a real completion source. The current
   MCP URL flow has no legacy completion notification, and opening a URL alone is
   not evidence that the external business step completed.
5. Require managed-process and HTTP end-to-end tests running as a non-root
   user, UI interaction tests, and Gateway-rooted deployed traces before
   treating elicitation as complete. SDK compatibility tests alone are not
   end-to-end coverage.

## Tests

The Runtime suite includes SDK boundary tests in
[elicitation_tests.rs](../../../tests/integration/antnest-runtime/elicitation_tests.rs).
They check that a standard URL input without the legacy `elicitationId` is
rejected, that form input and legacy-ID URL input round-trip, and that modern
discovery and legacy initialization keep managed tools non-interactive. Other
Runtime tests cover continuation rejection without replay, error-effect
preservation and error trace classification. These tests validate the deferred
behavior, not a completed elicitation workflow. They run with the rest of the
Runtime suite:

```sh
make test-rust
make fmt-check
make lint
```

The independent [probe package](../../../tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml)
pins official `rmcp =3.4.0` with its own lockfile. It imports the official
typed codec directly, with no vendored source, patch or protocol adapter.
Production `Cargo.toml` and `Cargo.lock` are independent of it. The probe checks
three cases: standard form input with opaque state round-trips; standard URL
input without a legacy ID is rejected; adding only the legacy ID makes the same
URL input round-trip. The rejection check records the SDK gap on purpose and
must be replaced when upstream support arrives. Passing the probe does not mean
elicitation is implemented.

Run from the repository root:

```sh
cargo test --locked --manifest-path tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml
cargo fmt --manifest-path tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml --check
cargo clippy --locked --manifest-path tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml --all-targets -- -D warnings
```
