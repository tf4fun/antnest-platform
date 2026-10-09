# Runtime network policy contract

This document defines what the network policy profile
(`make e2e-lifecycle-network`) must prove. It changes no production service
implementation, host firewall or route, and depends on no Internet endpoint.

## Packet-path behavior

The profile uses two ordinary-user Runtime Bash clients, real TCP/NDJSON and DNS,
and an isolated target behind a fail-closed, test-only Egress forwarding guard.

The target also supplies deterministic TCP DNS answers for
`egress-fixture.example.` using the synthetic public address `1.1.1.1`. The
target owns `1.1.1.1/32` on loopback in its isolated namespace and listens on
TCP ports 18080 (data) and 15353 (DNS). An Egress host route for that address uses
the fixture's private IPv4 as its gateway; no host ports or Internet resolver
are used. Egress connects to the fixture upstream at `1.1.1.1:15353`. The
production Compose DNS default remains `127.0.0.11:53`.

This replaces the former assertion that Agent DNS returns the private
`network-target` address, which encoded the issue #36 disclosure. DNS must still
resolve exactly the public fixture answer before and after the other Agent's
policy change; missing or private answers fail the gate.

The former DNAT of the data destination to a private address conflicted with the
protected-address nft backstop. The routed fixture keeps the public destination
through the production policy and kernel gates; the private-address probe uses
the same live data-listener port. The test-only guard still permits only that
single public data destination and port.

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
only, with no host ports. It uses the immutable Runtime fixture image for Node
and iproute2 and retains only NET_ADMIN to assign its synthetic address inside
its namespace. Temporal stays private, and infrastructure addresses are
reserved. All thirteen services and eight application image identities are
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
