package application

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionCapacity struct {
	opener   ports.CredentialOpener
	maxBytes int
}

func NewExecutionCapacity(opener ports.CredentialOpener, maxBytes int) (*ExecutionCapacity, error) {
	if opener == nil || maxBytes < 1 {
		return nil, fmt.Errorf("execution capacity requires local credential opening and a positive byte limit")
	}
	return &ExecutionCapacity{opener: opener, maxBytes: maxBytes}, nil
}

func (capacity *ExecutionCapacity) ValidateExecutionCapacity(ctx context.Context, input ports.ExecutionCapacityInput) error {
	required, err := capacity.RequiredBytes(ctx, input)
	if err != nil {
		return err
	}
	if required > capacity.maxBytes {
		return &ports.ExecutionCapacityError{RequiredBytes: required, LimitBytes: capacity.maxBytes}
	}
	return nil
}

func (capacity *ExecutionCapacity) RequiredBytes(ctx context.Context, input ports.ExecutionCapacityInput) (int, error) {
	snapshot, err := BuildExecutionSnapshot(ctx, input.Current, capacity.opener)
	if err != nil {
		return 0, err
	}
	agents, err := capacityAgents(snapshot, input)
	if err != nil {
		return 0, err
	}
	snapshot.Agents = agents
	snapshot.Revision = ports.MaximumExecutionRevision
	for index := range snapshot.Providers {
		snapshot.Providers[index].Enabled = false
	}
	for index := range snapshot.Models {
		snapshot.Models[index].Enabled = false
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return 0, ports.ErrInvalidExecutionConfiguration
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return len(encoded), nil
}

func capacityAgents(snapshot ports.ExecutionSnapshot, input ports.ExecutionCapacityInput) ([]ports.ExecutionAgent, error) {
	agents := make([]ports.ExecutionAgent, len(snapshot.Agents))
	indices := make(map[string]int, len(agents))
	sources := make(map[string]ports.ExecutionAgentSource, len(input.Current.Agents))
	for _, source := range input.Current.Agents {
		sources[source.Agent.AgentID] = source
	}
	for index, agent := range snapshot.Agents {
		agents[index] = executionAgentCapacityEnvelope(agent)
		indices[agent.AgentID] = index
		source := sources[agent.AgentID]
		if source.RetainedSpec.ID != "" {
			retained, err := capacityAgentCandidate(snapshot, source, source.RetainedSpec)
			if err != nil {
				return nil, err
			}
			agents[index], err = largerExecutionAgent(agents[index], retained)
			if err != nil {
				return nil, err
			}
		}
	}
	seen := make(map[string]bool, len(input.Targets))
	for _, target := range input.Targets {
		index, found := indices[target.AgentID]
		if !found || seen[target.AgentID] || target.ID == "" || target.Revision < 1 {
			return nil, ports.ErrInvalidExecutionConfiguration
		}
		seen[target.AgentID] = true
		candidate, err := capacityAgentCandidate(snapshot, sources[target.AgentID], target)
		if err != nil {
			return nil, err
		}
		larger, err := largerExecutionAgent(agents[index], candidate)
		if err != nil {
			return nil, err
		}
		agents[index] = larger
	}
	return agents, nil
}

func capacityAgentCandidate(snapshot ports.ExecutionSnapshot, source ports.ExecutionAgentSource, spec ports.AgentSpecRecord) (ports.ExecutionAgent, error) {
	if spec.AgentID != source.Agent.AgentID || spec.ID == "" || spec.Revision < 1 {
		return ports.ExecutionAgent{}, ports.ErrInvalidExecutionConfiguration
	}
	source.Spec = spec
	source.Agent.AgentSpecRevisionID = spec.ID
	candidate := projectExecutionAgent(source, false)
	check := snapshot
	check.Agents = []ports.ExecutionAgent{candidate}
	if err := check.Validate(); err != nil {
		return ports.ExecutionAgent{}, err
	}
	return executionAgentCapacityEnvelope(candidate), nil
}

// This envelope is used only for measurement, never as a published configuration.
func executionAgentCapacityEnvelope(agent ports.ExecutionAgent) ports.ExecutionAgent {
	id := strings.Repeat("x", ports.MaximumExecutionIdentifierBytes)
	reason := strings.Repeat("\x00", ports.MaximumExecutionTextUnits)
	agent.PrincipalIDs = []string{id}
	agent.AccessRevision, agent.DefaultModelProfileID = id, id
	agent.OperationID, agent.AgentSpecRevision, agent.ExecutionRevision = &id, &id, &id
	agent.UnavailableReason = &reason
	agent.AcceptingRuns = false
	agent.AuthorizationRevision = ports.MaximumExecutionRevision
	agent.Runtime = &ports.ExecutionRuntime{RuntimeRevision: id, RuntimeExecutionID: id, MCPEndpoint: strings.Repeat("\x00", ports.MaximumExecutionEndpointBytes)}
	return agent
}

func largerExecutionAgent(current, target ports.ExecutionAgent) (ports.ExecutionAgent, error) {
	currentJSON, currentErr := json.Marshal(current)
	targetJSON, targetErr := json.Marshal(target)
	if currentErr != nil || targetErr != nil {
		return ports.ExecutionAgent{}, ports.ErrInvalidExecutionConfiguration
	}
	if len(targetJSON) > len(currentJSON) {
		return target, nil
	}
	return current, nil
}
