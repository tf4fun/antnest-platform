package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const runtimePublicationToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

type executionRuntimeResolverFunc func(context.Context, string, string, string) (ports.RuntimeConnection, error)

func (resolve executionRuntimeResolverFunc) ResolveRuntimeConnection(ctx context.Context, agent, revision, execution string) (ports.RuntimeConnection, error) {
	return resolve(ctx, agent, revision, execution)
}

func fixtureExecutionRuntimeResolver() executionRuntimeResolverFunc {
	return func(_ context.Context, agent, revision, execution string) (ports.RuntimeConnection, error) {
		return ports.RuntimeConnection{
			AgentID: agent, RuntimeRevision: revision, RuntimeExecutionID: execution,
			ConnectionID: "rci_22222222222222222222222222222222",
			MCPEndpoint:  "http://antnest-runtime-" + agent + ":8093/mcp",
			Credential:   ports.RuntimeCredential{Caller: "agent-acp-service", Token: runtimePublicationToken},
		}, nil
	}
}

func executableRuntimeSource(t *testing.T) ports.ExecutionSource {
	t.Helper()
	source := executionSource(t)
	source.Agents[0].Agent.RuntimeRevision = "rtv_11111111111111111111111111111111"
	source.Agents[0].Agent.RuntimeMCPEndpoint = "http://antnest-runtime-agent-1:8093/mcp"
	return source
}

func TestExecutablePublicationWithoutRuntimeResolverCannotApplyOrAcknowledge(t *testing.T) {
	source := executionSource(t)
	applies, records := 0, 0
	store := &executionPublicationStoreStub{
		read:   func(context.Context, string) (ports.ExecutionSource, error) { return source, nil },
		record: func(context.Context, ports.ExecutionAcknowledgement) error { records++; return nil },
	}
	client := &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
		applies++
		return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
	}}
	ack, err := NewExecutionPublisher(store, &executionCredentialOpener{}, client).Publish(t.Context(), source.OrganizationID)
	require.Error(t, err, "an executable publication cannot omit the current private Runtime authority")
	require.Empty(t, ack)
	require.Zero(t, applies)
	require.Zero(t, records)
}

func TestRuntimePublicationResolvesEachCurrentBindingBeforePrivateApply(t *testing.T) {
	source := executableRuntimeSource(t)
	var stages []string
	resolver := executionRuntimeResolverFunc(func(ctx context.Context, agent, revision, execution string) (ports.RuntimeConnection, error) {
		stages = append(stages, "resolve")
		require.Equal(t, source.Agents[0].Agent.AgentID, agent)
		require.Equal(t, source.Agents[0].Agent.RuntimeRevision, revision)
		require.Equal(t, source.Agents[0].Agent.RuntimeExecutionID, execution)
		return fixtureExecutionRuntimeResolver()(ctx, agent, revision, execution)
	})
	store := &executionPublicationStoreStub{
		read: func(context.Context, string) (ports.ExecutionSource, error) {
			stages = append(stages, "read")
			return source, nil
		},
		record: func(_ context.Context, ack ports.ExecutionAcknowledgement) error {
			stages = append(stages, "record")
			encoded, err := json.Marshal(ack)
			require.NoError(t, err)
			require.NotContains(t, string(encoded), runtimePublicationToken)
			return nil
		},
	}
	client := &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
		stages = append(stages, "apply")
		require.NoError(t, snapshot.ValidateForPublication())
		runtime := snapshot.Agents[0].Runtime
		require.Equal(t, runtimePublicationToken, runtime.Credential.Token)
		require.Equal(t, "rci_22222222222222222222222222222222", runtime.ConnectionID)
		return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
	}}
	publisher := NewExecutionPublisher(store, &executionCredentialOpener{}, client, WithRuntimeConnectionResolver(resolver))
	for range 2 {
		_, err := publisher.Publish(t.Context(), source.OrganizationID)
		require.NoError(t, err)
	}
	source.Revision++
	source.Agents[0].Agent.RuntimeExecutionID = "boot-restarted"
	_, err := publisher.Publish(t.Context(), source.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, []string{"read", "resolve", "apply", "record", "read", "resolve", "apply", "record", "read", "resolve", "apply", "record"}, stages)
	encoded, err := json.Marshal(source)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), runtimePublicationToken, "the source/store must never gain raw Runtime credentials")
}

func TestClosedPublicationNeverResolvesOrTransfersRuntimeAuthority(t *testing.T) {
	for _, scenario := range []string{"drain", "revoked", "unhealthy", "disabled", "deleted"} {
		t.Run(scenario, func(t *testing.T) {
			source := executableRuntimeSource(t)
			agent := &source.Agents[0].Agent
			switch scenario {
			case "drain":
				agent.ActiveOperationRequestID = "operation-1"
			case "revoked":
				agent.IdentityRevocationSequence = 1
			case "unhealthy":
				agent.RuntimeState = domain.RuntimeUnhealthy
			case "disabled":
				agent.DesiredState = domain.DesiredDisabled
			case "deleted":
				agent.LifecycleState = domain.AgentDeleted
			}
			calls := 0
			resolver := executionRuntimeResolverFunc(func(context.Context, string, string, string) (ports.RuntimeConnection, error) {
				calls++
				return ports.RuntimeConnection{}, errors.New("Runtime unavailable " + runtimePublicationToken)
			})
			store := &executionPublicationStoreStub{
				read:   func(context.Context, string) (ports.ExecutionSource, error) { return source, nil },
				record: func(context.Context, ports.ExecutionAcknowledgement) error { return nil },
			}
			client := &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
				for _, agent := range snapshot.Agents {
					require.False(t, agent.AcceptingRuns)
					if agent.Runtime != nil {
						require.Nil(t, agent.Runtime.Credential)
					}
				}
				require.NoError(t, snapshot.ValidateForPublication())
				return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
			}}
			_, err := NewExecutionPublisher(store, &executionCredentialOpener{}, client, WithRuntimeConnectionResolver(resolver)).Publish(t.Context(), source.OrganizationID)
			require.NoError(t, err)
			require.Zero(t, calls, "closing an Agent cannot depend on Runtime readiness")
		})
	}
}

func TestRuntimePublicationRejectsEveryMismatchedBindingBeforeApply(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		mutate func(*ports.RuntimeConnection)
	}{
		{"agent", func(c *ports.RuntimeConnection) { c.AgentID = "agent-other" }},
		{"revision", func(c *ports.RuntimeConnection) { c.RuntimeRevision = "rtv_33333333333333333333333333333333" }},
		{"execution", func(c *ports.RuntimeConnection) { c.RuntimeExecutionID = "boot-other" }},
		{"endpoint", func(c *ports.RuntimeConnection) { c.MCPEndpoint = "http://antnest-runtime-agent-1:8094/mcp" }},
		{"connection", func(c *ports.RuntimeConnection) { c.ConnectionID = "../file" }},
		{"caller", func(c *ports.RuntimeConnection) { c.Credential.Caller = "runtime-controller" }},
		{"token", func(c *ports.RuntimeConnection) { c.Credential.Token += "\n" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source := executableRuntimeSource(t)
			applies, records := 0, 0
			resolver := executionRuntimeResolverFunc(func(ctx context.Context, agent, revision, execution string) (ports.RuntimeConnection, error) {
				connection, err := fixtureExecutionRuntimeResolver()(ctx, agent, revision, execution)
				scenario.mutate(&connection)
				return connection, err
			})
			store := &executionPublicationStoreStub{
				read:   func(context.Context, string) (ports.ExecutionSource, error) { return source, nil },
				record: func(context.Context, ports.ExecutionAcknowledgement) error { records++; return nil },
			}
			client := &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
				applies++
				return ports.ExecutionAcknowledgement{}, nil
			}}
			_, err := NewExecutionPublisher(store, &executionCredentialOpener{}, client, WithRuntimeConnectionResolver(resolver)).Publish(t.Context(), source.OrganizationID)
			require.Error(t, err)
			require.NotContains(t, err.Error(), runtimePublicationToken)
			require.Zero(t, applies)
			require.Zero(t, records)
		})
	}
}

func TestRuntimePublicationHonorsCancellationAfterResolution(t *testing.T) {
	source := executableRuntimeSource(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	resolver := executionRuntimeResolverFunc(func(ctx context.Context, agent, revision, execution string) (ports.RuntimeConnection, error) {
		connection, err := fixtureExecutionRuntimeResolver()(ctx, agent, revision, execution)
		cancel()
		return connection, err
	})
	store := &executionPublicationStoreStub{read: func(context.Context, string) (ports.ExecutionSource, error) { return source, nil }}
	client := &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
		t.Error("cancelled publication reached ACP")
		return ports.ExecutionAcknowledgement{}, nil
	}}
	_, err := NewExecutionPublisher(store, &executionCredentialOpener{}, client, WithRuntimeConnectionResolver(resolver)).Publish(ctx, source.OrganizationID)
	require.ErrorIs(t, err, context.Canceled)
}
