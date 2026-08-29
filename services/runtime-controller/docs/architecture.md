# Runtime Controller Architecture

## Mission

Convert durable Runtime intent into one observable Runtime generation,
then provide a fenced path for an internal caller to perform work through that
generation. Everything else is outside this service.

## Core Model

The service models four distinct concerns:

1. **Runtime**: desired specification and latest observed lifecycle state for
   one stable `agent_id`.
2. **Generation**: immutable incarnation of Runtime compute. Replacement creates
   a larger generation instead of mutating the running container in place.
3. **Lifecycle operation**: durable command that reconciles a generation toward
   Ready, Stopped, Retired, or Purged.
4. **Work lease**: one exclusive `(work_id, work_epoch, work_session_id)` used to
   fence process and file effects within a Ready generation.

Lifecycle state and Work state are deliberately separate. A Runtime can be
Ready without an active Work lease; Work cannot begin unless the current
generation is Ready and connected.

## Request Paths

### Lifecycle mutation

```text
HTTP handler
  -> application.Service validates intent and idempotency
  -> PostgreSQL transaction records operation and desired state
  -> signal queue wakes reconcile worker
  -> Reconciler claims the operation before external side effects
  -> Egress and Runtime Provider clients apply external resources
  -> Runtime reverse connection passes generation admission
  -> observed state and operation converge in PostgreSQL
```

The queue is only a latency hint. Startup scans durable PostgreSQL state, so a
lost signal does not lose work. An external effect reports `completed`,
`not_started`, or `unknown`; `unknown` is observed later and never replayed as
if it were known not to have started.

### Work operation

```text
HTTP Work handler
  -> application.WorkService resolves current Ready generation
  -> persisted Work epoch/session fencing
  -> runtimeconn selects the admitted reverse connection
  -> JSON-RPC request to Rust Runtime
  -> completed / not_started / unknown result returned unchanged
```

The Controller coordinates and records the effect. The Rust Runtime performs
the effect.

## Package Map

| Package | Responsibility | Must not absorb |
| --- | --- | --- |
| `domain` | Runtime, generation, operation, lifecycle, and effect-state rules | SQL, HTTP, Docker, transport |
| `application` | Lifecycle and Work use cases over narrow ports | Adapter-specific models |
| `postgres` | Schema migration and durable repository implementation | Lifecycle decisions outside transactions |
| `reconcileworker` | Durable work scanning, claiming, retry delay, queue hints | Resource-specific Docker policy |
| `runtimeprovider` | Map lifecycle effects to the Docker Provider HTTP contract | Docker implementation details |
| `egressclient` | Apply reservations and issue short-lived tunnel claims | Packet forwarding |
| `admission` | Derive and verify generation-bound bootstrap tokens | User authentication |
| `runtimeconn` | Reverse control sessions and JSON-RPC dispatch | Runtime lifecycle ownership |
| `runtimeprotocol` | Controller-side wire types and validation | Business records |
| `httpapi` | Parse/encode the internal API and Problem Details | Business branching that belongs in application |
| `config` | Validate process environment | Runtime desired state |
| `telemetry` | Logs, traces, metrics plumbing | Control flow |

`cmd/runtime-controller` is the composition root. It may import all adapters;
adapters must not import the composition root or each other to bypass an
application/domain contract.

## Persistence Ownership

PostgreSQL stores only facts needed to recover lifecycle and Work fencing:

- Runtime desired and observed state.
- Immutable Runtime generations.
- Durable lifecycle operations and idempotency identity.
- Work epoch/session fencing needed across process restarts.

No other service may read or write these tables directly. Future Agent Controller
code calls the HTTP contract instead.

## Invariants

1. `agent_id` is the stable identity; container and workspace names derive from
   it.
2. Generations are positive, immutable, and monotonically increasing per Agent.
3. Only the desired generation may be admitted or Ready.
4. At most one non-terminal lifecycle operation exists per generation.
5. A running or `unknown` operation cannot be superseded by new intent.
6. Reusing an idempotency key with different input is a conflict.
7. An `unknown` remote side effect is never silently retried.
8. Runtime connection epochs and persisted Work epochs fence stale callers.
9. Network-mode changes replace the generation rather than pretending that
   container bootstrap state can be updated in place.
10. Provider resource names and labels are deterministic and observable.
11. Controller has no Docker socket, TUN device, or network administration capability.

## Extension Rules

- Add a lifecycle state only after defining its durable transition, Provider
  observation, restart recovery, idempotency behavior, and OpenAPI shape.
- Add a Runtime operation by defining the neutral contract first, then Runtime
  execution, Controller dispatch, HTTP exposure, and cross-language tests.
- Add no Agent business concept here. The Controller needs an opaque `agent_id`
  and Runtime specification, not an Agent record.
- Keep reconciliation level-triggered: derive required action from desired and
  observed state rather than relying on an in-memory event sequence.
- Preserve three-state external effects anywhere a transport failure cannot
  prove whether the remote side effect started.
