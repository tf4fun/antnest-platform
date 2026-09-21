# Runtime loss acceptance migration

Own the Loss acceptance consumer only. Preserve prior uncommitted work and
retained development; no service implementation changes or old asset removal.
Use current Foundation setup and SDK/public Run audits. Keep live Docker-event
and cold inventory-reconciliation cases, same-Session recovery and restart
deduplication.

After a completed Tool Run, normally stop the owned idle Runtime and require
exit zero before deleting its stopped container without force. In the live case,
wait for the exit to invalidate execution before deletion; the public loss audit
then retains runtime_exited. Separately require the runtime_deleted producer
observation. In the cold case, stop Runtime Controller before stop/removal and
require runtime_missing from platform reconciliation after its normal restart.
No SIGKILL is an acceptance action.

Current Controller loss audits use fresh Inspect evidence (observation sequence
zero and a runtime-condition-loss event identity); do not fabricate a direct
journal link. Correlate producer route, Agent, Runtime revision, generation and
physical resource independently. Require the current provisioned/absent Inspect,
cleared execution binding and preserved configured spec/history/workspace.

ACP must report offline/agent_unavailable and reject Prompt semantically with
-32020/agent_unavailable, no Run/model activity. Explicit Rebuild recovers the
same configuration/workspace under new compute/Runtime/execution revisions.
Exact Session replay must not execute. Verify four completed Tool Runs and two
denials, actual SDK request traces and six lifecycle traces. Keep strict timing
and deliberate rejection errors as failures. Test negatives first, run gates
serially, verify owned cleanup and retained environment afterwards.

Missing-source Rebuild Trace evidence must opt in with the physically observed
old generation. Require a completed absent Inspect under the exact Runtime
update request, then successful next-generation allocation/start under that same
update. Preserve the source 404's raw ERROR and strict failure; its classification
is separate Runtime Controller service work, not an acceptance waiver.
