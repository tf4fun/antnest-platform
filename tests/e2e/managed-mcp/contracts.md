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

The client delegates the original member login Session and Principal to the
private ACP entry through Identity workspace Resolve. Only the disposable
`gateway-identity` and `agent-ui-acp` grants authorize these calls. Execution
state reads preserve the complete private response, including its configuration
revision. Each version must retain three real SDK connections and initializations,
eleven business requests, six Runs, sixteen Provider requests and ten Tool calls.

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

Each JSON-RPC request, including initialize, has a distinct private ACP request
Trace linked to its actual exported CLIENT span and connection upgrade. The
original SDK request ID, Session and immutable wire receipt identify the request.
The Provider `traceparent` identifies the HTTP CLIENT span under
`model.complete`. Per-Run preparation, dispatch, Runtime descendants and durable
closure must be present. Only the deliberately invoked alpha failure Tool and
the exact busy rejection may have expected business error spans. Their actual
response and complete owning span chains are required. All fourteen private
requests and three lifecycle Traces must pass their owning checks.

Reviewed SDK read/Tool cleanup diagnostics require the complete successful
operation and exact diagnostic ownership. Reviewed clock observations retain
their original timestamps. Raw strict failures and child exit code 2 remain
explicit; unknown errors, warnings, missing parents, privacy violations and
invalid topology fail. Business success cannot replace those checks. The final
completion receipt is written only after pending requests, connection closure,
evidence preservation and telemetry shutdown have joined. Build, archive and
cleanup failures are never accepted as warning exits.
