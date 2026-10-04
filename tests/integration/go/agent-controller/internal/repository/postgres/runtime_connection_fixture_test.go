package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// This fixture is an RC-owned protocol stand-in for existing lifecycle tests.
// It never grants authority without an explicit resolver at publisher composition.
// The real authenticated HTTP handoff is exercised by runtime_connection_component_test.go.
type fixtureRuntimeConnectionResolver struct{ repository *Repository }

func (fixture fixtureRuntimeConnectionResolver) ResolveRuntimeConnection(ctx context.Context, agentID, revision, executionID string) (ports.RuntimeConnection, error) {
	agent, err := fixture.repository.GetAgent(ctx, agentID)
	if err != nil {
		return ports.RuntimeConnection{}, err
	}
	if agent.RuntimeRevision != revision || agent.RuntimeExecutionID != executionID {
		return ports.RuntimeConnection{}, &ports.DependencyError{Service: "runtime-controller", Code: "runtime_connection_stale"}
	}
	digest := sha256.Sum256([]byte("synthetic-runtime/" + agentID + "/" + revision))
	return ports.RuntimeConnection{AgentID: agentID, RuntimeRevision: revision, RuntimeExecutionID: executionID,
		MCPEndpoint: agent.RuntimeMCPEndpoint, ConnectionID: "rci_" + hex.EncodeToString(digest[:16]),
		Credential: ports.RuntimeCredential{Caller: "agent-acp-service", Token: base64.RawURLEncoding.EncodeToString(digest[:])}}, nil
}
