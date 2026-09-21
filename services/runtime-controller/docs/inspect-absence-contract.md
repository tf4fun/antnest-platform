# Runtime Inspect absence classification

Scope: Runtime Controller's Docker Driver.Inspect and its telemetry only.
Inspect already returns a successful absent Inspection for a missing container;
its single Docker existence GET must use the same expected-absence context as
creation probes. Preserve wire HTTP 404, unset span status, outcome absent and
no error event. Preserve absent Agent/generation identity and empty execution
identity, and do not issue retries or mutations.

Do not change the generic Docker client, required-resource/post-create checks,
Delete, identity conflicts, authorization/server/transport/body failures or
clock/export policy. Develop real-HTTP positive/negative regression tests first,
then run full service/race/PostgreSQL, lint and formatting gates. Build a separate
candidate image; preserve the local image tag and retained deployment.

Integration is a subsequent acceptance batch using the candidate in disposable
Foundation/Loss deployments. Require existing business and source-generation
proof, all request/lifecycle topologies, zero source-Inspect ERROR spans, and
strict failure retention for timing and deliberate rejection markers. No old
assets or retained data are removed, and development deployment remains separate.
