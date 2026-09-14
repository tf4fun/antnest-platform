# Agent Default Authorization

Agent Controller owns the Agent's default authorization preference. ACP owns
Session overrides, approvals and the effective policy of an execution. Updating
the default is a management operation, not a Run admission or an ACP request.

`POST /rpc/agent-controller/set-agent-authorization` keeps its existing request
and response contract. The handler uses `AgentConfigurationService`, independently
of the legacy Run service. Its storage port reads the Agent and updates its
default; it has no credential, Session, Run or Runtime operations.

1. Validate the request and authorization rules. Resolve the current Agent owner
   and access revision, then verify active organization membership through
   Identity Service. A missing dependency fails closed.
2. In a local transaction, lock the identity cursor, organization configuration
   and Agent in the established order. Recheck ownership, access binding and
   access revision, deletion and revocation watermarks. The Identity proof's
   last-revocation sequence must equal the Agent's authorized sequence and must
   cover the locally consumed owner/organization watermark. This also rejects
   an old request after explicit Enable, before the revocation consumer catches
   up. A default change cannot reauthorize an Agent after its owner's revocation.
3. Compare the expected authorization revision and write the new default,
   management event and organization execution revision atomically. Capacity or
   CAS failure rolls back all writes and sends no publication hint.
4. Notify the existing configuration publisher only after commit. ACP receives
   the default through the execution snapshot, not through a per-Run callback.

A disabled or temporarily unavailable Agent may still have its default changed
by its active owner. This does not enable the Agent or grant new access. Existing
Session overrides remain ACP data and are not written back into the default.

The RPC is owner-scoped, not administrator-only. `request_id` identifies the
request; concurrency uses `expected_authorization_revision`. A repeated stale
write returns a conflict rather than allocating a second revision or event.

The production publisher is wired into Controller; Gateway/Console consumers
still require migration before deployment. See
[execution publication](execution-publication.md) and the
[boundary plan](../../../docs/controller-acp-execution-boundary-plan.md).

This method belongs to the revision 27
[management contract](../../../contracts/agent-controller/control-contract.json).
It survives removal of execution RPCs; no Session or Run repository is required.
