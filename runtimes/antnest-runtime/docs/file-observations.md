# File Observations

This document defines the file observation metadata that the Runtime attaches
to successful builtin `read`, `write` and `edit` results. ACP consumes these
facts and maps them to standard `locations` and `diff` values without
reconstructing missing facts through extra reads or input fragments; see
[ACP protocol conformance](../../../services/agent-acp-service/docs/protocol-conformance.md).

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
into a line number. Unknown or nonrepresentable paths omit the metadata entirely.

Reads carry only `path`. Writes and edits carry either `diff` or `diffOmitted`:

- `diff` contains complete observed before/after UTF-8 text, never edit fragments.
- `oldText: null` means the pre-write observation found no file, not an empty,
  unreadable or binary file. Existing empty files use `oldText: ""`.
- `diffOmitted` is `too_large`, `non_utf8` or `unavailable`; partial text is never
  advertised as a complete diff. JSON-encoded metadata has a 32 KiB budget;
  domain capture also bounds combined text bytes before cloning and encoding.

Existing `content`, `structuredContent`, output schemas, effect classification
and progress behavior are unaffected. Full diffs travel in MCP `_meta` only,
not in model-facing output. Bash and managed MCP results are not interpreted as
file changes. No fake client terminal or additional tool call is introduced.

## Execution Boundary

The unprivileged executor observes data using the same named-root access as the
tool. Write's before-image is a bounded, nonblocking, best-effort read; failure
to inspect an existing file must not forbid a permitted replacement. Edit uses
its already-read complete source and constructed replacement. Before-images
are captured before writing, but only returned after the atomic replacement
and readback confirmation succeed. Error, cancellation-before-write and unknown
outcome replies carry no successful file observation. No post-success metadata
read may turn a confirmed write into a failure.

This is not a versioned filesystem or linearizable audit log. Concurrent shell
processes may change a path between observation, replacement and response.
Facts describe this operation's observed input and confirmed replacement, not
every intervening modification or the file's current contents. File
observations add no serialization, CAS, distributed lock or retry. The existing
unknown-outcome rules remain authoritative when readback does not match.

Domain facts have no MCP or ACP dependency. The private executor codec
transports them; the wire adapter applies the encoded-size budget before
private transport and again at the MCP metadata boundary. Metadata must not
enter log fields or OTLP attributes. Runtime does not persist a second file
history or access any service database.

The named-root parent walk opens each directory without following symlinks
before creating the next component, so a rejected path cannot create
directories through an intermediate symlink outside the root. Directory
creation is not transactional: a failed file write may leave newly created
empty parent directories. File observations describe file replacement, not an
exhaustive inventory of filesystem side effects.

The atomic writer preserves the whitespace of a parent component split from an
already normalized path. Normalizing that parent a second time could select a
different directory and falsely associate a successful result with the
requested path.

## Tests

1. Creation versus existing empty and ordinary files; full-file edit with
   unchanged surrounding text; configured workspace and system Skill absolute
   paths.
2. Missing or nonunique edit matches, canceled calls and unknown outcomes emit
   no diff.
3. Oversized, non-UTF-8 or unreadable prior contents do not invalidate a
   successful replacement; JSON escaping cannot bypass the metadata size limit.
4. The private executor codec preserves facts; official MCP HTTP returns the
   metadata while content and structured output remain unchanged.
5. A rejected path cannot create directories through an intermediate symlink
   outside the root.
6. A dual-directory case checks that parent-component whitespace never selects
   a different file, for both write and edit.

These cases live in `runtimes/antnest-runtime/src/file_observation_tests.rs`
and `tests/integration/antnest-runtime/mcp_wire.rs`, and run both natively and
in Linux Docker. `make e2e-file-observations` runs the deployment profile
described in [the ACP file observation E2E](../../../tests/e2e/acp-files/README.md),
which covers actual Runtime file operations through the Gateway and ACP v1/v2,
replay and Jaeger. `make test-file-observation-fixtures` runs its fixture tests
without Docker.
