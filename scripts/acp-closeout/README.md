# Gateway ACP Closeout Integration

Run `ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3`. The parent creates a
disposable Compose project with real Identity, Controller, ACP, Runtime,
Gateway and private service databases on one PostgreSQL instance. Only the
model is deterministic. No external Provider or credential is required.

The host coordinator alone kills/restarts the project's ACP container. The
client has no Docker socket. File checkpoints synchronize a model-observed
barrier with the host; a fixed sleep is never treated as evidence of execution.
The parent cleanup removes all fixture containers, volumes and temporary data,
including on failure. This profile must not run against a retained dev stack.

## Scenarios (Each For Stable v1 And Draft v2)

1. Create three Agents through Gateway: two owned by user A and one by user B.
   Deny B's upgrade to A's Agent. For admitted connections, deny foreign
   principal and foreign Agent access to a completed Session, without history
   leakage, model calls or persisted effects.
2. Disable the owner through the administrator API while its connection remains
   open. The first new prompt must close with Gateway 1008 before ACP admission:
   no failed Run intent or other ACP mutation may be created. Re-enable and
   reconnect, retaining only previously authorized history. This is Identity deactivation evidence,
   not a claim about logout/expiry of an already-upgraded browser connection.
3. Complete a real Bash append Tool, reconnect twice and replay history. Kill
   the ACP process with SIGKILL, restart it, replay the same history and verify
   stable messages, Run/Tool rows and model counts. A new prompt must work.
4. Hold the first model response, kill ACP, restart. The admitted Run must
   become `failed/quiescent/none`, record `service_restarted_during_run`, finish
   its admission and accept a new prompt without resending the old request.
5. Append one effect through Bash, hold the following model response, kill ACP
   and restart. The Run must become `failed/quiescent/settled`, preserve the
   completed Tool and never repeat the append. Verify the physical effect log
   through a later read Tool, not merely an idempotent file-existence check.

The official SDK is the ACP client. Assertions use version-specific completion
and replay methods. Read-only queries against the fixture's ACP-owned database
corroborate replay and recovery; no service writes another service's tables.
Gateway-origin Jaeger ancestry is checked on the completed baseline before
fault injection; abrupt process death may lose unexported spans.

Not covered: uncertain in-flight Tool effects, acquire/finish response-loss
windows, concurrent rebuild while a Run is active, OIDC/SCIM provisioning,
browser rendering, or full ACP protocol conformance. Keep these open in the
[closeout plan](../../docs/docker-single-node-closeout.md).
