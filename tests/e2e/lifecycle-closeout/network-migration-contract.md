# Runtime network policy contract

This document defines what the network policy profile
(`make e2e-lifecycle-network`) must prove. It changes no production service
implementation, host firewall or route, and depends on no Internet endpoint.

## Packet-path behavior

The profile uses two ordinary-user Runtime Bash clients, real TCP/NDJSON and DNS,
and an isolated target behind a fail-closed, test-only Egress forwarding guard.
It must prove:

- allow, then deny, then allow on Agent A;
- removal of A's original conntrack entry at the deny acknowledgement;
- a blocked reverse push to A, and a prompt reset or rejection instead of a
  timeout;
- that B's same socket and DNS keep working across A's policy change and across
  B's stale CAS conflict;
- private-address rejection, exact target hit history, policy replay, and
  unchanged physical identity, configuration and workspace bytes.

## Deployment

Setup uses the Foundation flow (Provider connection, stable Model ID, returned
Template revision, immutable Runtime image, and readiness before exact replay).
The network deployment adds exactly one healthy target on the Egress network
only, with no host ports. Temporal stays private, and infrastructure addresses
are reserved. All thirteen services and eight application image identities are
verified.

## Trace rules

Each SDK `session/new` and `session/prompt` request supplies its JSON-RPC ID and
connection Trace link. Six completed Runs bind public execution audits to the
correct Agent, Session and immutable execution revision; their twelve model HTTP
calls and six Runtime Bash executions descend from those Runs. Four lifecycle
operations keep the Temporal, SQL, publication and settlement Trace checks.
Policy writes keep Gateway, Console, Controller and Egress ancestry and the exact
Agent identity. Raw warnings and errors stay visible, and strict status is
reported separately from topology. Clocks, exporter intervals and raw spans are
never changed.

## Cleanup

Both Agents are deleted through business APIs. Their original Runtime containers
must each emit one clean exit, stop and destroy sequence, and the remaining Trace
producers are stopped gracefully with exit zero before collection. Raw Traces and
failures are saved privately, independent Trace failures are still collected, and
only owned resources are removed. Negative tests come first, and local socket
components and Docker checks run serially.
