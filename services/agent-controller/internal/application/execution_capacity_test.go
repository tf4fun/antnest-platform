package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionCapacityPreservesClosureBudgetWithoutAgents(t *testing.T) {
	source := executionSource(t)
	source.Agents = nil
	input := ports.ExecutionCapacityInput{Current: source}
	capacity, err := NewExecutionCapacity(&executionCredentialOpener{}, ports.DefaultExecutionSnapshotMaxBytes)
	require.NoError(t, err)
	bytes, err := capacity.RequiredBytes(t.Context(), input)
	require.NoError(t, err)
	snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	snapshot.Revision = ports.MaximumExecutionRevision
	snapshot.Providers[0].Enabled, snapshot.Models[0].Enabled = false, false
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	require.Equal(t, len(encoded), bytes)
	capacity, err = NewExecutionCapacity(&executionCredentialOpener{}, bytes)
	require.NoError(t, err)
	require.NoError(t, capacity.ValidateExecutionCapacity(t.Context(), input))
	input.Current.Providers[0].Enabled = false
	require.NoError(t, capacity.ValidateExecutionCapacity(t.Context(), input))
	input.Current.Models[0].Enabled = false
	require.NoError(t, capacity.ValidateExecutionCapacity(t.Context(), input))
	capacity, err = NewExecutionCapacity(&executionCredentialOpener{}, bytes-1)
	require.NoError(t, err)
	require.ErrorIs(t, capacity.ValidateExecutionCapacity(t.Context(), input), ports.ErrExecutionCapacityExceeded)
}

func TestExecutionCapacityBudgetsEscapingAndRegisteredTarget(t *testing.T) {
	source := executionSource(t)
	capacity, err := NewExecutionCapacity(&executionCredentialOpener{}, ports.DefaultExecutionSnapshotMaxBytes)
	require.NoError(t, err)
	base, err := capacity.RequiredBytes(t.Context(), ports.ExecutionCapacityInput{Current: source})
	require.NoError(t, err)
	target := source.Agents[0].Spec
	target.ID, target.Revision = "next-spec", 2
	target.Snapshot.SystemPrompt += strings.Repeat("\n\"<&\u0000经验", 100)
	input := ports.ExecutionCapacityInput{Current: source, Targets: []ports.AgentSpecRecord{target}}
	reserved, err := capacity.RequiredBytes(t.Context(), input)
	require.NoError(t, err)
	before, err := json.Marshal(source.Agents[0].Spec.Snapshot.SystemPrompt)
	require.NoError(t, err)
	after, err := json.Marshal(target.Snapshot.SystemPrompt)
	require.NoError(t, err)
	require.Equal(t, base+len(after)-len(before), reserved)
	require.Equal(t, "Organization assistant", source.Agents[0].Spec.Snapshot.SystemPrompt)

	input.Current.Agents[0].Spec = target
	input.Current.Agents[0].Agent.AgentSpecRevisionID = target.ID
	input.Current.Agents[0].Agent.ActiveOperationRequestID = strings.Repeat("x", 200)
	input.Current.Agents[0].Agent.RuntimeRevision = strings.Repeat("r", 200)
	input.Current.Agents[0].Agent.RuntimeExecutionID = strings.Repeat("e", 200)
	input.Current.Agents[0].Agent.RuntimeMCPEndpoint = "http://runtime/mcp?x=" + strings.Repeat("&", 1900)
	input.Targets = nil
	actual, err := BuildExecutionSnapshot(t.Context(), input.Current, &executionCredentialOpener{})
	require.NoError(t, err)
	encoded, err := json.Marshal(actual)
	require.NoError(t, err)
	require.LessOrEqual(t, len(encoded), reserved)
	next, err := capacity.RequiredBytes(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, reserved, next)
}

func TestExecutionCapacityRejectsUnpublishableTargets(t *testing.T) {
	for _, kind := range []string{"foreign", "duplicate", "missing-model", "empty-id", "invalid-source", "long-endpoint"} {
		t.Run(kind, func(t *testing.T) {
			source := executionSource(t)
			target := source.Agents[0].Spec
			input := ports.ExecutionCapacityInput{Current: source, Targets: []ports.AgentSpecRecord{target}}
			switch kind {
			case "foreign":
				input.Targets[0].AgentID = "foreign-agent"
			case "duplicate":
				input.Targets = append(input.Targets, target)
			case "missing-model":
				input.Targets[0].Snapshot.ModelProfileID = "missing"
			case "empty-id":
				input.Targets[0].ID = ""
			case "invalid-source":
				input.Current.Models = nil
			case "long-endpoint":
				input.Current.Agents[0].Agent.RuntimeMCPEndpoint += strings.Repeat("x", ports.MaximumExecutionEndpointBytes)
			}
			capacity, err := NewExecutionCapacity(&executionCredentialOpener{}, ports.DefaultExecutionSnapshotMaxBytes)
			require.NoError(t, err)
			_, err = capacity.RequiredBytes(t.Context(), input)
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
		})
	}
}

func TestExecutionCapacityCancellationAndSecretFailures(t *testing.T) {
	_, err := NewExecutionCapacity(&executionCredentialOpener{}, 0)
	require.Error(t, err)
	_, err = NewExecutionCapacity(nil, 100)
	require.Error(t, err)
	opener := &executionCredentialOpener{err: errors.New("synthetic-sensitive-error")}
	capacity, err := NewExecutionCapacity(opener, 1)
	require.NoError(t, err)
	input := ports.ExecutionCapacityInput{Current: executionSource(t)}
	err = capacity.ValidateExecutionCapacity(t.Context(), input)
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
	require.NotContains(t, err.Error(), "synthetic-sensitive-error")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, capacity.ValidateExecutionCapacity(ctx, input), context.Canceled)
}

func TestExecutionCapacityReservesRetainedFallbackAfterSmallerRebuild(t *testing.T) {
	source := executionSource(t)
	agent := &source.Agents[0]
	agent.RetainedSpec = agent.Spec
	agent.RetainedSpec.Snapshot.SystemPrompt = strings.Repeat("retained experience ", 500)
	agent.Agent.LastSuccessfulExecutionRevisionID = "last-success"
	agent.Spec.ID, agent.Spec.Revision = "smaller-unready-spec", 2
	agent.Agent.AgentSpecRevisionID = agent.Spec.ID
	agent.Agent.ExecutionRevisionID = ""
	capacity, err := NewExecutionCapacity(&executionCredentialOpener{}, ports.DefaultExecutionSnapshotMaxBytes)
	require.NoError(t, err)
	before, err := capacity.RequiredBytes(t.Context(), ports.ExecutionCapacityInput{Current: source})
	require.NoError(t, err)
	agent.Spec = agent.RetainedSpec
	agent.Agent.AgentSpecRevisionID = ""
	after, err := capacity.RequiredBytes(t.Context(), ports.ExecutionCapacityInput{Current: source})
	require.NoError(t, err)
	require.Equal(t, before, after, "failure fallback must not need additional capacity")
}
