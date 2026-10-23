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

Current Controller `readiness` is separate from this hierarchy: `preparing`
means an otherwise eligible Agent awaits its binding or a covering ACP ACK;
`ready` requires applied proof for the same current eligible binding;
`unavailable` means current access, lifecycle work or Runtime condition blocks
execution. Current blockers override historical ready proof. A legacy response
without the optional field is unknown, never implicitly ready. Private proof
does not become a public payload.

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
| Create completes without binding | created/enabled; waiting or unknown; readiness preparing; authorized ACP entry stays closed with agent_preparing |
| Healthy binding before ACP ACK | v2 runtime_bound and organization threshold commit together; complete snapshot is executable; readiness still preparing |
| ACP ACK covers current eligible binding | atomically record applied proof and unique v2 agent_ready; readiness ready; ordinary ACK does not advance publication revision |
| Current access or lifecycle closes after ready | readiness unavailable; retain historical proof and events |
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

Binding publication commits v2 `runtime_bound` with the resulting organization's
execution-configuration revision as `ready_after_revision`. The publisher sends
that complete executable snapshot to ACP without waiting for Controller
readiness; readiness cannot gate the publication whose ACK it needs. Only a covering ACK for that still-eligible
binding can atomically record v2 `agent_ready` and ready proof. An ordinary ACK
does not advance the publication revision or change its snapshot.

If a failed lifecycle operation retains the original binding, fresh Runtime
health may reopen it, but the current readiness view stays preparing until
ACP acknowledges that reopening snapshot. The private reopening revision
does not rewrite historical bound/ready events or follow unrelated changes.
Failure diagnostics remain visible after the binding becomes ready again.

```mermaid
sequenceDiagram
    participant Client as Administrator
    participant GW as Edge Gateway
    participant UI as Console BFF
    participant AC as Agent Controller
    participant WF as Temporal
    participant RC as Runtime Controller
    participant RT as Runtime
    participant ACP as Agent ACP Service
    Client->>GW: POST Agent creation
    GW->>UI: Forward authenticated request
    UI->>AC: Admit creation
    AC->>WF: Start lifecycle workflow with trace context
    AC-->>Client: 202 Agent + Operation
    WF->>RC: Initialize resources
    RC-->>WF: completed / provisioned, health unknown
    WF->>AC: Publish configured target
    Note over AC: created/enabled/unknown; Operation completed; readiness preparing
    loop Independent current-state observation
        AC->>RC: Inspect configured Runtime
        RC->>RT: Verify /status when appropriate
        RC-->>AC: Current phase, health, identity, reason, time
        AC->>AC: Eligible binding + org revision R + threshold R + v2 runtime_bound, one transaction
    end
    Note over AC: created/enabled/available; readiness preparing; same completed Operation
    AC->>ACP: Publish complete executable snapshot R without waiting for ACK
    ACP-->>AC: organization_id + applied_revision covering R
    AC->>AC: Recheck current binding and eligibility; applied proof + v2 agent_ready, one transaction
    Note over AC: readiness ready; ordinary ACK does not advance R
    AC-->>Client: Event invalidation, then current Agent projection
```

## Disable

Disable ends in `created/disabled/absent`. Confirmed activation changes only
after compute cleanup. The workspace volume and its files, the configured Spec,
execution history and identity binding survive. Compute and the current
execution entry are removed, and the network attachment is closed. A new Run is
rejected with `409 agent_not_ready` and no admitted Run is persisted.

## Enable

Enable provisioning ends in `created/enabled` with Runtime `unknown`; available
binding and acknowledged readiness follow independently. New compute uses the retained
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
publication emits v2 `runtime_bound`. That replacement needs its own covering
ACK before v2 `agent_ready`; an old binding's ready fact cannot be reused.

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

## Legacy Readiness And Remaining Acceptance

Historical v1 `agent_ready` events remain unchanged and are not ACK proof. A
startup or periodic resend of revision R can receive ACK R and discover an
eligible legacy binding without proof. That transaction bootstraps a bound
threshold at R+1; only a new covering ACK can mark the binding ready. This is
the exception to ordinary ACKs not advancing publication revision.

Controller producer/API and ACP preparing code are implemented in the current
candidate. Agent UI preparing presentation and Admin Console readiness
consumption remain pending, as does the real two-second delayed-publication
test repeating create, wait-for-ready and immediate successful Prompt 100 times.
This document does not claim final PostgreSQL verification or completion of
the cross-service readiness workflow. See the
[readiness contract](../contracts/agent-controller/readiness.md).
