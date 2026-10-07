# ACP Skill discovery tools

This is the ACP-owned catalog and dispatch contract for the model tools
`find_skill` and `load_skill`, which consume
[Registry discovery v1](../skill-registry/discovery-api.md). Tool inputs use
`find_skill_input` and `load_skill_input` in its shared schema. Runtime file
delivery has a separate [contract](../runtime/temporary-skills.md), and the ACP
[temporary consumer contract](skill-temporary-consumer.md) defines installation
and durable cleanup.

## Catalog and authority

When the paired Skill discovery configuration is enabled, ACP appends two
platform tools to the Runtime catalog. Their identity is `source=agent`,
`sourceId=skill_registry`, with model names `find_skill` and `load_skill`.
These names are reserved: any colliding Runtime definition rejects preparation;
they are never dispatched to `tools/call`. The existing `update_plan` path is
restricted to `source=agent, sourceId=plan, name=update_plan`.

`find_skill` carries `readOnlyHint=true`; `load_skill` carries
`readOnlyHint=false` because it may deliver files. Both obey ordinary Session authorization,
including explicit deny rules and permission interaction. Chat mode exposes no
tools. They grant no publication, template mutation or permanent installation, and
they add no Agent or Template configuration.

ACP derives organization, actor and target Agent from the persisted active Run
and its Session, checks that its execution snapshot matches, and checks current
Controller-projected access before and after the Registry request. Model inputs
cannot supply tenant, actor, source URL, credential or output path. Removed or
changed authority discards the result. Each Run allows at most eight search
attempts and four load attempts, including failed dispatched attempts; these
counts use durable tool attempts, not an unbounded process-local map. Normal
Run deadline/cancellation and ownership cancellation bound every request.

Foreground searches add `requesting_agent_id` from that authorized persisted Run
to the trusted Registry request. This excludes the caller's own personal source
projections before limit selection/inspection, preventing a self-read through
the idle maintenance gate. The model's strict `find_skill_input` does not accept
this field. Local Skills use ordinary Runtime reads; formal versions and other
authorized Agent sources remain searchable. UI source preview has no foreground
Run and omits this context. Registry applies the exclusion; ACP derives the
value. Foreground loads propagate the Trace parent through Registry to the
source read.

## Results and temporary text use

`find_skill` returns the bounded Registry `items` shape. A zero-hit successful
result is distinct from `source_unavailable` or Registry transport failure.
Search metadata is not permission to fetch a source: every load checks again.

`load_skill` binds the selected `skill_ref` and `expected_digest`. ACP checks
the ZIP size, HTTP length/type/digest headers, actual artifact SHA-256, bounded
entry sizes/CRC and complete canonical content manifest. The Registry remains
the package-rules-v1/YAML authority. Responses expose the exact `SKILL.md` text,
the selected ref, content/artifact digests and `requires_runtime_delivery`.
`temporary_files` is null for text-only packages; for multi-file packages it is
a usable path only after ACP validates a real Runtime install receipt. Multi-file bytes are request-local, never a
durable discovery cache. See its consumer contract for dispatch and cleanup.

Loaded text enters the current Run's ordinary tool result/context, subject to
system guidance and ordinary tool permissions. Source updates do not rewrite
already returned bytes. This does not copy a source into Registry custody,
register a personal Skill, mount another Agent's volume or alter `/skills`.
Durable conversation tool results keep the existing retention policy; packages
are not retained by ACP discovery after the bounded request completes.

## Failure, recovery and Trace

Errors are bounded tool results with fixed messages and codes. Stale selections
return `content_changed`; inaccessible/missing sources return `not_found`.
Malformed upstream bytes/headers return `source_invalid`; outages remain
`source_unavailable`; budget exhaustion is `discovery_budget_exceeded`.
Caller cancellation closes I/O. Search/text reads have no mutable effect.
Temporary file installs preserve settled or unknown Runtime effects, and a
persisted temporary scope requires confirmed cleanup before subsequent
admission. The read-only recovery shortcut applies only without a temporary
scope.

Normal durable tool attempts include the platform identity. Interrupted pure reads
settle as failed with `tool_effect_state=none`; interrupted temporary loads use
the scope's pending/closed evidence. Runtime/client MCP attempts keep
their existing conservative recovery. Trace spans `skill.discovery.search` and
`skill.discovery.load` record Run, organization, source ref/digest and outcome.
They exclude queries, bodies, packages, dialogue, source URLs and credentials.

Coverage includes service unit and contract tests, real HTTP and PostgreSQL
components, and a deployed deterministic model choosing these tools in a real
Run. Cross-Agent temporary file use, promotion and Template/rebuild propagation
are covered by the `make e2e-skill-deployment` Docker E2E target.
