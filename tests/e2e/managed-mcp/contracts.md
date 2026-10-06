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
UID 2000/GID 1000 with an explicit environment allowlist. Model Bash stays UID
1000 and must be denied environ/memory/fd inspection and ptrace. Secret values
must not appear in Template reads, Runtime specs or traces; reads are descriptors,
writes are value/keep, and omission clears only the new head. Disable/Enable
must retain the Agent's frozen secret revision. Agent deletion removes the
container and its storage.

## Trace rules

Each JSON-RPC request has a distinct Gateway request Trace linked to its
connection. The Provider `traceparent` identifies the HTTP CLIENT span under
`model.complete`. Per-Run preparation, dispatch, Runtime descendants and durable
closure must be present. Only the deliberately invoked alpha failure Tool and
the exact busy rejection may have expected error spans. Lifecycle absence probes,
Unknown Trace warnings and invalid logical timing are failures. Only the shared,
reviewed clock-skew warning class can be reported as a timing-only limitation;
strict diagnostics remain explicit. Missing parents, privacy and topology never
become passes because business results succeeded.
