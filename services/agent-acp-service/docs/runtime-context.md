# Runtime Information And Managed MCP Tools

This document describes how each Run reads Runtime information, discovers
platform MCP tools and builds its transient model context.

Every admitted Run prepares one model input from its frozen Runtime binding:

1. Read `antnest://runtime/info` with the official MCP SDK over the existing
   Runtime Streamable HTTP endpoint. Send the admitted execution identity and
   active W3C trace context with RC-issued per-instance ACP authority. The full
   public connection reference is frozen in the Run; the bearer stays only in
   ACP's volatile sender file and is reread for every SDK request. Force a fresh
   read, not an SDK/session cache hit. See [Runtime instance authority](operations.md#runtime-instance-authority).
2. Validate the resource URI, bounded JSON structure, and returned execution ID.
   Runtime startup configuration (commands, arguments, environment, credentials)
   is not an information field. A failed/mismatched read fails setup before any
   model call or tool effect; cancellation/deadline interrupts setup normally.
3. Discover platform Runtime MCP tools once for this Run. Managed stdio
   children are already represented by Runtime's `mcp__<server>__<tool>` tools.
   ACP never launches a child or invents a per-child HTTP endpoint.
   Opt-in [Skill discovery tools](../../../contracts/agent-acp/skill-discovery-tools.md)
   are appended as explicit ACP platform definitions, alongside the local plan
   tool. Reserved-name conflicts fail preparation. They are dispatched to the
   configured Registry with persisted Run authority, rather than Runtime MCP.
   Multi-file load then uses the signed private temporary endpoint, following
   the [temporary Skill consumer contract](../../../contracts/agent-acp/skill-temporary-consumer.md); ordinary
   read/Bash can use confirmed files. Pending cleanup fences new Run/learning
   work and lifecycle settlement, including after ACP restart.
4. Prepare a transient system message from the Agent prompt, Runtime environment,
   workspace `AGENTS.md`, and system/personal Skill summaries with read locations.
   Full Skill documents are loaded by the Agent using `read` when needed. These
   materials are never appended to chat events, history, or compaction summaries.
5. Reserve output capacity and tool schema cost before fitting context. Runtime
   information has a bounded share of the input budget, with explicit omission
   notices; history compaction remains atomic by complete Tool exchanges. Check
   the full model input before each subsequent model request as results grow.
   Retain the workspace guidance locator before budgeting Skill entries, and
   omit metadata only at complete-entry boundaries. Token cost uses the Model
   tokenizer (128-unit chunked exact encodings or the UTF-8 byte bound), scaled
   by the seeded p95 calibration ratio with a 1.05 safety margin. Optional Runtime
   guidance receives a quarter of the raw input budget in the same token units;
   mandatory guidance locators remain protected. Compaction
   pins system instructions, the persisted original task (`source.pinned` IDs
   recorded in checkpoint metadata) and the newest complete Tool exchange,
   summarizes the dropped middle through a bounded prompt (`context-summary-v1`)
   on the frozen compaction or primary Model, and falls back to a deterministic
   previous-summary-first mechanical summary only on ordinary provider failure.
   Both generated and fallback summaries occupy at most 15% of the input budget.
   Cancellation, budget and persistence errors are never swallowed. Compaction
   and foreground calls share the Run request budget and deadline, and a
   `context_overflow` with no emitted output retries exactly once.
6. Call selected Runtime tools through the same bound endpoint and original MCP name.
   Structured results remain available to the model. An ordinary MCP error
   result is a returned outcome; a transport timeout/cancellation does not prove
   an outcome and must not trigger blind replay.

Guidance/Skill changes are observed at the next Run even without a new Runtime.
Explicit rebuild changes the admitted binding and therefore both the information
read and tool discovery target. Processes are Runtime-owned and may span turns
and Runs. Closing an ACP-side HTTP client does not stop managed stdio children.

## Boundaries And Observability

The [shared information schema](../../../contracts/runtime/runtime-information.schema.json)
is the wire contract. ACP owns its validated read model and model-input budget,
not deployment configuration, Skill publication, or process supervision.
Runtime information adds no tables, ACP fields or external endpoints, and does
not change ACP v1/v2 semantics.

Builtin tools use the [shared flat input contract](../../../contracts/runtime/builtin-tools.schema.json).
Runtime information retains typed root/path identities internally; the transient
model context renders them as `/workspace/...` or `/skills/...` string locators.
These are Runtime tool aliases, independent of the configured physical mounts.
Personal Skill maintenance reads use the same public string path and a 1-based
line offset, while still checking complete content and the 16 KiB byte bound.
The completed-Run learning scan recognizes successful public
`read` calls to `/skills/NAME/SKILL.md` or personal Skill paths under
`.antnest/skills/NAME/SKILL.md`, including `/workspace/` and `~/` aliases.
It still requires a completed Runtime attempt in the immediately preceding
completed Run; ordinary documents and rejected legacy object arguments cannot
count as prior Skill use.

Runtime information reads have an `mcp.runtime.info` client span beneath the Run
trace, carrying admission/execution identifiers and outcome, not document content
or credentials. Existing tool list/call spans now own their exact connection's
discovery-ready, dispatch-started, parsed-result and awaited-close receipts,
following the [shared lifecycle contract](../../../docs/observability-contract.md#acp-runtime-tool-connection-lifecycle).
Discovery readiness is the SDK's parsed result, not HTTP EOF. Tool errors,
unknown effects, caller cancellation and failed cleanup remain separate facts;
parsed responses do not establish Runtime quiescence. Direct/uninstrumented or
disabled/no-op paths cannot attach these receipts to an ancestor. No tool
arguments or returned content are recorded. Runtime
HTTP handling and its non-root executor inherit this trace. Egress packet
forwarding intentionally has no OTLP spans.

## Verification

Tests inspect actual model messages and declared tools, fresh per-Run reads,
budget/truncation, malformed resources and execution mismatch, cancellation,
history exclusion, and official SDK resource transport. Docker integration proves
Agent configuration to Runtime child invocation and Gateway-rooted Jaeger traces;
unit tests alone do not establish that full workflow.

`node tests/e2e/agent-acp-service/runtime-information-docker.mjs` runs the
information and tool lifecycle probes sequentially in the same candidate
production image. The tool probe retains original OTLP and actual peer request
identities for list/call success, tool error, HTTP error and caller cancellation.
It holds discovery EOF until the tool request arrives, then awaits the actual
discovery export before releasing the tool reply. Its controlled MCP peer proves
ACP producer behavior; Session consumer admission and the real Runtime workflow
remain separate integration gates.

Prior deployment evidence used the retired Gateway ACP/state routes. That
recorded coverage remains historical. Gateway 24 requires a separate consumer
migration: browser journeys through the retained Agent UI Bridge and protocol
assertions through authenticated private ACP. This ACP owning batch does not
admit that cross-service workflow or its capacity gate.
