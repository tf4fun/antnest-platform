# ACP process interruption recovery

This is batch P2 of the [persistence/restart contract](../acp-persistence/contract.md).
It maps the historical completed/model-blocked/tool-blocked/tool-inflight
scenarios onto current ACP ownership and public execution audits. Identity
deactivation and foreign-Agent access remain in their own migration batch.

Both installed SDK versions must preserve completed history, classify known
interrupted Runs, and retain unresolved Runtime effects honestly. The host must
verify the physical marker and live PID before killing an in-flight executor.
After restart, unknown effects require `runtime_barrier_required` until an
explicit Rebuild replaces the protected Runtime. Preserve the old unresolved
Run and all prior events through Rebuild, reconnect and subsequent execution.

The client uses public Provider/Model/Template and audit APIs and has no database
or Docker access. Only the disposable host wrapper owns SIGKILL, process checks,
Runtime retirement proof and cleanup. Do not run this profile against retained
development data. This opt-in crash-recovery profile is separate from normal
request acceptance. The six intentionally interrupted requests expose available
spans, errors, warnings and missing parents as diagnostics with
`strict_trace=not_applicable`; they do not require complete traces. Their actual
SIGKILL and all durable recovery/effect assertions must still pass. Missing
trace data is reported as unavailable. Wrong identity, malformed evidence and
privacy violations still fail.

Completed requests and lifecycle operations keep strict Trace checks. Before
another SIGKILL, completed requests must pass their topology/protocol/privacy
inspection through bounded polling, then be archived. A three-sample pause in
span arrivals alone cannot substitute for the required evidence. The SDK's
five-second batch interval does not guarantee backend visibility at five seconds.

Run `make test-acp-restart-fixtures` for serial local contracts and HTTP component
checks, followed by `make e2e-acp-restart` for the disposable deployment. Set
`ANTNEST_E2E_CONTROLLER_IMAGE` and `ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` when
selecting independent Controller candidates.
P2 follows P1's local/business/topology checks; P1's strict Trace failures remain
recorded. Process observations, physical proof, public audits and raw traces are
private artifacts under `.cache/acp-restart/<project>/`.

The final scoped and strict outcomes are recorded in the
[revalidation report](../../docs/acp-persistence-revalidation.md). Historical
shared helpers remain while Identity and other consumers are still pending.
