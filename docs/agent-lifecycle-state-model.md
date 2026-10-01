# Agent Lifecycle And Runtime State

This document defines the Agent lifecycle hierarchy, how Runtime observations
relate to it, and the expected behavior of each lifecycle operation.

## Contract

```text
not_created
created
  enabled
    waiting / available / unhealthy / exited / absent / unknown
  disabled
deleted
```

`not_created` means the initial configured target has never been committed, not
proof that no partial resources exist. `created` survives rebuilds, failures and
disablement. Only completed deletion establishes `deleted`. Creating, rebuilding,
enabling, disabling and deleting remain existing Operation progress.

Activation is confirmed business state; desired state is the current effective
business target. Disable admission blocks new Runs immediately, but only
confirmed stopping enters `created.disabled`. A failed disable must not appear
successful. Enable publishes a target, not a readiness guarantee.

Runtime observations identify the current revision and verified execution,
compute phase, health, reason and observation time. Absence is a fact; desired
state and Operation explain whether it is expected. Failed observation is
unknown, not proof of exit or absence. Health changes never rewrite Operation
terminal results. Run admission additionally requires valid identity, matching
execution binding and no conflicting operation or Run. A new process cannot
silently restore an invalidated old binding.

Display labels and button availability are derived, not persisted separately.
Configuration and resource ownership remain visible before first readiness.
Never-ready Agents remain manageable without successful execution history.

## Ownership

- Runtime Controller reports the normalized current phase and diagnostics. It
  does not wait for readiness inside creation.
- Agent Controller owns the hierarchy, observation projection, commands, Run
  admission, query contracts and persistence.
- Console and other consumers display complete state, consistent actions and
  labels, and keep Operation results separate from the Runtime condition.

## Required Scenarios

| Scenario | Expected result |
| --- | --- |
| Initial create fails | not_created; retain operation and partial-resource evidence |
| Create completes before readiness | created/enabled; waiting or unknown; no Run |
| Process exits later | created/enabled/exited; original operation remains completed |
| Same execution health recovers | update observation without rewriting history |
| New process after unexpected loss | do not reuse invalidated execution binding |
| Rebuild removes old compute | remain created; operation explains absence |
| Disable requested/succeeds/fails | immediate admission barrier; confirmed disabled only on success |
| Enable completes | created/enabled; observe readiness independently |
| Delete succeeds/fails | deleted only after cleanup; failure preserves original lifecycle |
| Old observation arrives | never overwrite newer target or reopen access |
| Observation unavailable | unknown with diagnostic reason |

## Creation

Creation completes when Runtime resources are provisioned and the configured
target is published. It does not wait for readiness. The creation snapshot has
unknown health and no execution identity. An independent observation loop
publishes the execution binding once the Runtime is verified available. A
same-key replay returns the same completed Operation and events without
repeating effects.

```mermaid
sequenceDiagram
    participant Client as Administrator
    participant GW as Edge Gateway
    participant UI as Console BFF
    participant AC as Agent Controller
    participant WF as Temporal
    participant RC as Runtime Controller
    participant RT as Runtime
    Client->>GW: POST Agent creation
    GW->>UI: Forward authenticated request
    UI->>AC: Admit creation
    AC->>WF: Start lifecycle workflow with trace context
    AC-->>Client: 202 Agent + Operation
    WF->>RC: Initialize resources
    RC-->>WF: completed / provisioned, health unknown
    WF->>AC: Publish configured target
    Note over AC: created/enabled/unknown; Operation completed
    loop Independent current-state observation
        AC->>RC: Inspect configured Runtime
        RC->>RT: Verify /status when appropriate
        RC-->>AC: Current phase, health, identity, reason, time
        AC->>AC: Record condition; publish binding only if eligible
    end
    Note over AC: created/enabled/available; same completed Operation
    AC-->>Client: Event invalidation, then current Agent projection
```

## Disable

Disable ends in `created/disabled/absent`. Confirmed activation changes only
after compute cleanup. The workspace volume and its files, the configured Spec,
execution history and identity binding survive. Compute and the current
execution entry are removed, and the network attachment is closed. A new Run is
rejected with `409 agent_not_ready` and no admitted Run is persisted.

## Enable

Enable ends in `created/enabled/available`. New compute uses the retained
workspace. The enable operation completes before independent readiness; while
the Runtime is unknown or waiting there is no execution binding. Once the
Runtime is available, a new execution revision is published. The original
Spec, identity binding and network policy survive; only the network attachment
reopens with a new version.

## Rebuild

An explicit rebuild always replaces the container and process, even from the
same Template revision. The workspace, network allocation and policy survive;
the network attachment version advances. Rebuild rotates `access_revision`: the
old revision is rejected and the current revision is admitted only against the
new Runtime.

During the operation the old observed state and binding can remain visible,
but `active_operation_request_id` blocks new Runs. After completion there is no
binding while the Runtime is unknown or waiting, until independent available
publication.

A changed Template revision does not affect existing Agents. It changes an
existing Agent only after an explicit rebuild, which applies the new model,
prompt, request budget and resource limits while retaining the workspace and
previous Spec history.

## Delete

Delete ends in `deleted/absent`, with no activation, current Spec, executable
binding, Runtime identity or endpoint, and no active operation. Deletion does
not require a readiness observation. The Agent's compute and exclusive
workspace volume are removed. Spec history, execution revisions, previous
operations and events are retained, and the access binding becomes inactive.

Current and owner lists hide a deleted Agent; the administrator's Deleted list
and detail preserve it. Owner state and the ACP entry return 404, and internal
Run admission returns `403 access_denied`.

Network release moves the allocation into quarantine and closes the attachment.
After the configured quarantine period, Runtime Egress removes the allocation,
attachment and assignment. That later cleanup is not part of the deletion
trace. Shared policy definitions are not Agent assignments and are not removed.
