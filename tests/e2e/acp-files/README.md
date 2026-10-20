# ACP file observation E2E

This scenario verifies the real Runtime's builtin write, edit and read Tools
through private ACP v1/v2 WebSocket connections on a disposable full stack.

## Running

Run serially. The parent builds eleven independent release candidates from the
current source and selects their exact image IDs with the admission override:

```sh
make test-file-observation-fixtures
make e2e-file-observations
```

The profile uses one PostgreSQL instance with service-owned databases, ignores
local `.env`, removes host Temporal ports and allocates isolated network ranges.
It needs no external Provider, browser or cross-service SQL. Test containers
have no Docker socket. The host performs deployment inspection and a final
read-only file copy; all business file operations use the real Runtime MCP.

## Workflow

Users, a Provider connection and Model, a Template referencing the Model's stable
identity, and both Agents are created through Gateway and Admin Console APIs.
After executable readiness, the private ACP connections use the original login
Principal, Identity-issued workspace CCT and read-only Agent UI→ACP service grant.
An authenticated upgrade alone does not authorize Agent access. Two cross-user
session creations must return the exact `access_denied` error without updates.

Each protocol runs eight ordered cases in one Agent workspace: creation,
full-file edit, read, empty creation, replacing an empty file, unchanged edit,
oversized write with an omitted diff, and failed edit. Each case uses a fresh
Session, exactly one Tool invocation and two model requests. A deterministic SSE
model checks the real results; it cannot fabricate MCP results or ACP events.

The original connection is closed and joined before a new connection loads or
resumes the stream, forks it and replays the fork. All Tool IDs, facts and order
must reproduce the live stream without another Run, model request or Tool call.
The full inventory is 16 Runs, 32 model HTTP requests, 16 actual file Tools,
48 replay/fork requests, 16 successful new Sessions and two denied creations:
82 business RPCs plus 34 separately inspected initialize RPCs.

## File observations and physical evidence

- Official pinned SDK schemas validate live and replay updates. v1 contains
  complete before/after text; v2 contains changes and a Git patch where
  representable. Parsing and applying the patch must recover the exact path and
  content, including Unicode, quotes and a parent directory ending in a space.
- Creation differs from replacement of an empty file. Location-only, unchanged
  and oversized observations must not fabricate a diff; an initial intent must
  not claim a completed modification. Failed edit must have failed Tool status
  and no observed location or diff.
- File metadata must not enter model-facing Tool output or telemetry. Actual
  read output and explicit write arguments naturally include file text. The
  model records the actual parsed Tool result and validates its original call
  ID, tool, arguments and call-before-result ordering.
- Before deleting either Agent, the client waits for a host acknowledgement.
  The host binds both running Runtimes to Agent, generation, project/run and
  candidate image ID, then copies the failed-edit target from each verified
  container ID using one literal path argument. Links, missing files, changed
  bytes, stale receipts, copy failures and cancellation cannot receive an ACK.
- The copied bytes must exactly equal the model's earlier complete read and
  the scenario's expected edited content. This proves equality between the
  final observation after failed edit and the most recent complete read before
  it; it does not prove there were no transient writes between observations.
  Both original model receipts and copied files remain private evidence.

## Trace checks

Each actual SDK wire request selects its private CLIENT→upgrade→RPC boundary.
Fork input and returned Session IDs are bound separately. Each Run requires
committed PostgreSQL persistence, fresh Runtime information and catalog reads,
one ACP Tool dispatch, one Runtime Tool and its executor. Real model HTTP IDs
bind both model invocations to their Run, before and after that dispatch. The
Runtime generation must match the host's pre-deletion inspection.

Replay, fork, successful new Session and denial requests are inspected without
model-derived discovery. Replay may refresh the Runtime Skill catalog with at
most one `discover` and one `resources/read`; executable calls are forbidden.
Denied requests cannot read a catalog. Missing, ambiguous or detached parents,
foreign links, unaccounted diagnostics and incomplete inventories fail.

After connection cleanup and Agent deletion flush telemetry, the collector saves
complete raw query bytes and requires three stable samples. Content sentinels
and synthetic credentials must be absent from exported Traces. Every raw error
must have exact ownership: deliberate `old_string_not_found` records, denied
requests or the proven completed-read/Tool HTTP disconnect. No error is removed
from the archived raw diagnostics. Sampling cannot exclude arbitrarily late
telemetry; this consumer does not verify metrics or all container stdout.

Raw strict failures and warnings are preserved. Exit 0 means strict success;
exit 2 retains fully explained diagnostics with valid business/topology;
unknown diagnostics or business/cleanup failures exit 1. CI runs the parent
script directly so Make cannot collapse the distinction. The same-Node SDK
endpoint observation is limited to strictly less than 1 ms and does not waive
cross-process clock warnings or missing telemetry.

## Cleanup and evidence

Evidence lives under `artifacts/verification/acp-files/<project>/`, never cache.
Model input receipts, live frames, wire inventories, original inspection, copied
files and raw queries are private. Public summaries exclude original file text
and credentials; deployment failures report bounded classifications.

The client joins connections and telemetry and attempts cleanup of every Agent,
preserving failures. The parent removes owned containers, volumes, networks and
recorded candidate tags on success or failure without adopting other images.
Client evidence writes use the host owner and exactly two read-only grants.
Short Docker probes have a 30-second limit; Compose startup uses the remaining
15-minute profile budget. Cleanup has its own bounded allowance.
