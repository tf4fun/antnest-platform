# Runtime information and managed MCP tools

Every admitted Run prepares one model input from its frozen Runtime binding:

1. Read `antnest://runtime/info` with the official MCP SDK over the existing
   Runtime Streamable HTTP endpoint. Send the admitted execution identity and
   active W3C trace context. Force a fresh read, not an SDK/session cache hit.
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
   [D4A](../../../contracts/agent-acp/skill-temporary-consumer.md); ordinary
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
   omit metadata only at complete-entry boundaries. Token cost remains the
   existing approximate character estimate, not an exact model tokenizer.
6. Call selected Runtime tools through the same bound endpoint and original MCP name.
   Structured results remain available to the model. An ordinary MCP error
   result is a returned outcome; a transport timeout/cancellation does not prove
   an outcome and must not trigger blind replay.

Guidance/Skill changes are observed at the next Run even without a new Runtime.
Explicit rebuild changes the admitted binding and therefore both the information
read and tool discovery target. Processes are Runtime-owned and may span turns
and Runs. Closing an ACP-side HTTP client does not stop managed stdio children.

## Boundaries and observability

The [shared information schema](../../../contracts/runtime/runtime-information.schema.json)
is the wire contract. ACP owns its validated read model and model-input budget,
not deployment configuration, Skill publication, or process supervision.
There are no new tables, ACP fields or external endpoints in this feature.
Existing ACP v1/v2 semantics are unchanged.

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
or credentials. Tool list/call spans retain existing instrumentation. Runtime
HTTP handling and its non-root executor inherit this trace. Egress packet
forwarding intentionally has no OTLP spans.

## Acceptance

Tests inspect actual model messages and declared tools, fresh per-Run reads,
budget/truncation, malformed resources and execution mismatch, cancellation,
history exclusion, and official SDK resource transport. Docker integration proves
Agent configuration to Runtime child invocation and Gateway-rooted Jaeger traces;
unit tests alone do not establish that full workflow.
