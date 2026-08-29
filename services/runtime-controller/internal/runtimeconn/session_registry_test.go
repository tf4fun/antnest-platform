package runtimeconn

import (
	"context"
	"net/netip"
	"testing"
	"time"
)

func TestConnectProducesGenerationBoundRestrictedAdmission(t *testing.T) {
	store := &fakeAdmissionStore{admission: restrictedAdmission()}
	registry, err := NewRuntimeRegistry(store)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	registry.OpenAdmission()
	session := &runtimeSession{token: "01234567890123456789012345678901"}
	result, err := registry.connect(context.Background(), session, validConnectInput())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if result.AgentID != "agent-1" || result.ConnectionEpoch != 2 || result.EgressToken != "" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if store.request.Token == "" || store.request.Generation != 1 {
		t.Fatalf("unexpected admission request: %+v", store.request)
	}
}

func TestUnrestrictedAdmissionIssuesGenerationBoundEgressToken(t *testing.T) {
	admission := restrictedAdmission()
	admission.NetworkMode = "unrestricted"
	admission.TunnelVirtualIP = netip.MustParseAddr("100.64.0.2")
	admission.AllocatorEpoch = 1
	registry, err := NewRuntimeRegistry(&fakeAdmissionStore{admission: admission})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	registry.OpenAdmission()
	issuer := &fakeEgressIssuer{}
	if err := registry.SetEgress(issuer, "runtime-egress:8092"); err != nil {
		t.Fatalf("SetEgress() error = %v", err)
	}
	result, err := registry.connect(context.Background(), &runtimeSession{token: "token"}, validConnectInput())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if result.EgressToken != "egress-token" || result.EgressEndpoint != "runtime-egress:8092" ||
		result.EgressTokenExpires == 0 {
		t.Fatalf("missing egress token: %+v", result)
	}
	if issuer.input.RuntimeInstanceID != "instance-1" || issuer.input.ConnectionEpoch != 2 ||
		issuer.input.PolicyEpoch != 4 {
		t.Fatalf("unexpected issuer input: %+v", issuer.input)
	}
}

func TestNetworkReadyRequiresCurrentPolicy(t *testing.T) {
	admission := restrictedAdmission()
	admission.NetworkMode = "unrestricted"
	admission.TunnelVirtualIP = netip.MustParseAddr("100.64.0.2")
	admission.AllocatorEpoch = 1
	registry, _ := NewRuntimeRegistry(&fakeAdmissionStore{admission: admission})
	registry.OpenAdmission()
	_ = registry.SetEgress(&fakeEgressIssuer{}, "runtime-egress:8092")
	session := &runtimeSession{token: "token"}
	if _, err := registry.connect(context.Background(), session, validConnectInput()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := registry.networkReady(session, NetworkReadyInput{PolicyRevision: 3, PolicyEpoch: 5}); err == nil {
		t.Fatal("networkReady() error = nil, want policy fence")
	}
	if err := registry.networkReady(session, NetworkReadyInput{PolicyRevision: 3, PolicyEpoch: 4}); err != nil {
		t.Fatalf("networkReady() error = %v", err)
	}
}

func TestHeartbeatMakesRestrictedSessionReady(t *testing.T) {
	store := &fakeAdmissionStore{admission: restrictedAdmission()}
	registry, err := NewRuntimeRegistry(store)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	registry.OpenAdmission()
	session := &runtimeSession{token: "token"}
	if _, err := registry.connect(context.Background(), session, validConnectInput()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, ready := registry.Ready(session.key, 3, 4); ready {
		t.Fatal("session became ready before heartbeat")
	}
	if _, err := registry.heartbeat(context.Background(), session, HeartbeatInput{PolicyRevision: 3, PolicyEpoch: 4}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if _, ready := registry.Ready(session.key, 3, 4); !ready {
		t.Fatal("healthy restricted session is not ready")
	}
}

func TestHeartbeatLeaseExpiryPersistsDisconnect(t *testing.T) {
	store := &fakeAdmissionStore{
		admission:    restrictedAdmission(),
		healthyFor:   20 * time.Millisecond,
		disconnected: make(chan DisconnectRequest, 1),
	}
	registry, err := NewRuntimeRegistry(store)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	registry.OpenAdmission()
	session := &runtimeSession{token: "token"}
	if _, err := registry.connect(context.Background(), session, validConnectInput()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, err := registry.heartbeat(context.Background(), session, HeartbeatInput{PolicyRevision: 3, PolicyEpoch: 4}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	select {
	case disconnected := <-store.disconnected:
		if disconnected.RuntimeInstanceID != "instance-1" || disconnected.ConnectionEpoch != 2 {
			t.Fatalf("wrong disconnected session: %+v", disconnected)
		}
	case <-time.After(time.Second):
		t.Fatal("lease expiry did not persist Runtime disconnect")
	}
	if _, ready := registry.Ready(session.key, 3, 4); ready {
		t.Fatal("expired Runtime session remained ready")
	}
}

func validConnectInput() ConnectInput {
	return ConnectInput{
		ProtocolVersion: 1, RuntimeInstanceID: "instance-1", Generation: 1,
		RuntimeBootID: "boot-1", Capabilities: []string{"process.exec"},
	}
}

func restrictedAdmission() AdmissionResult {
	return AdmissionResult{
		AgentID: "agent-1", ConnectionEpoch: 2, WorkEpochFloor: 1,
		NetworkMode: "restricted", PolicyRevision: 3, PolicyEpoch: 4,
		LeaseExpiresAt: time.Now().Add(time.Minute),
	}
}

type fakeAdmissionStore struct {
	request      AdmissionRequest
	admission    AdmissionResult
	healthyFor   time.Duration
	disconnected chan DisconnectRequest
}

type fakeEgressIssuer struct {
	input EgressTokenInput
}

func (f *fakeEgressIssuer) Issue(input EgressTokenInput) (string, time.Time, error) {
	f.input = input
	return "egress-token", time.Now().Add(time.Minute), nil
}

func (s *fakeAdmissionStore) AdmitRuntimeSession(_ context.Context, request AdmissionRequest) (AdmissionResult, error) {
	s.request = request
	return s.admission, nil
}

func (s *fakeAdmissionStore) MarkRuntimeHealthy(context.Context, HeartbeatRequest) (time.Time, error) {
	lease := s.healthyFor
	if lease == 0 {
		lease = time.Minute
	}
	return time.Now().Add(lease), nil
}

func (s *fakeAdmissionStore) MarkRuntimeSessionDisconnected(_ context.Context, request DisconnectRequest) error {
	if s.disconnected != nil {
		s.disconnected <- request
	}
	return nil
}
