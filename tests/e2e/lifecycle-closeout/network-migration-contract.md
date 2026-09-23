# Lifecycle real-network acceptance migration

This batch owns the network profile and its acceptance assets. Production service
implementations and other historical profiles are outside this batch.

Retain two ordinary-user Runtime Bash clients, actual TCP/NDJSON and DNS, and the
isolated target behind a fail-closed test-only Egress forwarding guard. Prove
allow -> deny -> allow, A's original conntrack removal at deny acknowledgement,
blocked reverse push, prompt reset/rejection instead of timeout, and B's same
socket and DNS continuing across A's policy change and B's stale CAS conflict.
Keep private-address rejection, exact target hit history, policy replay,
unchanged physical/configuration identity and workspace bytes. Never change host
firewalls/routes or depend on an Internet endpoint.

Use the current Foundation setup (Provider connection, stable Model ID, returned
Template revision, immutable Runtime image and readiness before exact replay).
The separate network deployment adds exactly one healthy target on Egress only,
with no host ports. Temporal stays private; infrastructure addresses are reserved.
All thirteen services and eight application image identities must be verified.

Each actual SDK session/new and session/prompt request supplies its JSON-RPC ID
and connection trace link. Six completed Runs bind public execution audits to the
correct Agent/Session and immutable execution revision. Their twelve actual model
HTTP calls and six Runtime Bash executions descend from those Runs. There is no
Controller acquire/finish admission oracle or private Runtime snapshot dependency.
Four lifecycle operations retain current Temporal/SQL/publication/settlement
traces. Policy writes retain Gateway/Console/Controller/Egress ancestry and exact
Agent identity. Raw warnings and errors stay visible and strict status stays
separate from topology; no clocks, exporter intervals or raw spans are changed.

Delete both Agents through business APIs. Require their original Runtime IDs to
emit one clean exit/stop/destroy sequence, and gracefully stop remaining trace
producers with exit zero before collection. Save raw traces and failures privately,
continue collecting independent trace failures, and clean only owned resources.
Retained development containers/data must remain unchanged. No old shared assets
are removed. Add negative tests before implementing new acceptance behavior and
run verification serially, including local socket components and Docker evidence.
