# ACP access contract

This document defines what the [ACP access scenario](README.md)
(`make e2e-acp-closeout`) must prove and which scenarios own related behavior.

## Required behavior

`make e2e-acp-closeout` and the `ANTNEST_E2E_ACP_CLOSEOUT=true` selector run a
disposable normal-request profile. For both installed SDK versions it must
preserve:

- same-organization foreign-principal and foreign-Agent Session denials;
- exact private history, with no side effects from rejected requests;
- owner deactivation on an existing connection, followed by automatic Disable
  of both owned Agents;
- owner restoration without automatic Enable, then successful explicit
  recovery.

The Gateway authenticates the connection; ACP must reject foreign Agent access
with a specific protocol error. Completed Runs, Tool effects and replay are
checked against current ACP records and per-message Traces, using immutable
Runtime images and current Provider, Model and Template setup. Physical
workspace contents must survive Disable and Enable. The other owner's Agent
remains usable throughout.

## Related scenarios

- Crash recovery (completed history across an ACP crash, a model held at crash,
  a completed Tool followed by a held model, and an in-flight Tool with unknown
  effect followed by a physical Rebuild) is owned by `make e2e-acp-restart`,
  which is opted in separately. The normal profile must not kill ACP.
- ACP persistence faults are owned by `make e2e-acp-persistence`.
- Cross-organization access and offboarding are owned by `make e2e-agent-access`.

## Verification rules

Negative fixture tests are written first. Unit, contract and component checks
and the Docker profile run serially. Complete topology, SQL and privacy evidence
is collected before export stability is checked. Raw Traces are archived
privately, and strict warnings and expected-rejection errors stay reported as
failures. Cleanup and the identity of retained containers are verified after the
run.
