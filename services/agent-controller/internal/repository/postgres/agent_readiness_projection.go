package postgres

import (
	"encoding/json"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Correlated reads share the Agent statement's snapshot without widening its
// FOR UPDATE locks to access, synchronization or historical readiness rows.
const agentRecordColumns = `id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
       access_revision, executable_spec_revision_id, executable_execution_revision_id,
       last_successful_execution_revision_id, runtime_revision, runtime_execution_id,
       runtime_mcp_endpoint, active_operation_request_id, failure_stage, failure_code,
       failure_detail, aggregate_sequence, created_at, updated_at,
       owner_authorization_sequence, identity_revocation_sequence,
       activation_state, runtime_state, runtime_reason, runtime_detail, runtime_observed_at,
       (SELECT jsonb_build_object('AgentID', b.agent_id, 'PrincipalID', b.principal_id,
           'AccessRevision', b.access_revision, 'Active', b.active)
        FROM agent_controller.agent_access_bindings b WHERE b.agent_id=agents.id AND b.principal_id=agents.owner_user_id),
       COALESCE((SELECT MAX(r.sequence) FROM agent_controller.owner_revocations r
           WHERE r.user_id=agents.owner_user_id AND r.organization_id IN ('', agents.organization_id)), 0),
       COALESCE((SELECT s.revision FROM agent_controller.execution_configuration_sync s WHERE s.organization_id=agents.organization_id), 0),
       COALESCE((SELECT s.applied_revision FROM agent_controller.execution_configuration_sync s WHERE s.organization_id=agents.organization_id), 0),
       (SELECT to_jsonb(p) FROM agent_controller.agent_runtime_readiness p
           WHERE p.agent_id=agents.id AND p.execution_revision_id=agents.executable_execution_revision_id)`

func decodeAgentReadiness(evidence *ports.AgentReadinessEvidence, access, proof []byte) error {
	if len(access) > 0 {
		if err := json.Unmarshal(access, &evidence.Access); err != nil {
			return fmt.Errorf("decode Agent readiness access: %w", err)
		}
	}
	if len(proof) > 0 {
		if err := json.Unmarshal(proof, &evidence.Binding); err != nil {
			return fmt.Errorf("decode Agent readiness proof: %w", err)
		}
	}
	if evidence.CommittedRevision < 0 || evidence.CommittedRevision > ports.MaximumExecutionRevision ||
		evidence.AppliedRevision < 0 || evidence.AppliedRevision > evidence.CommittedRevision {
		return fmt.Errorf("invalid persisted Agent readiness watermark")
	}
	if binding := evidence.Binding; binding != nil {
		if binding.ReadyAfterRevision < 1 || binding.ReadyAfterRevision > evidence.CommittedRevision ||
			binding.ReopenAfterRevision < 0 || binding.ReopenAfterRevision > evidence.CommittedRevision ||
			(binding.ReopenAfterRevision > 0 && binding.ReopenAfterRevision < binding.ReadyAfterRevision) ||
			binding.AppliedRevision < 0 || binding.AppliedRevision > evidence.AppliedRevision ||
			(binding.ReadyAt == nil) != (binding.AppliedRevision == 0) ||
			(binding.AppliedRevision > 0 && binding.AppliedRevision < binding.ReadyAfterRevision) {
			return fmt.Errorf("invalid persisted Agent readiness proof")
		}
	}
	return nil
}
