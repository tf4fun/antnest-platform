# ACP access E2E

This scenario verifies ACP Session access control and owner offboarding through
private ACP v1/v2 connections and real Gateway/Agent UI browser streams on a disposable full stack. The [contract](migration-contract.md)
defines what it must prove. This directory also holds shared ACP fixture
helpers used by other E2E scenarios.

## Running

```sh
npm --prefix services/agent-acp-service ci
make e2e-acp-closeout
```

`make e2e-acp-closeout` is equivalent to
`ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3-local`. It requires Docker and
the local Stage 3 images (`make docker-build-stage3`). The profile uses the
current Provider, Model and returned Template revisions, an immutable Runtime
image, isolated network ranges and private synthetic configuration. It does not
read the operator's `.env`. Only the model is deterministic; no external
Provider or credential is needed. The fixture tests run as part of `make test`
(`node --test tests/e2e/acp-closeout/*.test.mjs`).

## Scenario

For both ACP SDK versions, the profile creates two Agents owned by one member
and one Agent owned by another member of the same organization.

- Real Bash effects and the exact public audit history establish positive
  access first. All five Session methods are then tested against foreign
  Sessions in both directions. Denials must identify the correct principal or
  Agent boundary, emit no notifications, and change no ACP rows or model
  activity. An authenticated WebSocket upgrade is not authorization: ACP must
  return the precise Agent denial.
- After the owner is deactivated globally, the two original browser SSEs must
  close remotely, and original-Cookie HTTP prompts must return 401 or the exact
  non-retryable Agent 403. The private SDK connections are then explicitly joined;
  four local post-close probes must reject without adding any wire request.
  Both owned Agents Disable automatically. The other member keeps access and history.
- Restoring the owner must leave the Agents disabled. An explicit Enable
  preserves real workspace sentinel files and the earlier private history, and
  then permits a fresh Run.

The original inventory is 30 initialized private connections and 86 business
requests: eight completed Bash Runs, 14 replays, eight lists, eight Agent denials
and 40 Session denials, plus eight new Sessions. The four local post-close
probes are separate from this inventory. Lists use a database snapshot taken
before the actual request; receipts and model calls are preserved without rewriting.

Global User loss has its own cause proof: the original system-admin
`active=false` request, Identity's committed User/token/audit/principal-feed/session-feed
transaction, the Controller's original owner User/global scope/sequence event,
and each browser's original organization/Membership feed witness. Session-feed
rows follow the revoked token count, not the number of Agents. This does not
claim closure of Agent UI's shared private owners.

Completed, replayed and rejected requests are checked against their message
Trace identities and the current ACP audit. Full topology and privacy checks
run before stable export. Raw Traces remain private; original strict warnings
and rejection-error findings are retained as auxiliary diagnostics. Business,
authorization, Run persistence, Runtime behavior, cancellation and actual cleanup
remain blocking checks. This policy does not claim that every historical profile
has completed its implementation migration.

Evidence is written under `artifacts/verification/acp-closeout-normal/<project>/`.

The normal profile never kills ACP. Crash recovery is covered by
[ACP restart](../acp-restart/README.md) (`make e2e-acp-restart`), persistence
faults by [ACP persistence components](../../integration/agent-acp-service/support/persistence/README.md), and cross-organization
access, SCIM and cross-organization offboarding by `make e2e-agent-access`.

## Fixture rules

- The official ACP SDK is the client, and assertions use version-specific
  completion and replay methods.
- Upgrade rejection and late WebSocket errors belong to the fixture connection:
  they must reject its pending operation rather than escape as unhandled
  process errors that bypass diagnostics. Business, cleanup and evidence-write
  failures are retained together, and all resources are joined.
- Requests use the SDK's `cancellationSignal` plus a bounded local wait that
  closes an unresponsive connection. HTTP 503 is a failed test, never an
  implicit successful retry.
- Read-only queries against the ACP database corroborate replay and recovery.
  No fixture writes another service's tables; Controller state is read through
  its read-only event API and the administrator event projection.
- Session setup and replay may send the standard command catalog. The catalog
  is validated separately from durable history. Revoked or foreign operations
  must not add or change notifications after the observed setup boundary.
  Unexpected input, Tool or usage output, foreign Sessions and duplicate
  catalogs are rejected.
- New Sessions must have no execution state; SDK v2 empty-Session recovery must
  replay exactly one idle state.
- Tool input is compared with the database's JSON-text encoding, including
  escaped characters. Tool identity and output are checked against persisted
  events and the actual Bash result, not the Provider's response-local ID.
- Container completion uses one successful Status and ExitCode snapshot; an
  inspection failure cannot turn a still-running client into a passed result.

## Shared helpers

`client.mjs`, `support.mjs`, `connection.mjs`, `checkpoint.mjs`, `network.mjs`,
`docker.mjs`, `replay.mjs`, `uncertain.mjs` and related modules are imported by
other scenarios (`acp-restart`, `acp-cost`, `acp-plan`, `acp-commands`,
`acp-permissions`, `acp-multimodal`, `stage3-base`):

- `docker.mjs` is the host-side Docker wrapper. Fixture clients have no Docker
  socket; only the host coordinator stops or restarts containers.
- `checkpoint.mjs` publishes JSON checkpoints atomically by same-directory
  rename, so a file's existence never exposes an incomplete request. Fixed
  sleeps are never treated as evidence of execution.
- `network.mjs` selects management and control subnets against Docker's
  existing IPAM allocations, including enclosing subnets. Discovery failure or
  exhaustion aborts before provisioning. This is allocation for a single
  coordinating test process, not a reservation protocol for concurrent suites.

## Cleanup

The entry script runs only inside a disposable `antnest-stage3-e2e-<n>` project
and refuses `ANTNEST_E2E_KEEP_STACK=true`. On exit or interruption it saves the
client and model logs, removes the fixture client and model containers, and the
parent removes every container, volume and network of the project.

## Access business admission

The current Access profile independently checks persisted Runs, model calls,
Agent and Session isolation, original directory mutation and browser authority,
remote closure and the subsequent scoped HTTP denial. Automatic Disable requires
original Agent, Runtime, event and completed operation receipts. These checks and
actual resource joins remain blocking. Trace collection, diagnostic headers and
exporter failures use one shared 60-second auxiliary budget, preserve original
findings, and never turn an unexecuted collection into a pass. Business success
is reported only after cleanup completes. Full merge admission runs in remote CI.
