package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func readExecutionSource(ctx context.Context, tx *databaseTransaction, organizationID string, revision int64) (ports.ExecutionSource, error) {
	source := ports.ExecutionSource{OrganizationID: organizationID, Revision: revision}
	var err error
	source.Providers, err = readExecutionProviders(ctx, tx, organizationID)
	if err != nil {
		return ports.ExecutionSource{}, err
	}
	source.Models, err = readExecutionModels(ctx, tx, organizationID)
	if err != nil {
		return ports.ExecutionSource{}, err
	}
	source.Agents, err = readExecutionAgents(ctx, tx, organizationID)
	if err != nil {
		return ports.ExecutionSource{}, err
	}
	return source, nil
}

func readExecutionProviders(ctx context.Context, tx *databaseTransaction, organizationID string) ([]ports.ProviderConnectionRecord, error) {
	rows, err := tx.Query(ctx, `SELECT id, organization_id, provider_key, base_url, credential_method,
current_credential_version, credential_revision, ciphertext, nonce, key_version, wrapped_data_key, enabled
FROM agent_controller.provider_connections WHERE organization_id=$1 ORDER BY id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("read execution Providers: %w", err)
	}
	defer rows.Close()
	providers := []ports.ProviderConnectionRecord{}
	for rows.Next() {
		var provider ports.ProviderConnectionRecord
		if err := rows.Scan(&provider.ConnectionID, &provider.OrganizationID, &provider.ProviderKey, &provider.BaseURL, &provider.CredentialMethod,
			&provider.CredentialVersion, &provider.CredentialRevision, &provider.SealedCredential.Ciphertext, &provider.SealedCredential.Nonce, &provider.SealedCredential.KeyVersion, &provider.SealedCredential.WrappedDataKey, &provider.Enabled); err != nil {
			return nil, fmt.Errorf("scan execution Provider: %w", err)
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate execution Providers: %w", err)
	}
	return providers, nil
}

func readExecutionModels(ctx context.Context, tx *databaseTransaction, organizationID string) ([]ports.ModelProfileRecord, error) {
	rows, err := tx.Query(ctx, `SELECT `+modelProfileColumns+`
FROM agent_controller.model_profiles p
LEFT JOIN agent_controller.provider_connections c ON c.id=p.provider_connection_id AND c.organization_id=p.organization_id
WHERE p.organization_id=$1 ORDER BY p.id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("read execution Models: %w", err)
	}
	defer rows.Close()
	models := []ports.ModelProfileRecord{}
	for rows.Next() {
		model, err := scanModelProfileRecord(rows)
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate execution Models: %w", err)
	}
	return models, nil
}

func readExecutionAgents(ctx context.Context, tx *databaseTransaction, organizationID string) ([]ports.ExecutionAgentSource, error) {
	rows, err := tx.Query(ctx, `SELECT a.id, a.organization_id, a.owner_user_id,
a.desired_state, a.lifecycle_state, a.activation_state, a.runtime_state, a.access_revision,
a.executable_spec_revision_id, a.executable_execution_revision_id,
a.runtime_revision, a.runtime_execution_id, a.runtime_mcp_endpoint, a.active_operation_request_id,
a.owner_authorization_sequence, a.identity_revocation_sequence, a.default_authorization, a.authorization_revision,
a.last_successful_execution_revision_id,
s.id, s.agent_id, s.revision, s.snapshot,
r.id, r.agent_id, r.revision, r.snapshot,
EXISTS (SELECT 1 FROM agent_controller.agent_access_bindings b
 WHERE b.agent_id=a.id AND b.principal_id=a.owner_user_id AND b.access_revision=a.access_revision AND b.active)
FROM agent_controller.agents a
LEFT JOIN agent_controller.execution_revisions e ON e.id=a.last_successful_execution_revision_id AND e.agent_id=a.id
LEFT JOIN agent_controller.agent_spec_revisions r ON r.agent_id=a.id
AND ((a.last_successful_execution_revision_id<>'' AND r.id=e.agent_spec_revision_id)
 OR (a.last_successful_execution_revision_id='' AND r.revision=1))
LEFT JOIN agent_controller.agent_spec_revisions s ON s.agent_id=a.id
AND (s.id=a.executable_spec_revision_id
 OR (a.executable_spec_revision_id='' AND s.id=r.id))
WHERE a.organization_id=$1 AND a.lifecycle_state <> 'deleted'
ORDER BY a.id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("read execution Agents: %w", err)
	}
	defer rows.Close()
	agents := []ports.ExecutionAgentSource{}
	for rows.Next() {
		agent, err := scanExecutionAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate execution Agents: %w", err)
	}
	return agents, nil
}

func scanExecutionAgent(scanner catalogRowScanner) (ports.ExecutionAgentSource, error) {
	var source ports.ExecutionAgentSource
	agent := &source.Agent
	var authorization, spec, retained []byte
	err := scanner.Scan(&agent.AgentID, &agent.OrganizationID, &agent.OwnerUserID,
		&agent.DesiredState, &agent.LifecycleState, &agent.ActivationState, &agent.RuntimeState, &agent.AccessRevision,
		&agent.AgentSpecRevisionID, &agent.ExecutionRevisionID, &agent.RuntimeRevision, &agent.RuntimeExecutionID, &agent.RuntimeMCPEndpoint, &agent.ActiveOperationRequestID,
		&agent.OwnerAuthorizationSequence, &agent.IdentityRevocationSequence, &authorization, &source.AuthorizationRevision,
		&agent.LastSuccessfulExecutionRevisionID,
		&source.Spec.ID, &source.Spec.AgentID, &source.Spec.Revision, &spec,
		&source.RetainedSpec.ID, &source.RetainedSpec.AgentID, &source.RetainedSpec.Revision, &retained, &source.OwnerAccessGranted)
	if err != nil {
		return ports.ExecutionAgentSource{}, fmt.Errorf("scan execution Agent configuration: %w", err)
	}
	if err := json.Unmarshal(authorization, &source.Authorization); err != nil {
		return ports.ExecutionAgentSource{}, fmt.Errorf("decode execution authorization: %w", err)
	}
	if err := json.Unmarshal(spec, &source.Spec.Snapshot); err != nil {
		return ports.ExecutionAgentSource{}, fmt.Errorf("decode execution Agent spec: %w", err)
	}
	if err := json.Unmarshal(retained, &source.RetainedSpec.Snapshot); err != nil {
		return ports.ExecutionAgentSource{}, fmt.Errorf("decode retained execution Agent spec: %w", err)
	}
	return source, nil
}
