# Remaining historical closeout migration

Deliver the remaining consumers separately. This batch owns the legacy mixed
ACP closeout entry and its normal access scenarios. Lifecycle foundation/drain,
shutdown, network, loss, restore, interrupted-update and older Workspace
consumers remain pending until their own fixtures and Docker evidence pass.

`make e2e-acp-closeout` and the historical `ANTNEST_E2E_ACP_CLOSEOUT=true`
selector must run a disposable normal-request profile. For both installed SDK
versions, preserve same-organization foreign-principal and foreign-Agent Session
denials, exact private history, no rejected-request side effects, owner
deactivation on an existing connection, automatic Disable of both owned Agents,
restoration without automatic Enable, and successful explicit recovery.

Gateway authenticates the connection; ACP must reject foreign Agent access
through a specific protocol error. Completed Runs, Tool effects and replay use
current ACP records and per-message traces, with immutable Runtime images and
current Provider/Model/Template setup. Physical workspace contents must survive
Disable/Enable. The unaffected other owner's Agent remains usable.

The four historical crash cases are owned by `make e2e-acp-restart`, separately
opted in. Its P2 record remains the evidence for eight actual SIGKILL recoveries,
unknown effects, Runtime protection and physical Rebuild. Normal closeout must
not kill ACP or claim fresh crash coverage. P1 remains separately owned by
`make e2e-acp-persistence`.

Add negative fixture tests first. Run local unit/contract/component checks and
Docker profiles serially. Collect complete topology, SQL and privacy evidence
before export stability; archive raw traces privately and retain strict warning
and expected-rejection failures. Verify cleanup and retained container identity.
Do not retire old files or shared helpers in this delivery batch.
