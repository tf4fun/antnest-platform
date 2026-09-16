# Runtime Response-Close Deployment And Integration

Recorded: 2026-09-16. Source fix: `f8e9acf`; deployment started from documentation
commit `5750475`. This is the integration follow-up to the
[Runtime service gates](../runtimes/antnest-runtime/docs/observability.md#mcp-response-close-classification).

Deployment, real-chat behavior and chat trace topology checks passed. The strict
browser and lifecycle scripts still exited 1 on Jaeger clock warnings. Their
failures, timestamps and warning evidence were retained; this is not a claim
that the entire strict browser profile passed.

## Deployment

- Project: `antnest-dev-20260915`; Agent:
  `agent_13f29da090d9a459c2d6f02576f74705`.
- The Agent was ready and idle before replacement. The tested image
  `antnest/antnest-runtime:http-close-e2e` was promoted to
  `antnest/antnest-runtime:local`; the ordinary Agent Rebuild API performed the
  replacement, drain, configuration publication and readiness transition.
- Image ID: `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909`.
  The running binary SHA-256 is
  `149fc758262cf0c811bac604ca33df67c8f883c995d50f421b55918445675834`, identical
  to the binary that passed the Linux gates and 10 isolated Docker scenarios.
- Runtime generation changed from 2 to 3; execution ID is
  `7984fa9d-0140-4930-aa08-8eca2d94d9b4`. The container was replaced while both
  volume identities and mount permissions were retained. The existing synthetic
  acceptance file had the same checksum immediately before and after rebuild.
- Template `template_d702f4b8ba9268ef242a9f92a2c67e53` stayed at revision 2.
  The Rebuild completed, and replay of its idempotency key did not change the
  operation or events. Final checks at 20:45 +08:00 found the Agent ready and
  idle, execution configuration synchronized, and all 11 configured container
  health checks healthy; Jaeger has no container health check.
- Previous image is retained as `antnest/antnest-runtime:pre-http-close-20260916`
  (`sha256:d074ed9e6099443e319b1657f548c9bab179d003be7270b046a8878875f66461`).
  If rollback is needed, restore the `local` tag to this image and use normal Rebuild;
  restarting an old container is not the lifecycle recovery procedure.

## Real Browser And Trace Evidence

The existing `development-browser.mjs --confirm-development --agent ...`
profile used the real model and deployed services. Session:
`1d0083ab-d543-417d-9e01-87c0c72e667b`.

All eight browser/business checks completed: login, Console deep link to the
same Agent, real greeting, tool execution with collapsed activity, history replay
without another prompt, another tool after reload, mobile overflow, and explicit
Agent selection. Browser errors: zero. Only the existing synthetic
`/workspace/acceptance-note.txt` was overwritten by the tool acceptance flow.

| Trace | Spans | Runtime tool calls | Error spans/events | Strict result |
| --- | ---: | ---: | --- | --- |
| `d6313d9a9841bab645bdb4046b29274b` — greeting | 131 | 0 | 0 / 0 | Passed |
| `d934843d0d72f06f9300d5009a088376` — write/read | 522 | 3 | 0 / 0 | Failed: clock warnings, calculated delta 124.865 µs |
| `aa6251187c746fa4f03182632f83dc8c` — read after reload | 303 | 1 | 0 / 0 | Failed: clock warnings, calculated delta 246.339 µs |

`inspectChatTraceTopology` passed on all three unmodified traces: Gateway
SERVER/CLIENT, ACP SERVER/Run/model and Runtime tool ancestry; no missing or
duplicate parents, no management-service calls beneath the Run, no RPC content
capture, and no configured credentials. All 20 Runtime HTTP spans reported
successful protocol and transport completion on generation 3. No successful
response closed before EOF in this live run; the deterministic Linux HTTP
component test remains the evidence for that timing-sensitive branch.

The two tool traces contain 980 and 566 warning entries respectively, including
repeated copies of the same delta; those counts are not independent clock
faults. Their warning-bearing spans and original timestamps are retained. The
[clock maintenance decision](controller-acp-execution-boundary-plan.md#obs-acp-clock)
does not turn the strict failure into a pass or change any timestamps/thresholds.

## Real Error Preservation And Lifecycle Diagnostics

A separate read-only request to the deployed Runtime attempted a uniquely named
nonexistent file. Trace `dbff5bb23329379d58a49656547647ba` has one Runtime HTTP
root, complete local parent relationships and zero warnings. The response was
HTTP 200 with MCP `isError=true`, `error_code=read_failed`. The HTTP, MCP
operation, tool and Executor spans retained the failure, and the operation kept
its `antnest.error` event. No cancellation event replaced the error. This direct
probe is not counted as another full Gateway/model conversation.

Rebuild trace `4881e43d5992ecba01b4c9b025297336` has 266 spans and passed the
generic structural topology check. The strict lifecycle inspector stopped at
clock warnings of 309.127/340.376 µs; it is not recorded as a fully passed
lifecycle trace. One Docker GET 404 remains an error span: it is the absent
container inspection under `runtime.platform.create`, followed by successful
create (201) and start (204). This matches the driver's existing absence branch;
the error span was retained, not covered by the clock deferral.

## Artifacts And Scope

Local evidence is under `.cache/runtime-close-integration-20260916/`:
`runtime-before.json`, `runtime-after.json`, workspace checksums, `rebuild.log`,
`browser-acceptance/`, `chat-traces.json`, `chat-trace-timing.json`,
`negative-trace.json`, `lifecycle-trace.json` and `final-agent-state.json`.
The earlier `.cache/development-acceptance/` evidence was archived under
`previous-development-acceptance/` before the profile wrote fresh results.
These ignored artifacts are not guaranteed in a fresh clone; this report
preserves their scoped conclusions.

No application code, Trace gates or clock settings changed in this integration
batch. The original expired historical trace was not reclassified. The five
deferred C4 browser scenarios and AJV dependency advisory remain separate work.
