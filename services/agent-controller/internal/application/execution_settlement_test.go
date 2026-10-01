package application

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type settlementClientStub struct {
	*executionPublicationClientStub
	settle func(context.Context, ports.AgentSettlementRequest) (ports.AgentSettlementResult, error)
}

func (client settlementClientStub) SettleAgent(ctx context.Context, request ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
	return client.settle(ctx, request)
}

func settlementRequest() ports.LifecycleSettlementRequest {
	return ports.LifecycleSettlementRequest{OrganizationID: "org-1", AgentID: "agent-1", OperationID: "operation-1", Mode: "wait", DeadlineAt: time.Now().Add(time.Minute)}
}

func TestExecutionSettlementPublishesClosedCurrentOperationBeforeWaiting(t *testing.T) {
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionNotSettled, ports.ExecutionRuntimeBarrierRequired} {
		t.Run(outcome, func(t *testing.T) {
			request := settlementRequest()
			source := executionSource(t)
			source.Agents[0].Agent.ActiveOperationRequestID = request.OperationID
			var stages []string
			store := &executionPublicationStoreStub{
				read: func(context.Context, string) (ports.ExecutionSource, error) {
					stages = append(stages, "read")
					return source, nil
				},
				record: func(context.Context, ports.ExecutionAcknowledgement) error {
					stages = append(stages, "record")
					return nil
				},
			}
			client := settlementClientStub{
				executionPublicationClientStub: &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
					stages = append(stages, "apply")
					require.False(t, snapshot.Agents[0].AcceptingRuns)
					return ports.ExecutionAcknowledgement{OrganizationID: request.OrganizationID, AppliedRevision: source.Revision}, nil
				}},
				settle: func(ctx context.Context, input ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
					stages = append(stages, "settle")
					require.Equal(t, ports.AgentSettlementRequest{OrganizationID: request.OrganizationID, AgentID: request.AgentID, OperationID: request.OperationID, MinimumRevision: source.Revision, Mode: "wait", DeadlineAt: request.DeadlineAt}, input)
					deadline, ok := ctx.Deadline()
					require.True(t, ok)
					require.Equal(t, request.DeadlineAt, deadline)
					return ports.AgentSettlementResult{AppliedRevision: source.Revision + 1, Outcome: outcome}, nil
				},
			}
			result, err := NewExecutionPublisher(store, &executionCredentialOpener{}, client).CloseAndSettle(t.Context(), request)
			require.NoError(t, err)
			require.Equal(t, outcome, result.Outcome)
			require.Equal(t, []string{"read", "apply", "record", "settle"}, stages)
		})
	}
}

func TestExecutionSettlementRejectsReplacedOrMissingOperationBeforeSending(t *testing.T) {
	for _, scenario := range []string{"other-operation", "open", "missing-agent"} {
		t.Run(scenario, func(t *testing.T) {
			source := executionSource(t)
			if scenario == "other-operation" {
				source.Agents[0].Agent.ActiveOperationRequestID = "new-operation"
			}
			if scenario == "missing-agent" {
				source.Agents = nil
			}
			store := &executionPublicationStoreStub{read: func(context.Context, string) (ports.ExecutionSource, error) { return source, nil }}
			result, err := NewExecutionPublisher(store, &executionCredentialOpener{}, settlementClientStub{}).CloseAndSettle(t.Context(), settlementRequest())
			require.ErrorIs(t, err, ports.ErrConcurrentChange)
			require.Empty(t, result)
		})
	}
}

func TestExecutionSettlementPublicationFailureNeverCallsSettlement(t *testing.T) {
	for _, stage := range []string{"read", "credential", "apply", "record"} {
		t.Run(stage, func(t *testing.T) {
			source := executionSource(t)
			source.Agents[0].Agent.ActiveOperationRequestID = "operation-1"
			failure := errors.New("synthetic " + stage + " failure")
			store := &executionPublicationStoreStub{
				read: func(context.Context, string) (ports.ExecutionSource, error) {
					if stage == "read" {
						return source, failure
					}
					return source, nil
				},
				record: func(context.Context, ports.ExecutionAcknowledgement) error { return failure },
			}
			opener := &executionCredentialOpener{}
			if stage == "credential" {
				opener.err = failure
			}
			client := settlementClientStub{executionPublicationClientStub: &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
				if stage == "apply" {
					return ports.ExecutionAcknowledgement{}, failure
				}
				return ports.ExecutionAcknowledgement{OrganizationID: "org-1", AppliedRevision: source.Revision}, nil
			}}}
			result, err := NewExecutionPublisher(store, opener, client).CloseAndSettle(t.Context(), settlementRequest())
			if stage == "credential" {
				require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
			} else {
				require.ErrorIs(t, err, failure)
			}
			require.Empty(t, result)
		})
	}
}

func TestExecutionSettlementDoesNotBlockConcurrentPublication(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		source := executionSource(t)
		source.Agents[0].Agent.ActiveOperationRequestID = "operation-1"
		store := &executionPublicationStoreStub{
			read:   func(context.Context, string) (ports.ExecutionSource, error) { return source, nil },
			record: func(context.Context, ports.ExecutionAcknowledgement) error { return nil },
		}
		entered, release := make(chan struct{}), make(chan struct{})
		client := settlementClientStub{
			executionPublicationClientStub: &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
				return ports.ExecutionAcknowledgement{OrganizationID: "org-1", AppliedRevision: source.Revision}, nil
			}},
			settle: func(context.Context, ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
				close(entered)
				<-release
				return ports.AgentSettlementResult{AppliedRevision: source.Revision, Outcome: ports.ExecutionSettled}, nil
			},
		}
		publisher := NewExecutionPublisher(store, &executionCredentialOpener{}, client)
		done := make(chan error, 1)
		go func() { _, err := publisher.CloseAndSettle(t.Context(), settlementRequest()); done <- err }()
		<-entered
		_, err := publisher.Publish(t.Context(), "org-1")
		require.NoError(t, err)
		close(release)
		require.NoError(t, <-done)
		require.Empty(t, publisher.active)
	})
}

func TestExecutionSettlementDeadlineIncludesPublicationGate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		publisher := NewExecutionPublisher(&executionPublicationStoreStub{}, &executionCredentialOpener{}, settlementClientStub{})
		release, err := publisher.acquire(t.Context(), "org-1")
		require.NoError(t, err)
		request := settlementRequest()
		result, err := publisher.CloseAndSettle(t.Context(), request)
		require.ErrorIs(t, err, context.DeadlineExceeded)
		require.Empty(t, result)
		release()
		require.Empty(t, publisher.active)
	})
}

func TestExecutionSettlementLostResponseRetryPreservesCancelOperationAndDeadline(t *testing.T) {
	request := settlementRequest()
	request.Mode = "cancel"
	source := executionSource(t)
	source.Agents[0].Agent.ActiveOperationRequestID = request.OperationID
	store := &executionPublicationStoreStub{
		read:   func(context.Context, string) (ports.ExecutionSource, error) { return source, nil },
		record: func(context.Context, ports.ExecutionAcknowledgement) error { return nil },
	}
	var requests []ports.AgentSettlementRequest
	lost := errors.New("synthetic lost settlement response")
	client := settlementClientStub{
		executionPublicationClientStub: &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
			return ports.ExecutionAcknowledgement{OrganizationID: source.OrganizationID, AppliedRevision: source.Revision}, nil
		}},
		settle: func(_ context.Context, input ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
			requests = append(requests, input)
			if len(requests) == 1 {
				return ports.AgentSettlementResult{}, lost
			}
			return ports.AgentSettlementResult{AppliedRevision: source.Revision, Outcome: ports.ExecutionSettled}, nil
		},
	}
	publisher := NewExecutionPublisher(store, &executionCredentialOpener{}, client)
	_, err := publisher.CloseAndSettle(t.Context(), request)
	require.ErrorIs(t, err, lost)
	source.Revision++
	_, err = publisher.CloseAndSettle(t.Context(), request)
	require.NoError(t, err)
	require.Len(t, requests, 2)
	for _, observed := range requests {
		require.Equal(t, request.OperationID, observed.OperationID)
		require.Equal(t, request.DeadlineAt, observed.DeadlineAt)
		require.Equal(t, "cancel", observed.Mode)
	}
	require.Greater(t, requests[1].MinimumRevision, requests[0].MinimumRevision)
}
