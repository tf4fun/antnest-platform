package application

import (
	"context"
	"errors"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func workspaceStateFixture() ports.WorkspaceAgentRecord {
	return ports.WorkspaceAgentRecord{AgentID: "agent-1", LifecycleState: domain.AgentAvailable,
		DesiredState: domain.DesiredEnabled, AggregateSequence: 3, AccessSubject: "private"}
}

func TestWorkspaceStateProjectsLifecycleAndOwnedActiveSession(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		change       func(*ports.WorkspaceAgentRecord)
		availability WorkspaceAvailability
		session      string
	}{
		{"idle", func(*ports.WorkspaceAgentRecord) {}, WorkspaceAgentReady, ""},
		{"active", func(r *ports.WorkspaceAgentRecord) {
			r.AdmissionState = domain.AdmissionActive
			r.SessionID = "s1"
			r.AdmissionPrincipalID = "user-1"
		}, WorkspaceAgentBusy, "s1"},
		{"other principal", func(r *ports.WorkspaceAgentRecord) {
			r.AdmissionState = domain.AdmissionActive
			r.SessionID = "private-session"
			r.AdmissionPrincipalID = "user-2"
		}, WorkspaceAgentBusy, ""},
		{"blocked", func(r *ports.WorkspaceAgentRecord) {
			r.AdmissionState = domain.AdmissionBlockedUnknownEffect
			r.SessionID = "s1"
			r.AdmissionPrincipalID = "user-1"
		}, WorkspaceAgentOffline, ""},
		{"rebuild", func(r *ports.WorkspaceAgentRecord) { r.ActiveOperation = true }, WorkspaceAgentOffline, ""},
		{"disabled intent", func(r *ports.WorkspaceAgentRecord) { r.DesiredState = domain.DesiredDisabled }, WorkspaceAgentOffline, ""},
		{"draining", func(r *ports.WorkspaceAgentRecord) {
			r.ActiveOperation = true
			r.AdmissionState = domain.AdmissionActive
			r.SessionID = "s1"
			r.AdmissionPrincipalID = "user-1"
		}, WorkspaceAgentOffline, "s1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			record := workspaceStateFixture()
			tc.change(&record)
			store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{record}}
			got, err := NewAgentQueryService(store).GetWorkspaceAgentState(context.Background(), WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"})
			if err != nil || got.Availability != tc.availability || got.ActiveSessionID != tc.session || !got.AccessAllowed || got.AgentRevision != 3 {
				t.Fatalf("state=%+v err=%v", got, err)
			}
			if store.workspaceQuery.AgentID != "agent-1" || store.workspaceQuery.OrganizationID != "org-1" || store.workspaceQuery.PrincipalID != "user-1" {
				t.Fatalf("query=%+v", store.workspaceQuery)
			}
		})
	}
}

func TestWorkspaceStateRejectsInaccessibleAndMalformedRows(t *testing.T) {
	t.Parallel()
	revoked := workspaceStateFixture()
	revoked.IdentityRevoked = true
	foreign := workspaceStateFixture()
	foreign.AgentID = "foreign"
	for _, tc := range []struct {
		name string
		rows []ports.WorkspaceAgentRecord
		want error
	}{
		{"missing", nil, ErrAgentNotFound}, {"revoked", []ports.WorkspaceAgentRecord{revoked}, ErrAgentNotFound},
		{"foreign result", []ports.WorkspaceAgentRecord{foreign}, ErrQueryContract},
		{"duplicate", []ports.WorkspaceAgentRecord{workspaceStateFixture(), workspaceStateFixture()}, ErrQueryContract},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := NewAgentQueryService(&agentQueryStoreStub{workspaceRecords: tc.rows}).GetWorkspaceAgentState(context.Background(), WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
		})
	}
}

type workspaceWakeStub struct {
	signal    chan struct{}
	subscribe func()
	err       error
}

func (n *workspaceWakeStub) SubscribeAgentEvents() (<-chan struct{}, error) {
	if n.subscribe != nil {
		n.subscribe()
	}
	return n.signal, n.err
}
func (n *workspaceWakeStub) wake() { close(n.signal); n.signal = make(chan struct{}) }

func TestWorkspaceStateWatchSubscribesBeforeReadAndTracksBusySessionReplacement(t *testing.T) {
	t.Parallel()
	store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{workspaceStateFixture()}}
	wake := &workspaceWakeStub{signal: make(chan struct{})}
	subscriptions := 0
	wake.subscribe = func() {
		subscriptions++
		if subscriptions == 1 {
			store.workspaceRecords[0].AdmissionState = domain.AdmissionActive
			store.workspaceRecords[0].SessionID = "s1"
			store.workspaceRecords[0].AdmissionPrincipalID = "user-1"
		}
	}
	service := NewAgentQueryService(store, WithWorkspaceStateNotifier(wake))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got []WorkspaceAgentState
	err := service.WatchWorkspaceAgentState(ctx, WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"}, func(state WorkspaceAgentState) error {
		got = append(got, state)
		if len(got) == 1 {
			store.workspaceRecords[0].SessionID = "s2"
			wake.wake()
		} else {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || len(got) != 2 || got[0].ActiveSessionID != "s1" || got[1].ActiveSessionID != "s2" {
		t.Fatalf("states=%+v error=%v", got, err)
	}
}

func TestWorkspaceStateWatchRevocationIsSanitizedAndTerminal(t *testing.T) {
	t.Parallel()
	store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{workspaceStateFixture()}}
	wake := &workspaceWakeStub{signal: make(chan struct{})}
	var got []WorkspaceAgentState
	err := NewAgentQueryService(store, WithWorkspaceStateNotifier(wake)).WatchWorkspaceAgentState(context.Background(), WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"}, func(state WorkspaceAgentState) error {
		got = append(got, state)
		if len(got) == 1 {
			store.workspaceRecords = nil
			wake.wake()
		}
		return nil
	})
	if err != nil || len(got) != 2 || got[1].AccessAllowed || got[1].ActiveSessionID != "" || got[1].Availability != WorkspaceAgentOffline || got[1].AgentRevision != 3 {
		t.Fatalf("states=%+v error=%v", got, err)
	}
}

func TestWorkspaceStateWatchCoalescesDuplicateHintsButEmitsRevisionChanges(t *testing.T) {
	t.Parallel()
	store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{workspaceStateFixture()}}
	wake := &workspaceWakeStub{signal: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	subscriptions := 0
	wake.subscribe = func() {
		subscriptions++
		if subscriptions == 2 {
			close(wake.signal)
		}
		if subscriptions == 3 {
			wake.signal = make(chan struct{})
			store.workspaceRecords[0].AggregateSequence++
		}
	}
	var got []WorkspaceAgentState
	err := NewAgentQueryService(store, WithWorkspaceStateNotifier(wake)).WatchWorkspaceAgentState(ctx, WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"}, func(state WorkspaceAgentState) error {
		got = append(got, state)
		if len(got) == 1 {
			wake.wake()
		} else {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || len(got) != 2 || got[0].AgentRevision != 3 || got[1].AgentRevision != 4 || subscriptions != 3 {
		t.Fatalf("snapshots=%+v subscriptions=%d error=%v", got, subscriptions, err)
	}
}

func TestWorkspaceStateWatchPropagatesFailuresWithoutInventingState(t *testing.T) {
	t.Parallel()
	want := errors.New("test failure")
	for _, failure := range []string{"read", "notifier", "emitter"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{workspaceStateFixture()}}
			wake := &workspaceWakeStub{signal: make(chan struct{})}
			emitted := 0
			err := NewAgentQueryService(store, WithWorkspaceStateNotifier(wake)).WatchWorkspaceAgentState(context.Background(), WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"}, func(WorkspaceAgentState) error {
				emitted++
				switch failure {
				case "read":
					store.err = want
				case "notifier":
					wake.err = want
				case "emitter":
					return want
				}
				wake.wake()
				return nil
			})
			if !errors.Is(err, want) || emitted != 1 {
				t.Fatalf("emitted=%d error=%v", emitted, err)
			}
		})
	}
}

func TestWorkspaceStateValidatesInputBeforeRead(t *testing.T) {
	t.Parallel()
	for _, input := range []WorkspaceStateInput{{}, {OrganizationID: "org", PrincipalID: "user"}, {OrganizationID: "org", AgentID: "agent"}, {PrincipalID: "user", AgentID: "agent"}} {
		store := &agentQueryStoreStub{}
		_, err := NewAgentQueryService(store).GetWorkspaceAgentState(context.Background(), input)
		if !errors.Is(err, ErrInvalidInput) || store.workspaceQuery.AgentID != "" {
			t.Fatalf("input=%+v error=%v query=%+v", input, err, store.workspaceQuery)
		}
	}
}

type workspaceReadRaceStore struct {
	*agentQueryStoreStub
	afterRead func()
}

func (store *workspaceReadRaceStore) ListWorkspaceAgents(ctx context.Context, query ports.WorkspaceAgentQuery) ([]ports.WorkspaceAgentRecord, error) {
	rows, err := store.agentQueryStoreStub.ListWorkspaceAgents(ctx, query)
	snapshot := append([]ports.WorkspaceAgentRecord(nil), rows...)
	if store.afterRead != nil {
		store.afterRead()
	}
	return snapshot, err
}

func TestWorkspaceStateCommitDuringReadIsNotLost(t *testing.T) {
	t.Parallel()
	wake := &workspaceWakeStub{signal: make(chan struct{})}
	store := &workspaceReadRaceStore{agentQueryStoreStub: &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{workspaceStateFixture()}}}
	store.afterRead = func() {
		store.afterRead = nil
		store.workspaceRecords[0].AdmissionState = domain.AdmissionActive
		store.workspaceRecords[0].AdmissionPrincipalID = "user-1"
		store.workspaceRecords[0].SessionID = "session-1"
		wake.wake()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var states []WorkspaceAgentState
	err := NewAgentQueryService(store, WithWorkspaceStateNotifier(wake)).WatchWorkspaceAgentState(ctx, WorkspaceStateInput{OrganizationID: "org-1", PrincipalID: "user-1", AgentID: "agent-1"}, func(state WorkspaceAgentState) error {
		states = append(states, state)
		if len(states) == 2 {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || len(states) != 2 || states[0].Availability != WorkspaceAgentReady || states[1].ActiveSessionID != "session-1" {
		t.Fatalf("states=%+v error=%v", states, err)
	}
}
