# File Observations (F03 Producer)

Status: producer service-level acceptance passed, 2026-09-09. This document defines the Runtime
producer contract. ACP consumption and deployed Gateway acceptance are separate
batches; no ACP implementation changes belong here.

Subsequent integration also passed on 2026-09-09: the
[F03 deployment profile](../../../scripts/acp-files/README.md) covers actual
Runtime file operations through Gateway/ACP v1/v2, replay and Jaeger. The
producer-only evidence below remains distinct from that deployed workflow.

## Contract

Successful builtin `read`, `write` and `edit` can return:

```json
{
  "_meta": {
    "io.antnest.runtime/file": {
      "path": "/workspace/notes.txt",
      "diff": { "oldText": "before\n", "newText": "after\n" }
    }
  }
}
```

`path` is the absolute target derived by Runtime from its configured named root
and the same path normalization as execution. It is neither a client path nor a
file URL. Both workspace and system Skill roots are supported for reads. It is
an associated target, not a stable inode identity. No byte offset is guessed
into a line number. Unknown/nonrepresentable paths omit the metadata entirely.

Reads carry only `path`. Writes/edits carry either `diff` or `diffOmitted`:

- `diff` contains complete observed before/after UTF-8 text, never edit fragments.
- `oldText: null` means the pre-write observation found no file, not an empty,
  unreadable or binary file. Existing empty files use `oldText: ""`.
- `diffOmitted` is `too_large`, `non_utf8` or `unavailable`; partial text is never
  advertised as a complete diff. JSON-encoded metadata has a 32 KiB budget;
  domain capture also bounds combined text bytes before cloning/encoding.

Existing `content`, `structuredContent`, output schemas, effect classification
and progress behavior remain unchanged. Full diffs travel in MCP `_meta` only,
not model-facing output. Bash and managed MCP results are not interpreted as
file changes. No fake client terminal or additional tool call is introduced.

## Execution Boundary

The unprivileged executor observes data using the same named-root access as the
tool. Write's before-image is a bounded, nonblocking, best-effort read; failure
to inspect an existing file must not forbid a permitted replacement. Edit uses
its already-read complete source and constructed replacement. Before-images
are captured before writing, but only returned after existing atomic replacement
and readback confirmation succeeds. Error, cancellation-before-write and unknown
outcome replies carry no successful file observation. No post-success metadata
read may turn a confirmed write into a failure.

This is not a versioned filesystem or linearizable audit log. Concurrent shell
processes may change a path between observation, replacement and response.
Facts describe this operation's observed input and confirmed replacement, not
every intervening modification or the file's current contents. This batch adds
no serialization, CAS, distributed lock or retry. Existing unknown-outcome rules
remain authoritative when readback does not match.

Domain facts have no MCP/ACP dependency. The private executor codec transports
them; the wire adapter applies the encoded-size budget before private transport
and again at the MCP metadata boundary. Metadata must not enter log fields or OTLP attributes.
Runtime does not persist a second file history or access any service database.

## Acceptance

1. Creation versus existing empty/ordinary files; full-file edit with unchanged
   surrounding text; configured workspace and system Skill absolute paths.
2. Missing/nonunique edit match, canceled calls and unknown outcomes emit no diff.
3. Oversized/non-UTF-8/unreadable prior contents do not invalidate a successful
   replacement; JSON escaping cannot bypass the metadata size limit.
4. Private executor codec preserves facts; official MCP HTTP returns metadata
   while its content/structured output remains unchanged.
5. Native tests and Linux Docker tests both run. The coordinator alone executes
   tests/build/lint, cleans temporary containers and preserves existing instances.
6. The ACP consumer maps these facts to standard `locations`/`diff` without
   reconstructing missing facts using extra reads or input fragments. Its
   service and deployed F03 evidence is recorded in
   [ACP conformance](../../../services/agent-acp-service/docs/protocol-conformance.md).

The related named-root parent walk now opens each directory without following
symlinks before creating the next component. The regression fixture proves a
rejected path cannot create directories through an intermediate symlink outside
the root. This is not transactional directory creation: a failed file write may
leave newly created empty parent directories. File observations describe file
replacement, not an exhaustive inventory of filesystem side effects.

The atomic writer also preserves the whitespace of a parent component split
from an already normalized path. Normalizing that parent a second time could
select a different directory and falsely associate a successful result with the
requested path. A dual-directory regression covers both write and edit.

Final verification: 89 portable native tests; 126 Linux module/contract tests
plus one real UID 1000 executor subprocess integration test; Linux release
build, native/Linux Clippy (`-D warnings`), repository `make fmt-check` and
`make lint` passed. Read-only review findings were reproduced with failing
tests, fixed, and rechecked. This is producer evidence, not ACP consumption or
Gateway/Jaeger deployment evidence. Reviewers are closed and no acceptance
instance was replaced.
