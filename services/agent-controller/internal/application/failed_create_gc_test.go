package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type failedCreateGCStoreStub struct {
	candidates []ports.FailedCreateGCCandidate
	err        error
	calls      int
	cutoff     time.Time
	limit      int
}

func (stub *failedCreateGCStoreStub) ListFailedCreateGCCandidates(
	_ context.Context, cutoff time.Time, limit int,
) ([]ports.FailedCreateGCCandidate, error) {
	stub.calls++
	stub.cutoff, stub.limit = cutoff, limit
	return stub.candidates, stub.err
}

type failedCreateGCCommandsStub struct {
	calls    []ports.FailedCreateGCCandidate
	cutoffs  []time.Time
	failures map[string]error
}

func (stub *failedCreateGCCommandsStub) DeleteFailedCreate(
	_ context.Context, candidate ports.FailedCreateGCCandidate, cutoff time.Time,
) error {
	stub.calls = append(stub.calls, candidate)
	stub.cutoffs = append(stub.cutoffs, cutoff)
	return stub.failures[candidate.AgentID]
}

func gcFixedClock(now time.Time) ports.Clock {
	return gcClock{now: now}
}

type gcClock struct{ now time.Time }

func (clock gcClock) Now() time.Time { return clock.now }

func gcCandidate(agentID, requestID string) ports.FailedCreateGCCandidate {
	return ports.FailedCreateGCCandidate{
		AgentID: agentID, OrganizationID: "org-1",
		CreateRequestID: requestID, AggregateSequence: 5,
	}
}

func TestFailedCreateGCWorkerValidatesDependencies(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	store := &failedCreateGCStoreStub{}
	commands := &failedCreateGCCommandsStub{}
	clock := gcFixedClock(now)
	if _, err := NewFailedCreateGCWorker(nil, commands, clock, time.Hour, 10); err == nil {
		t.Fatal("nil store must fail")
	}
	if _, err := NewFailedCreateGCWorker(store, nil, clock, time.Hour, 10); err == nil {
		t.Fatal("nil commands must fail")
	}
	if _, err := NewFailedCreateGCWorker(store, commands, nil, time.Hour, 10); err == nil {
		t.Fatal("nil clock must fail")
	}
	if _, err := NewFailedCreateGCWorker(store, commands, clock, -time.Hour, 10); err == nil {
		t.Fatal("negative TTL must fail")
	}
	for _, limit := range []int{0, -1, 501} {
		if _, err := NewFailedCreateGCWorker(store, commands, clock, time.Hour, limit); err == nil {
			t.Fatalf("limit %d must fail", limit)
		}
	}
	if _, err := NewFailedCreateGCWorker(store, commands, clock, time.Hour, 100); err != nil {
		t.Fatalf("valid worker: %v", err)
	}
}

func TestFailedCreateGCWorkerFrozenCutoffAndLimits(t *testing.T) {
	now := time.Unix(2000, 0).UTC()
	store := &failedCreateGCStoreStub{candidates: []ports.FailedCreateGCCandidate{
		gcCandidate("agent-1", "create-1"), gcCandidate("agent-2", "create-2"),
	}}
	commands := &failedCreateGCCommandsStub{failures: map[string]error{
		"agent-1": errors.New("delete refused"),
	}}
	worker, err := NewFailedCreateGCWorker(store, commands, gcFixedClock(now), 7*24*time.Hour, 42)
	require.NoError(t, err)
	err = worker.RunOnce(t.Context())
	require.Error(t, err)
	require.Contains(t, err.Error(), "delete refused")
	require.Equal(t, 1, store.calls)
	require.Equal(t, now.Add(-7*24*time.Hour), store.cutoff)
	require.Equal(t, 42, store.limit)
	require.Len(t, commands.calls, 2, "one failure must not starve the other candidate")
	require.Equal(t, "agent-1", commands.calls[0].AgentID)
	require.Equal(t, "agent-2", commands.calls[1].AgentID)
	require.Equal(t, store.cutoff, commands.cutoffs[0])
	require.Equal(t, store.cutoff, commands.cutoffs[1])
}

func TestFailedCreateGCWorkerDisabledTTLDoesNothing(t *testing.T) {
	store := &failedCreateGCStoreStub{}
	commands := &failedCreateGCCommandsStub{}
	worker, err := NewFailedCreateGCWorker(store, commands, gcFixedClock(time.Now()), 0, 100)
	require.NoError(t, err)
	require.NoError(t, worker.RunOnce(t.Context()))
	require.Equal(t, 0, store.calls)
	require.Empty(t, commands.calls)
}

func TestFailedCreateGCWorkerListErrorPropagates(t *testing.T) {
	store := &failedCreateGCStoreStub{err: errors.New("offline")}
	worker, err := NewFailedCreateGCWorker(store, &failedCreateGCCommandsStub{},
		gcFixedClock(time.Now()), time.Hour, 100)
	require.NoError(t, err)
	err = worker.RunOnce(t.Context())
	require.Error(t, err)
	require.Contains(t, err.Error(), "offline")
}

func TestFailedCreateGCWorkerHonoursCancellation(t *testing.T) {
	store := &failedCreateGCStoreStub{candidates: []ports.FailedCreateGCCandidate{
		gcCandidate("agent-1", "create-1"), gcCandidate("agent-2", "create-2"),
	}}
	worker, err := NewFailedCreateGCWorker(store, &failedCreateGCCommandsStub{},
		gcFixedClock(time.Now()), time.Hour, 100)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = worker.RunOnce(ctx)
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, 0, store.calls, "canceled sweep must not query the store")
}

type gcDeleteStoreStub struct {
	ports.LifecycleStore
	base       ports.AgentDeleteBase
	baseErr    error
	replayErr  error
	begin      ports.BeginAgentDelete
	beginState ports.AgentDeleteState
	beginErr   error
	beginCalls int
}

func (stub *gcDeleteStoreStub) GetAgentDeleteBase(context.Context, string) (ports.AgentDeleteBase, error) {
	return stub.base, stub.baseErr
}

func (stub *gcDeleteStoreStub) ReplayAgentDelete(context.Context, string, string) (ports.AgentDeleteState, bool, error) {
	return stub.beginState, false, stub.replayErr
}

func (stub *gcDeleteStoreStub) BeginAgentDelete(_ context.Context, input ports.BeginAgentDelete) (ports.AgentDeleteState, bool, error) {
	stub.beginCalls++
	stub.begin = input
	return stub.beginState, false, stub.beginErr
}

func gcDeleteInput() DeleteAgentInput {
	return DeleteAgentInput{
		RequestID: "request-delete", OrganizationID: "org-1",
		ActorPrincipalID: "system-failed-create-gc", AgentID: "agent-1",
	}
}

func TestDeleteAgentFailedCreateGuard(t *testing.T) {
	store := &gcDeleteStoreStub{base: ports.AgentDeleteBase{Agent: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1",
		LifecycleState: domain.AgentNotCreated, DesiredState: domain.DesiredEnabled,
		AggregateSequence: 5,
	}}}
	service := NewLifecycleService(nil, store, nil, nil, gcFixedClock(time.Unix(1000, 0).UTC()))
	input := gcDeleteInput()
	for _, scenario := range []struct {
		name      string
		candidate *ports.FailedCreateGCCandidate
		cutoff    time.Time
		code      error
	}{
		{"missing sequence", &ports.FailedCreateGCCandidate{AgentID: "agent-1", OrganizationID: "org-1", CreateRequestID: "create-1"}, time.Unix(100, 0), ErrInvalidInput},
		{"mismatched agent", &ports.FailedCreateGCCandidate{AgentID: "agent-2", OrganizationID: "org-1", CreateRequestID: "create-1", AggregateSequence: 5}, time.Unix(100, 0), ErrInvalidInput},
		{"mismatched org", &ports.FailedCreateGCCandidate{AgentID: "agent-1", OrganizationID: "org-2", CreateRequestID: "create-1", AggregateSequence: 5}, time.Unix(100, 0), ErrInvalidInput},
		{"empty create id", &ports.FailedCreateGCCandidate{AgentID: "agent-1", OrganizationID: "org-1", AggregateSequence: 5}, time.Unix(100, 0), ErrInvalidInput},
		{"zero cutoff", &ports.FailedCreateGCCandidate{AgentID: "agent-1", OrganizationID: "org-1", CreateRequestID: "create-1", AggregateSequence: 5}, time.Time{}, ErrInvalidInput},
		{"stale sequence", &ports.FailedCreateGCCandidate{AgentID: "agent-1", OrganizationID: "org-1", CreateRequestID: "create-1", AggregateSequence: 4}, time.Unix(100, 0), ErrLifecycleConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input.FailedCreate = scenario.candidate
			input.FailedCreateCutoff = scenario.cutoff
			_, err := service.DeleteAgent(t.Context(), input)
			require.ErrorIs(t, err, scenario.code)
			require.Equal(t, 0, store.beginCalls, "rejected candidates must not mutate")
		})
	}
	input.FailedCreate = &ports.FailedCreateGCCandidate{
		AgentID: "agent-1", OrganizationID: "org-1",
		CreateRequestID: "create-1", AggregateSequence: 5,
	}
	input.FailedCreateCutoff = time.Unix(100, 0).UTC()
	store.base.Agent.LifecycleState = domain.AgentCreated
	_, err := service.DeleteAgent(t.Context(), input)
	require.ErrorIs(t, err, ErrLifecycleConflict)
	require.Equal(t, 0, store.beginCalls)
	store.base.Agent.LifecycleState = domain.AgentNotCreated
	store.base.Agent.ActiveOperationRequestID = "request-active"
	_, err = service.DeleteAgent(t.Context(), input)
	require.ErrorIs(t, err, ErrLifecycleConflict)
	require.Equal(t, 0, store.beginCalls)
}

func TestDeleteAgentFailedCreateEmitsGuardedEvents(t *testing.T) {
	store := &gcDeleteStoreStub{base: ports.AgentDeleteBase{Agent: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1",
		LifecycleState: domain.AgentNotCreated, DesiredState: domain.DesiredEnabled,
		AggregateSequence: 5,
	}}}
	service := NewLifecycleService(nil, store, nil, nil, gcFixedClock(time.Unix(1000, 0).UTC()))
	input := gcDeleteInput()
	input.FailedCreate = &ports.FailedCreateGCCandidate{
		AgentID: "agent-1", OrganizationID: "org-1",
		CreateRequestID: "create-1", AggregateSequence: 5,
	}
	input.FailedCreateCutoff = time.Unix(100, 0).UTC()
	_, err := service.DeleteAgent(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, 1, store.beginCalls)
	require.NotNil(t, store.begin.FailedCreate)
	require.Equal(t, "create-1", store.begin.FailedCreate.CreateRequestID)
	require.Equal(t, input.FailedCreateCutoff, store.begin.FailedCreateCutoff)
	require.NotNil(t, store.begin.GCEvent)
	require.Equal(t, ports.EventAgentGCScheduled, store.begin.GCEvent.EventType)
	require.Equal(t, int64(7), store.begin.GCEvent.AggregateSequence)
	require.Equal(t, "request-delete", store.begin.GCEvent.OperationRequestID)
	require.Equal(t, int64(6), store.begin.RequestedEvent.AggregateSequence)
	require.Equal(t, ports.EventAgentDeleteRequested, store.begin.RequestedEvent.EventType)
}
