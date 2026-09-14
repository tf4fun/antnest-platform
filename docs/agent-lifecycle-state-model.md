# Agent Lifecycle And Runtime State

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

## Service Batches

1. Runtime Controller: normalized current phase and diagnostics, without waiting
   for readiness inside creation.
2. Agent Controller: hierarchy, observation projection, commands, Run admission,
   query contracts and persistence.
3. Console/consumer contracts: complete state, consistent actions and labels,
   separate Operation results and runtime condition.
4. Integration: lifecycle scenarios and trace/documentation updates. Agent UI
   browser acceptance remains deferred.

Each batch follows documentation, failing tests, code and serial local gates.
Do not claim an end-to-end workflow from a producer-only change.

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

## Progress

- Shared design: defined.
- Runtime Controller: full service suite with isolated PostgreSQL and race passed
  (200 tests, 160 subtests; two optional Docker image tests run separately).
- Agent Controller: full service suite with isolated PostgreSQL, Temporal and race
  passed (436 tests, 393 subtests, zero skipped/failed).
- Console: BFF Go race tests, TypeScript check, 104 unit and 225 component tests
  passed. Regressions cover never-ready management, post-completion Runtime
  condition updates, failure diagnostics and activation-driven network refresh.
- Consumers: independent read-only review found no obsolete lifecycle decisions
  in Gateway, ACP or Agent UI; their workspace projection remains unchanged.
- Integration: three owning services rebuilt and deployed without resetting data.
  Creation/readiness passed through Gateway with coherent persisted bindings and
  exact-request replay. Disable also passed: confirmed activation changes only
  after compute cleanup, retained workspace file verified, network attachment
  closed and new Run refused. Enable passed next: new compute uses the retained
  workspace, completes before independent readiness, and publishes a new binding.
  Creation/disable/enable were accepted by the user. Explicit rebuild passed
  next, including retained files, independent readiness, request replay and
  access revision rotation; the user accepted it. Deletion now also passed
  technical checks: deleted/absent, closed execution entry, removed compute and
  exclusive volume, retained audit history, and eventual network reclamation.
  The user accepted deletion. The five normal lifecycle
  paths have technical evidence; this does not cover all failure scenarios.
  Live Console browser verification was not performed; the browser tool
  rejected navigation under the earlier Web UI acceptance deferral.

## Creation Integration, 2026-09-13

- Agent: `agent_204318bb785ce79d72f8b10387c384ab`, retained at this scene's end;
  it was subsequently deleted in the final lifecycle scene below.
- [Creation trace](http://127.0.0.1:16686/trace/399de4b681cc7311f19f42b9243cd49c):
  164 spans, Gateway root, no missing parents or warnings.
- [Independent readiness trace](http://127.0.0.1:16686/trace/05256a2079b2795c0a1d16d8052c3ed8):
  60 spans, observation worker root, no missing parents or warnings.
- Observed: running/not_created/unknown; completed/created/enabled/unknown;
  completed/created/enabled/waiting; completed/created/enabled/available.
- Creation finished at `2026-09-13T11:33:45.350633Z`; independent execution
  publication occurred at `2026-09-13T11:33:48.177015Z`. Creation did not wait for
  the 2.826-second readiness interval.
- One execution revision; configured target, observed identity, endpoint, event
  and persisted execution binding agree. Creation's immutable snapshot still has
  unknown health and no execution identity. Same-key replay changed neither the
  completed Operation nor its recorded events. No LLM request was made.
- Full repository `make -j1 fmt-check lint` passed. Runtime Controller's two
  optional real-Docker image tests also passed and cleaned their resources.

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

## Disable Integration, 2026-09-13

At the end of this scene the same Agent was `created/disabled/absent`.
The user accepted the scene before the subsequent enable test below.
The [Gateway trace](http://127.0.0.1:16686/trace/f6ac45b9cb246be61b0b2ce9085d145e)
has 166 spans with no missing parents or warnings; each Activity executed once.
HTTP admission took 146 ms; the asynchronous business path took 721 ms.
Same-key replay was verified without repeated effects. Workspace and a marker
file survive; configured Spec, execution history and identity binding survive;
compute and the current execution entry are removed. An authenticated new Run
was rejected with `409 agent_not_ready`, with no admitted Run persisted.
See [the updated disable sequence](business-flow-agent-disable.md) for the
intermediate snapshots, exact request/revision identities and evidence limits.

## Enable Integration, 2026-09-13

At the end of this scene the same Agent was `created/enabled/available`.
The user accepted it before the explicit rebuild test below.
The [Gateway enable trace](http://127.0.0.1:16686/trace/f310cb870db0673ef61424469d2176ee)
has 177 spans; the [independent readiness trace](http://127.0.0.1:16686/trace/dffd78c1f21ab7f87b1acf9c954b3865)
has 61. Both have no missing parents or warnings. HTTP admission took 164 ms,
the asynchronous enable path 818 ms, and the Runtime enable RPC 397 ms without
waiting for health. After completion, unknown and waiting had no execution
binding; available was published 3.301 seconds later with a new execution.

The workspace marker survives in the new healthy container. The original Spec,
identity binding and deny_all policy survive; only the network attachment
reopens (version 3 to 4). Execution history now contains two revisions, with one
coherent current binding. Same-key replay changes neither the completed
Operation nor its events. A synthetic internal acquire-run/finish-run probe
verified the new binding and immediately released admission; zero active
admissions remain. No ACP prompt, external model, tool execution or browser
acceptance was performed. See [the enable sequence](business-flow-agent-enable.md).
The relevant reusable script suite passed 310 tests; `make -j1 fmt-check lint`
passed. Independent read-only review found no additional sequence or boundary
issue; the reviewer was closed without running verification or touching resources.

## Rebuild Integration, 2026-09-14

At this scene's end the same Agent was `created/enabled/available`.
The user accepted the scene before the subsequent deletion below.
The [Gateway rebuild trace](http://127.0.0.1:16686/trace/ff312d3edadaafc2d21d5059f4ca416b)
has 215 spans, and the [independent readiness trace](http://127.0.0.1:16686/trace/92040d8a2892332db0cb4e4af6303e68)
has 61; neither has missing parents or warnings. Admission took 189 ms,
the asynchronous workflow path 1.332 seconds and Runtime update 814 ms.
Readiness was published 2.912 seconds after operation completion.

Rebuilding from the same template revision still replaced the container and
process. The original workspace marker, network allocation and deny_all policy
survive; attachment versions changed 4 -> 5 -> 6. Two Specs contain the same
configuration; three execution revisions retain history with one coherent
current binding. Rebuild rotates access_revision: the old revision was rejected,
and the current revision admitted a synthetic request to the new Runtime. That
admission was immediately released without model or tool execution.

During the operation the old observed state and binding can remain visible,
but active_operation_request_id blocks new Runs. After completion there was no
binding during unknown/waiting, until independent available publication.
Intermediate exclusion is supported by prior service tests, not a newly injected
concurrent Run in this scene. Same-key replay preserved Operation and events.
Browser, real ACP conversation and fault injection were not performed.
See [the rebuild sequence](business-flow-agent-rebuild.md).
The reusable observability/state script suite passed 310 tests, and the diff
whitespace check passed. Independent read-only review found no new issue and
was closed. This batch changed documentation only; no service code or images
were changed and prior full service gates were not rerun.

## Delete Integration, 2026-09-14

The same Agent is now `deleted/absent`, with no activation, current Spec,
executable binding, Runtime identity/endpoint or active operation. The
[Gateway delete trace](http://127.0.0.1:16686/trace/cc9511b93902874d3ed750d49ee799b4)
has 175 spans, no missing parents or warnings; all six Activities ran once.
Admission took 114.725 ms, the asynchronous business path 680.699 ms and Runtime
delete 353.239 ms. Deletion does not require a separate readiness observation.
Same-key replay returned the same Operation and unchanged events.

The target compute and exclusive workspace volume are gone; the shared Skill
volume remains. Existing two Specs, three execution revisions, four previous
operations and seventeen previous events are unchanged. Two delete events
bring the event count to nineteen. The retained access binding is inactive;
no active Run admission remains. Current and owner lists hide the target,
while the administrator's Deleted list and detail preserve it. Owner state and
ACP entry return 404; a synthetic internal acquire-run returns 403 access_denied.
No model, prompt, tool execution or browser acceptance was performed.

Network release returned quarantined/version 2 with attachment closed/version 7.
After the configured 300-second quarantine, read-only database inspection found
the allocation, attachment and assignment removed. That later cleanup is not
part of the deletion Trace. Shared policy definitions are not Agent assignments;
do not infer their removal. Audit retention expiration was not exercised.
See [the delete sequence](business-flow-agent-delete.md) for exact identities,
intermediate states, the retained Runtime tombstone and verification limits.

This batch adds reusable deleted-state assertions and their regression test,
and updates scene documents; it changes no service implementation or image.
The reusable observability/state suite passed 311 tests, with zero skipped or
failed. Repository `make -j1 fmt-check lint` passed, including Go lint, both
Rust Clippy checks and frontend type checks. The read-only lifecycle checker
passed against the recorded Trace; no verification process was left running.
Independent read-only review found no flow or ownership issue. Its one assertion
gap, a residual configuration projection despite a cleared revision, was covered
with a failing test and fixed. The reviewer was closed without running commands
that mutate state or consume shared verification resources.

## Changed Configuration Rebuild, 2026-09-14

A dedicated Agent `agent_81d31b4536b04fbc9753176137351092` was created for this
variant; the prior lifecycle Agent remains deleted. Publishing template revision
2 changed neither the existing Agent, its events nor Docker resources. Explicit
rebuild then applied the changed model, prompt, request budget and memory/PID/tmpfs
limits. The new runtime retains the old workspace marker, while old Spec history
is unchanged. Two Specs and two execution revisions remain, with one coherent
current binding. Network allocation and deny_all policy remain unchanged.

The [template publication trace](http://127.0.0.1:16686/trace/fa174dd83bcb9bd97e7d2ea7f4e78bc2)
has 20 spans; [rebuild](http://127.0.0.1:16686/trace/130448ae9bdb50399c8c24824d9696df)
215 and [readiness](http://127.0.0.1:16686/trace/94bb688334ebf3cbd8554639d1610086)
61, all with no missing parents or warnings. Admission took 164.187 ms, the
workflow 1186.205 ms, Runtime update 661.686 ms, and readiness followed completion
by approximately 2.953 seconds. Old access was rejected; new internal admission
returned the updated execution snapshot and was immediately released. No actual
model or ACP client execution, browser acceptance, MCP/image upgrade or failure
injection was performed. Template and rebuild request replay passed.

See [the detailed variant](business-flow-agent-rebuild.md#6-新模板配置重建复验).
The dedicated Agent and its workspace remain available for the user's review.
Final reusable script tests passed 315 cases with no failures/skips; repository
format/lint and diff whitespace checks passed. Read-only review identified one
model-body/revision assertion gap, now covered by a failing regression and fix;
the strengthened assertion also passed against the live public projection and
independently read frozen Spec. No production service code changed this batch.
