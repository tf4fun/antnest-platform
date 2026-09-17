# Managed MCP acceptance contract

This fixture-only integration batch uses the installed ACP SDK for both v1 and
v2. It does not change a service implementation or the production Runtime image.

Setup uses Console Provider connections, stable Model IDs and immutable Template
revisions. A real Rust stdio child supplies alpha/beta Tools. Runtime information
and the catalog are refreshed once per Run; the initial context includes Skill
summaries and locators, never full Skill bodies or child environment secrets.

Rebuild is tested with two explicitly released Provider response barriers in one
Run. At each barrier the exact Controller operation remains in drain, ACP reports
the same busy Session with `agent_unavailable`, the durable Run remains running,
and the original Runtime identity is unchanged. A completed Tool alone must not
release the Run. Another Session's prompt is rejected without a Run or Provider
request. No comparison between host clocks is used to establish these facts.

After release, settlement acknowledges the exact operation and closed
configuration, then Runtime replacement completes. The accepted Run retains its
captured execution. The existing connection can use the newly published Runtime;
reconnect replays unchanged history. Alpha's counter is reused before Rebuild;
beta starts at one afterwards. Both children run as UID/GID 1000 with an explicit
environment allowlist. Agent deletion removes its container and storage.

Each actual JSON-RPC request has a distinct Gateway request trace, linked to its
connection. Provider traceparent identifies the HTTP CLIENT under model.complete.
Per-Run preparation, dispatch, Runtime descendants and durable closure must be
present. Only the deliberately invoked alpha fail Tool and exact busy rejection
may have expected error spans. Lifecycle absence probes remain strict failures,
as do all trace warnings and invalid timing. Topology/business evidence does not
turn a failed strict gate into a pass. Shared legacy trace exports remain until
their other consumers migrate.
