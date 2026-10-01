# Managed MCP contract

This document defines what the [managed MCP scenario](README.md) must prove. The
scenario uses the installed ACP SDK for both v1 and v2 and changes neither
service implementations nor the production Runtime image.

## Setup

Setup uses Admin Console Provider connections, stable Model IDs and immutable
Template revisions. A real Rust stdio child supplies the alpha and beta Tools.
Runtime information and the Tool catalog are refreshed once per Run. The
initial context includes Skill summaries and locators, never full Skill bodies
or child environment secrets.

## Rebuild during an active Run

Rebuild is tested with two explicitly released Provider response barriers in
one Run. At each barrier:

- the exact Controller operation remains in drain;
- ACP reports the same busy Session with `agent_unavailable`;
- the durable Run remains running;
- the original Runtime identity is unchanged.

A completed Tool alone must not release the Run. A prompt from another Session
is rejected without a Run or Provider request. Host clock comparisons are never
used to establish these facts.

After release, settlement acknowledges the exact operation and closed
configuration, and then Runtime replacement completes. The accepted Run keeps
its captured execution. The existing connection can use the newly published
Runtime, and reconnect replays unchanged history. Alpha's counter is reused
before the Rebuild; beta starts at one afterwards. Both children run as
UID/GID 1000 with an explicit environment allowlist. Agent deletion removes the
container and its storage.

## Trace rules

Each JSON-RPC request has a distinct Gateway request Trace linked to its
connection. The Provider `traceparent` identifies the HTTP CLIENT span under
`model.complete`. Per-Run preparation, dispatch, Runtime descendants and durable
closure must be present. Only the deliberately invoked alpha failure Tool and
the exact busy rejection may have expected error spans. Lifecycle absence probes,
Trace warnings and invalid timing are strict failures. Topology and business
results never turn a failed strict gate into a pass.
