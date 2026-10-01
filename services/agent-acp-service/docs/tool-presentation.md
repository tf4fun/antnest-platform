# ACP Tool Presentation

Status: F03 foundation, Runtime producer and ACP file fact consumer service
batches passed (2026-09-09).
Cross-service deployment acceptance also passed; its separate evidence is below.

## Contract And Ownership

The application derives presentation once, persists it with the existing Tool
events, and both ACP versions map those events to standard fields. PostgreSQL
stores facts, not Tool classification rules. No new table or RPC is needed.

| Field       | Source                                                                                   | Boundary                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`      | Exact platform Runtime Tool identity: read/read, write/edit, edit/edit, bash/execute     | Unknown and managed MCP Tools use `other`; names and annotations do not grant authorization.                                   |
| `title`     | MCP title, then deterministic builtin action/target or Tool name                         | Single line, at most 120 Unicode code points; no additional model request.                                                     |
| `locations` | Initial named workspace target; final accepted Runtime file observation takes precedence | Initial location is intent. Final location is observed; read/omitted diffs do not claim modification. No guessed line numbers. |
| `rawInput`  | Original Tool arguments                                                                  | Unchanged by presentation.                                                                                                     |
| `rawOutput` | Actual MCP `structuredContent`, as in Goose                                              | Independent of display content; absent for text-only results, transport errors and recovery-generated endings.                 |
| `content`   | Bounded output/previews plus separate standard diff from complete Runtime file facts     | Previews never become final results. File facts never become model context.                                                    |

Runtime roots are configurable. Builtin inputs now use string paths: relative,
`~/`, and the `/workspace/` tool alias resolve beneath the already-read Runtime
workspace for initial presentation, without another RPC. The alias is not a
guessed physical mount or the ACP Session's cwd. Initial System Skill locations
are omitted because Runtime information does not expose that physical root;
the `/skills/` tool alias can still appear in the title. Initial paths with
leading/trailing whitespace also omit locations rather than guessing Runtime
normalization. A valid final observation supplies the actual absolute path,
including system Skill locations and meaningful whitespace. Arguments remain
unchanged. Human-readable titles normalize NUL/invalid Unicode for display.

Structured output retains its original JSON shape, including null and false.
It is limited to the existing 64 KiB result budget (UTF-8 serialized JSON),
independently of display content. Oversized structured output is omitted, not
replaced by a fabricated raw result. Existing final content still contains its
bounded, explicitly truncated textual representation. No payload is added to
logs or spans. PostgreSQL stores raw output as escaped JSON text in the existing
event payload's `rawOutputJson` field, not as an embedded JSONB object: JSON can
contain NUL and lone surrogates which JSONB rejects. Both incremental reads and
replay decode it back to the original value. Fork copies the same stored
payload. This adapter-private encoding never reaches ACP or domain contracts;
it does not add another table or another retained copy of the raw output.
Presentation fields are not added to model context; the existing
Tool result content remains the model's source of execution output.

Recovery of an interrupted Tool updates status/content only, preserving the
initial title/kind/locations. It has no confirmed raw output to attach.

## Runtime File Fact Consumer (F03)

The Runtime producer is complete. This service-owned batch consumes only
`_meta["io.antnest.runtime/file"]` from exact platform builtin read/write/edit
identities after a successful, settled result. Malformed, conflicting, oversized
or unexpected metadata is omitted without changing the tool outcome. Other
metadata, Bash and managed MCP tools do not provide builtin file observations.
The encoded namespace envelope has the producer's 32 KiB bound; paths must be
absolute normalized POSIX paths without NUL or invalid Unicode. No guessed line
number, path rewrite, extra filesystem read or tool replay is introduced.

The domain stores one optional `file` observation with `path` and optional
`change: { before, after }`. Missing before content means creation only when
Runtime explicitly supplies null; empty strings remain empty files. Read and
documented diff omissions retain location only. Invalid diff data is never
treated as creation. Facts are not appended to model messages, rawOutput,
tool summaries, logs or OTLP attributes.

Final tool events persist the observation alongside ordinary output in the
existing session event payload. PostgreSQL uses adapter-private escaped JSON
text (`fileJson`) for the observation, preserving NUL in UTF-8 file content.
Initial target locations remain intent; the final observed location is authoritative.
Load/resume, fork and restarted application replay the same event without
calling Runtime or the model again. Recovery never invents a file observation.

The pinned official SDK distinguishes the wire formats: v1 uses a `diff` content
item with path/oldText/newText; v2 uses `changes` with add/modify plus an optional
git-style patch. Version-specific transport adapters perform this mapping; no
ACP SDK type enters the domain. Patch calculation uses the established jsdiff
library with deterministic `maxEditLength: 512` and a 64 KiB JSON-encoded patch
budget. Library-parsed patch paths must exactly match the observed old/new paths;
this excludes lossy filename formatting such as trailing spaces. NUL content,
empty creation and exhausted budgets retain structured v2 changes without
fabricating patch text or file modes. Identical existing content is not a modification.

Acceptance adds parser rejection/bounds cases, official MCP HTTP metadata
round-trip, v1/v2 schema-checked live/replay/fork/restart and identity isolation,
NUL/Unicode persistence, unchanged model history, and no extra tool calls.
The fixture-backed service tests are distinct from the subsequent
Gateway + actual Rust Runtime + Jaeger deployment evidence below.

## Deployment Boundary

Ordinary file diff needs actual complete before/after text produced by Runtime
after a successful operation. Edit parameters are fragments, not file versions.
ACP must not perform extra reads or replay edits to synthesize a diff. Failed,
cancelled or unknown outcomes must not fabricate successful modifications.

Runtime Bash is not an ACP client Terminal. Do not synthesize terminal IDs.
Runtime diff production, ACP consumption and the deployed file observation
workflow have passed their respective acceptance profiles.

Deployment evidence (2026-09-09): [reusable profile](../../../tests/e2e/acp-files/README.md)
passed 16 scenarios through Gateway ACP v1/v2 and real Rust Runtime, using 32
deterministic SSE model requests. Sixteen execution traces each contain one
preparation and one actual Tool dispatch/invocation with the correct ancestry.
Sixteen independently collected replay/fork traces contain no model or Runtime
execution. Two cross-user upgrades are rejected. The profile validates complete
diffs, empty/unchanged/oversized/error semantics, SDK schemas, parsed patch paths,
model-content isolation and content-free telemetry. Owned containers, volumes
and networks were removed without changing retained acceptance instances.

## Acceptance

1. Unit tests cover exact Tool identity, managed MCP title preservation, Unicode
   title bounds, configurable workspace paths and unknown/invalid path omission.
2. Loop and persistence tests keep structured output separate, bounded and
   absent when no actual output exists. No extra Tool execution occurs.
3. ACP v1/v2 with real PostgreSQL verify live events, reconnect/load replay,
   success/error/unknown endings, single Tool ID and cross-identity isolation.
   JSONB-incompatible keys/values must round trip unchanged through live,
   replay and fork; recovery must not replace the initial human-readable title.
4. Neither presentation metadata nor progress previews leak into model context;
   no fake diff or terminal is emitted. Existing content remains compatible.
5. Run service tests, production build and repository admission gates serially.

References: [ACP Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls),
local Goose `crates/goose/src/acp/server/tool_calls/conversion.rs` and
`crates/goose/src/acp/fs.rs` (read-only comparison).

Foundation evidence (2026-09-08): 317 unit/component cases in 41 files, 85
PostgreSQL cases in 12 files, production build and root formatting/lint gates.
Read-only reviews identified JSONB and recovery-title defects, both repaired
with regression coverage in that batch.

Consumer regression results (2026-09-09): 358 unit/component cases in 43 files
(13.98 s), 95 PostgreSQL cases in 13 files (94.08 s), including 10 new
SDK/ACP/PostgreSQL file-observation cases. Independent read-only review identified
lossy trailing-space patch paths; the regression first failed, then passed after
the path fidelity check. The reviewer is closed. Production build, repository
`make fmt-check` and `make lint` passed, without rule or test-scope relaxation.
The dedicated test database and role were removed; no new container or image
was created, existing acceptance stacks are unchanged, and no test child process
remains. The 10 new PostgreSQL cases also passed after the final lint-only fixes.
No F03 real-Runtime deployment, external Provider,
browser or Jaeger claim is made by these service tests.
