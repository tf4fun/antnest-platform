# Crash recovery: pi reference and delivery boundary

Date: 2026-09-21. Research and existing-test verification, not a delivered recovery
feature. The user's priority is to consider crash recovery; inspected nonlogical
Trace timing findings and F07 remain deferred, not active implementation tasks.

## Reference provenance

Inspected the clean local checkout at
`/Users/xiaxilin/Projects/orcat/references/pi`, upstream `earendil-works/pi`, commit
`086c32e74530564922d011ade23ff582c9d63116` (2026-08-15). This is a pinned implementation
reference, not a claim to have audited today's latest release. The upstream
SessionManager and message-transform source pages were also checked.

Pi persists user/assistant/Tool messages on `message_end`. SessionManager writes
JSONL entries; initial persistence waits for an assistant message, then subsequent
entries append. Loading parses individual entries and tolerates malformed lines.
This supports restoring saved context, but is not a transaction spanning Tool
side effects and message storage. See
[SessionManager](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/coding-agent/src/core/session-manager.ts)
and [AgentSession](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/coding-agent/src/core/agent-session.ts).

The model-message transform skips errored/aborted assistant responses and fills
orphaned Tool calls with error results. This repairs model input; it neither
reexecutes the Tool nor establishes whether its external effect happened. See
[transform-messages](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/ai/src/api/transform-messages.ts).
Agent `continue()` requires suitable saved context and rejects an assistant tail
without queued input. It is not, by itself, a durable worker restart scheduler.
See [Agent](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/agent/src/agent.ts).

The useful principle is to reconstruct from recorded facts and make interruption
explicit. Do not copy JSONL in place of the platform's PostgreSQL transactions,
invent successful Tool results, or infer exactly-once external effects from
message replay. These are design conclusions from the inspected paths, not a
claim about every pi extension or subsystem.

## Existing platform behavior

| Layer                        | Already implemented                                                                                                                       | Remaining distinction                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ACP worker startup           | Acquires worker ownership, cancels abandoned permissions and runs recovery before serving                                                 | Worker startup is already guarded; do not add a competing recovery worker                                                       |
| ACP pending/running Run      | Rejects pre-execution admissions; interrupts Tool attempts; finishes running work as failed or unresolved according to recorded effects   | It reconciles old work rather than automatically resuming model execution                                                       |
| ACP Tool effects and history | Appends an interruption result, preserves unknown effect/source and immutable audit; context is rebuilt from persisted events/checkpoints | An absent Tool response does not authorize executing it again                                                                   |
| Runtime Update               | Reuses persisted request/target identities, checks source/target/storage, and replays completed operations without platform mutation      | Service tests prove several recovery branches; real process interruption in an unfinished mutation lacks current E2E acceptance |
| Controller                   | Temporal provides durable orchestration and deterministic child requests                                                                  | Current normal-stop/committed-response E2E is narrower than unfinished Runtime mutation crash recovery                          |

Source anchors: [RunRecovery](../services/agent-acp-service/src/application/run-recovery.ts),
[startup composition](../services/agent-acp-service/src/composition.ts),
[Tool interruption transaction](../services/agent-acp-service/src/adapters/postgres/run-event-repository.ts),
[context projection](../services/agent-acp-service/src/adapters/postgres/context-repository.ts),
[Runtime operation preparation](../services/runtime-controller/internal/control/service.go),
[Runtime Update](../services/runtime-controller/internal/control/update.go).

## Proposed delivery order

There are two different requests that “crash recovery” could describe. The
preceding backlog item concerns Runtime lifecycle mutation. Pi is primarily a
reference for Agent conversation continuation. The user selected Runtime reconstruction after this research. Its
[owning-service contract](../services/runtime-controller/docs/crash-recovery-contract.md)
defines the first batch; Agent session continuation remains out of scope.
Shared boundaries below apply to either path.

1. Preserve old Run/operation facts, accepted effect uncertainty and current
   ownership checks. Recovery must not rewrite a failed/unknown attempt as success.
2. Revalidate current access, execution configuration and Runtime identity before
   any newly resumed model or Tool work. Historical permission grants must not be
   treated as permission for a new execution.
3. Use durable facts to distinguish no Tool started, recorded completed Tool,
   and Tool dispatched without a recorded result. Only the first two provide a
   potential safe continuation boundary; a completed prefix still needs complete
   context and current authorization. Unknown external effects stay blocked from
   blind replay.

### Runtime lifecycle path: first proposed batch

Own this batch in Runtime Controller. First add deterministic, opt-in component
fault tests using a child process, actual PostgreSQL state and owned disposable
Docker resources. Interrupt the child at an observed operation boundary, with a
test-only adapter wrapper; do not use readiness as a proxy for a running mutation,
edit journals to manufacture a checkpoint, or add production sleep flags.

Cover before source removal, source removed/target absent, target present before
terminal journal commit, and committed operation before response delivery. A
fresh child must retry the identical request/body and preserve target revision,
generation, digest and workspace identity. Require no duplicate physical target,
or updated observation; execution-publication counts belong to the later
integration batch. Reject conflicting ownership/spec and
concurrent different requests. Normal process cleanup and evidence ownership
remain mandatory. Abnormal-exit diagnostics are separately invoked, not added to
the routine normal-restart suite. Missing spans in the intentionally interrupted
process are recorded as such; completed follow-up request topology still applies.

If a test exposes a recovery defect, implement the smallest Runtime-owned fix
and run its unit/contract/component gates. Only then schedule a separate
integration batch through public Controller Rebuild and Temporal retry. A child
process component pass alone is not a complete public business workflow.

### Agent session path: alternative first proposed batch

Own the first batch in ACP. Define an explicit continuation contract from a saved
user/model boundary with no unknown effects; preserve the old terminal Run and
link any new attempt rather than silently reopening it. Specify transport/SDK
semantics before adding an endpoint or UI action. Existing session load/resume
is history replay and must not unexpectedly execute Tools.

Tests must distinguish model-only interruption, completed Tool prefix, dispatched
Tool with missing result, revoked access, changed Runtime, duplicate continuation
and worker ownership loss. Unknown Tool effects retain explicit recovery/barrier
requirements. Follow with UI and cross-service integration batches only after
the ACP-owned contract and implementation gates pass. Automatic continuation is
a product behavior decision, not a consequence of adding synthetic model messages.

## Verification in this research batch

Existing ACP RunRecovery tests pass: 14 cases. The targeted Runtime Controller
Update recovery test group also passes. These are in-process tests using existing
fixtures, not new crash-process, PostgreSQL component or Docker E2E evidence.
Commands/results are private under `.cache/crash-recovery-research-20260921/`.
No production code, schema, image or development deployment changes in this batch.

The selected Runtime batch now has [component recovery evidence](runtime-crash-recovery-revalidation.md);
the subsequent [public Controller/Temporal integration](runtime-crash-integration-revalidation.md)
passes both unfinished-mutation crash windows with immutable retries and single
publication. The separate Agent Session continuation proposal is not implemented.
