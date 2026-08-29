package admission

import (
	"context"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
	"soft/antnest-platform/services/runtime-controller/internal/runtimeconn"
)

func TestStoreAuthenticatesAndAdmitsCurrentGeneration(t *testing.T) {
	issuer, err := NewIssuer([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	token, err := issuer.Token("agent-1", 2)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	state := &fakeState{
		runtime: domain.Runtime{
			AgentID: "agent-1", DesiredState: domain.DesiredActive,
			DesiredGeneration: 2, ConnectionEpoch: 4,
			NetworkMode: domain.NetworkUnrestricted, NetworkPolicyEpoch: 3,
		},
		generation: domain.RuntimeGeneration{
			AgentID: "agent-1", Number: 2, RuntimeInstanceID: "instance-2",
			TunnelIPv4: "100.64.0.3", AllocatorEpoch: 2,
		},
	}
	lifecycle := &fakeLifecycle{}
	store, err := NewStore(state, lifecycle, issuer, fixedAdmissionClock())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}

	result, err := store.AdmitRuntimeSession(context.Background(), runtimeconn.AdmissionRequest{
		Token: token, RuntimeInstanceID: "instance-2", Generation: 2,
		RuntimeBootID: "boot-1", Capabilities: completeCapabilities(),
	})
	if err != nil {
		t.Fatalf("admit: %v", err)
	}
	if lifecycle.connected.ConnectionEpoch != 5 || result.AgentID != "agent-1" ||
		result.ConnectionEpoch != 5 || result.PolicyEpoch != 3 {
		t.Fatalf("unexpected admission: connected=%+v result=%+v", lifecycle.connected, result)
	}
}

func TestStoreRejectsIncompleteRuntimeCapabilities(t *testing.T) {
	issuer, err := NewIssuer([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	state := &fakeState{
		runtime: domain.Runtime{
			AgentID: "agent-1", DesiredState: domain.DesiredActive,
			DesiredGeneration: 2, NetworkMode: domain.NetworkRestricted,
		},
		generation: domain.RuntimeGeneration{
			AgentID: "agent-1", Number: 2, RuntimeInstanceID: "instance-2",
		},
	}
	store, err := NewStore(state, &fakeLifecycle{}, issuer, fixedAdmissionClock())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	token, err := issuer.Token("agent-1", 2)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	_, err = store.AdmitRuntimeSession(context.Background(), runtimeconn.AdmissionRequest{
		Token: token, RuntimeInstanceID: "instance-2", Generation: 2,
		RuntimeBootID: "boot-1", Capabilities: []string{"process.exec"},
	})
	if err == nil {
		t.Fatal("incomplete Runtime capability set was admitted")
	}
}

func TestStoreRejectsWrongTokenAndStaleGeneration(t *testing.T) {
	issuer, err := NewIssuer([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	state := &fakeState{
		runtime:    domain.Runtime{AgentID: "agent-1", DesiredState: domain.DesiredActive, DesiredGeneration: 2},
		generation: domain.RuntimeGeneration{AgentID: "agent-1", Number: 2, RuntimeInstanceID: "instance-2"},
	}
	store, err := NewStore(state, &fakeLifecycle{}, issuer, fixedAdmissionClock())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	for _, request := range []runtimeconn.AdmissionRequest{
		{Token: "wrong", RuntimeInstanceID: "instance-2", Generation: 2},
		{Token: "wrong", RuntimeInstanceID: "instance-2", Generation: 1},
	} {
		if _, err := store.AdmitRuntimeSession(context.Background(), request); err == nil {
			t.Fatalf("invalid admission accepted: %+v", request)
		}
	}
}

type fakeState struct {
	runtime    domain.Runtime
	generation domain.RuntimeGeneration
}

func (s *fakeState) GetRuntime(context.Context, string) (domain.Runtime, error) {
	return s.runtime, nil
}

func (s *fakeState) FindGenerationByInstanceID(context.Context, string) (domain.RuntimeGeneration, error) {
	return s.generation, nil
}

type fakeLifecycle struct {
	connected    application.ConnectedInput
	healthy      application.HealthyInput
	disconnected application.DisconnectedInput
}

func (l *fakeLifecycle) RuntimeConnected(_ context.Context, input application.ConnectedInput) (domain.Runtime, error) {
	l.connected = input
	return domain.Runtime{}, nil
}

func (l *fakeLifecycle) RuntimeHealthy(_ context.Context, input application.HealthyInput) (domain.Runtime, error) {
	l.healthy = input
	return domain.Runtime{Status: domain.RuntimeReady}, nil
}

func (l *fakeLifecycle) RuntimeDisconnected(_ context.Context, input application.DisconnectedInput) error {
	l.disconnected = input
	return nil
}

func fixedAdmissionClock() func() time.Time {
	return func() time.Time { return time.Date(2026, 8, 28, 9, 10, 11, 0, time.UTC) }
}

func completeCapabilities() []string {
	return []string{
		"work.begin", "work.end", "process.exec", "file.read",
		"file.write", "file.edit", "file.list", "operation.cancel",
	}
}
