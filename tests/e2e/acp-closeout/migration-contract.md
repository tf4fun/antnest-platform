# ACP access contract

This document defines what the [ACP access scenario](README.md)
(`make e2e-acp-closeout`) must prove and which scenarios own related behavior.

## Required behavior

`make e2e-acp-closeout` and the `ANTNEST_E2E_ACP_CLOSEOUT=true` selector run a
disposable normal-request profile. For both installed SDK versions it must
preserve:

- same-organization foreign-principal and foreign-Agent Session denials;
- exact private history, with no side effects from rejected requests;
- global User deactivation closes both original browser SSEs and rejects real
  original-Cookie HTTP prompts, followed by automatic Disable of both owned Agents;
- explicit joining of private SDK connections and four separate local zero-wire
  rejection probes, excluded from the 30-initialize/86-business request inventory;
- owner restoration without automatic Enable, then successful explicit
  recovery.

Identity delegates the original browser authority to the private ACP receiver
using the Agent UI workload grant; ACP must reject foreign Agent access with a
specific protocol error. The Gateway authenticates the independent browser SSE
and HTTP denial probes. User deactivation must be proved by its own committed
Identity transaction and original Controller owner-revocation event; Membership
or Logout receipts cannot stand in for global User loss. Completed Runs, Tool effects and replay are
checked against current ACP records and per-message Traces, using immutable
Runtime images and current Provider, Model and Template setup. Physical
workspace contents must survive Disable and Enable. The other owner's Agent
remains usable throughout.

## Related scenarios

- Crash recovery (completed history across an ACP crash, a model held at crash,
  a completed Tool followed by a held model, and an in-flight Tool with unknown
  effect followed by a physical Rebuild) is owned by `make e2e-acp-restart`,
  which is opted in separately. The normal profile must not kill ACP.
- ACP persistence faults are owned by the [ACP PostgreSQL components](../../integration/agent-acp-service/support/persistence/README.md) (`make test-agent-acp-postgres`).
- Cross-organization access and offboarding are owned by `make e2e-agent-access`.

## Verification rules

Negative fixture tests are written first. Unit, contract and component checks
and the Docker profile run serially. Complete topology, SQL and privacy evidence
is collected before export stability is checked. Raw Traces are archived
privately, and strict warnings and expected-rejection errors stay reported as
failures. Cleanup and the identity of retained containers are verified after the
run.
