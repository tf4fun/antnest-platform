# Interrupted Update migration contract

Current Runtime Update completes provisioning independently of Runtime readiness.
The historical startup gate therefore cannot prove a running mutation. Its
pause/SIGKILL checkpoint and lease-expiry assertions are not normal-restart
acceptance. Its source assets are retired; the distinct fault scope is recorded
in [the retirement report](../../docs/interruption-assets-retirement.md).

The current disposable Foundation profile owns a transparent HTTP fixture between
Agent Controller and Runtime Controller. Arm one Agent's next Update. Forward
the original body, Idempotency-Key and trace context; hold only an actual HTTP 200
completed Update response. Record identifiers, digests and delivery state, never
configuration or credentials. Other requests, including observation streams,
remain transparent. A caller disconnect and hold expiry are distinct outcomes.

Before stopping, require Agent Controller running/runtime_update with no saved
Runtime result and the deterministic child request; Runtime Controller must have
that exact child completed, with the new target physically present. Stop Agent
Controller normally, then Runtime Controller normally; both must exit zero.
The held response must be lost through caller cancellation, never expiry. Verify
the frozen parent phase, durable child and target, then restart Runtime Controller
before Agent Controller. Temporal must retry the same Activity/request and reuse
the terminal child and exact target without another generation or physical effect.

Require exact public replay, original workspace bytes, one rebuilt event, one
updated observation, unchanged child attempt and one new execution publication.
Create a new Template revision before Rebuild; catalog revision creation must
leave the Agent configuration unchanged, and recovery must publish that selected
revision with its changed request budget and otherwise unchanged configuration.
Delete the temporary Agent through the public lifecycle API. Preserve both real
Workflow spans, both Update attempts and downstream ancestry, including the
successful first Runtime response and the canceled caller. Strict cancellation
and timing results remain failures. Do not edit journals, fabricate spans, change
production timeouts/export intervals, or replace retained development resources.

This replaces the normal-restart acceptance entry point. Recovery of an unfinished
Runtime platform mutation after abrupt process death remains a different fault
scenario. Existing service recovery tests retain their narrower assertions; no
current end-to-end passing evidence is claimed for that abrupt-crash boundary.

Current Update receipt recovery and Runtime loss import `recovery-support.mjs`
for bounded polling, scoped inspection and fixed service-owned journal reads.
Current physical inspection must not execute a startup marker command or return
historical gate evidence. The historical `interruption-support.mjs`, startup-gate
flow/overlay/image and exclusive Trace collector are retired after the helper
split. Current profiles do not execute that graph. Shared observability evidence
and all current lifecycle/recovery assertions remain.
