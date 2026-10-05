package control

import (
	"context"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

var ErrConnectionStale = errors.New("runtime connection binding is stale")
var ErrConnectionUnavailable = errors.New("runtime connection verification is unavailable")

type RuntimeConnection struct {
	AgentID            string                     `json:"agent_id"`
	RuntimeRevision    deployment.RuntimeRevision `json:"runtime_revision"`
	RuntimeExecutionID string                     `json:"runtime_execution_id"`
	ConnectionID       string                     `json:"connection_id"`
	MCPEndpoint        string                     `json:"mcp_endpoint"`
	Credential         RuntimeCredential          `json:"credential"`
}
type RuntimeCredential struct {
	Caller string `json:"caller"`
	Token  string `json:"token"`
}

func (s *Service) ResolveRuntimeConnection(ctx context.Context, agentID string, revision deployment.RuntimeRevision, executionID string) (RuntimeConnection, error) {
	if (deployment.Key{AgentID: agentID, Generation: 1}).Validate() != nil || deployment.ValidateRevision(revision) != nil || executionID == "" || len(executionID) > 200 {
		return RuntimeConnection{}, ErrInvalidRequest
	}
	if s.instanceCredentials == nil {
		return RuntimeConnection{}, ErrConnectionUnavailable
	}
	store, ok := s.repository.(repositoryport.InstanceCredentialStore)
	if !ok {
		return RuntimeConnection{}, ErrConnectionUnavailable
	}
	var result RuntimeConnection
	err := s.locker.WithAgentLock(ctx, agentID, func(ctx context.Context) error {
		environment, err := s.repository.GetEnvironment(ctx, agentID)
		if err != nil {
			return err
		}
		if environment.LifecycleState == deployment.LifecycleDeleted || environment.LifecycleState == deployment.LifecycleDisabled {
			return ErrNotFound
		}
		if environment.LifecycleState != deployment.LifecycleProvisioned || environment.RuntimeRevision != revision || environment.OperationID != "" {
			return ErrConnectionStale
		}
		creator, err := store.GenerationOperation(ctx, deployment.Key{AgentID: agentID, Generation: environment.Generation})
		if err != nil || !creator.CreatesCompute() || creator.SpecDigest != environment.SpecDigest || creator.InstanceAuthentication == nil {
			return ErrConnectionUnavailable
		}
		id := instanceauth.Identity{Scope: s.instanceScope, AgentID: agentID, Generation: environment.Generation}
		if _, err := s.instanceCredentials.Receiver(id, creator.InstanceAuthentication); err != nil {
			return ErrConnectionUnavailable
		}
		verified, err := s.inspectProvisionedEnvironment(ctx, environment)
		if err != nil {
			return ErrConnectionUnavailable
		}
		if verified.Phase == deployment.PhaseAbsent && verified.Health == deployment.HealthAbsent {
			return ErrNotFound
		}
		if verified.RuntimeExecutionID == "" || verified.Health != deployment.HealthHealthy {
			return ErrConnectionUnavailable
		}
		if verified.RuntimeExecutionID != executionID {
			return ErrConnectionStale
		}
		token, err := s.instanceCredentials.Open(id, creator.InstanceAuthentication, "agent-acp-service")
		if err != nil {
			return ErrConnectionUnavailable
		}
		result = RuntimeConnection{AgentID: agentID, RuntimeRevision: revision, RuntimeExecutionID: executionID, ConnectionID: creator.InstanceAuthentication.ConnectionID, MCPEndpoint: verified.MCPEndpoint, Credential: RuntimeCredential{Caller: "agent-acp-service", Token: token}}
		return nil
	})
	if err != nil {
		return RuntimeConnection{}, err
	}
	if result.ConnectionID == "" {
		return RuntimeConnection{}, fmt.Errorf("%w: no verified connection", ErrConnectionUnavailable)
	}
	return result, nil
}
