# Historical ACP closeout entry migration

Recorded: 2026-09-21, on source baseline `6827ddd`. This is the first delivery
batch for the remaining historical consumers, following the
[migration contract](../scripts/acp-closeout/migration-contract.md). Production
services, dependencies, clocks and export intervals are unchanged.

## Current entry and historical scenario mapping

`make e2e-acp-closeout` and the existing `ANTNEST_E2E_ACP_CLOSEOUT=true` selector
now run a normal-request profile directly, without the legacy Stage 3 setup.
Provider/Model APIs, returned Template revisions, immutable Runtime images and
ACP-owned Run/Tool/history records replace retired revision/admission assumptions.
The disposable deployment uses synthetic configuration, private Temporal ports,
isolated network ranges and bounded cleanup. It does not load retained `.env`.

Both installed ACP SDK versions cover two members of the same organization:
one owns two Agents and the other owns a third. A successful authenticated
upgrade is followed by an actual ACP authorization check. Five foreign Session
methods in both directions distinguish another principal from another Agent.
Each denied operation must preserve all ACP Session/Run/Tool/message/MCP rows,
model requests and notification counts exactly.

Positive execution uses actual Bash append/read results with one exact physical
effect per Run. The model rejects foreign Session context and repeat effects.
Fresh replay is checked against ordered public audit events and stored Session
metadata, while identical MCP configuration must leave all ACP rows unchanged.
Actual JSON-RPC request IDs and internal execution request IDs are distinct:
the request Trace must identify the observed JSON-RPC message and contain the
exact durable Run ID from the ACP snapshot.

Global owner deactivation rejects prompts on both existing connections with
Gateway 1008, creates no execution intent, and automatically disables both
owned Agents. The other owner's Agent, history and real workspace sentinel
remain intact. Restoring the user leaves both Agents disabled until explicit
Enable; Enable preserves workspace bytes and private history and permits new
execution. Each automatic Disable retains its source Identity event, exact
Temporal workflow, committed activity SQL and publication/settlement evidence.

The four historical completed/model-held/settled-Tool/in-flight-Tool crash cases
remain in the separately opted-in `make e2e-acp-restart` profile. Its
[P2 evidence](acp-persistence-revalidation.md) is not rerun or replaced by normal
closeout. P1 committed-response loss remains separate too. Normal closeout no
longer invokes the historical mixed SIGKILL client. Old source files and shared
helpers remain for the later dependency and retirement review.

## Final scoped evidence

Disposable project `antnest-stage3-e2e-27659` passed:

- Both SDK versions, eight completed real Bash Runs and 16 Provider requests.
- Eight denied Agent requests, 40 same-organization foreign Session commands,
  and four revoked-connection prompts, all without private notifications or
  durable/model side effects.
- Four automatic Disable checks and 14 exact private-history replays, including
  the unaffected owner and explicit recovery of both revoked Agents.
- 94 scoped Trace topology/privacy checks over 92 archived traces. Each global
  deactivation source is shared by its two Agent workflows. Normal completed
  requests wait for full evidence before stable export; no spans are rewritten.

Strict status remains failed on 80 checks. Deliberate rejection paths retain
108 error spans; all raw Jaeger warnings are preserved. The final Docker command
therefore exits nonzero. This is business/topology acceptance, not full strict
observability acceptance.

824 applicable local unit, contract and component checks passed serially with
zero failures or skips. The earlier broad test selection separately skipped
five P1 PostgreSQL fault tests without their dedicated database; those unchanged
fault scenarios are outside this normal-request batch. Negative fixtures reject
transport failures masquerading as access denials, extra error data, stale or
foreign metadata, repeated effects, foreign model context and wrong Run binding.

Two earlier attempts remain failed fixture runs: `26808` exposed a missing test
client Runtime-network attachment; `27198` exposed the incorrect equality of
wire and internal request IDs. Both were corrected without changing production
services, and the final full run above passed its business/topology checks.

## Cleanup and pending consumers

All three temporary projects have no owned containers, networks or volumes
remaining, and no verification child processes remain. The 12 retained
container IDs, image IDs, health and running/stopped
states match this run's baseline. OrbStack was initially stopped and was started
to run the disposable profile; after startup, the retained baseline contained
one running container and 11 stopped containers. This batch does not claim a
fresh healthy retained-development deployment or start those stopped services.

Private client/deployment snapshots and raw traces are in
`.cache/acp-closeout-normal/antnest-stage3-e2e-27659/`. Coordinated logs, negative
and final tests, baseline and cleanup evidence are under
`.cache/legacy-closeout-20260921/`. These ignored artifacts are not published.

Lifecycle foundation/drain and its shutdown, network, health, restore, loss and
interrupted-update consumers, older Workspace protocol/manual-browser flows,
and retained/extended Stage 3 branches still require their own migration and
Docker evidence. Complete those batches and combined regression before broad
shared-asset retirement; this report does not accept them indirectly.
