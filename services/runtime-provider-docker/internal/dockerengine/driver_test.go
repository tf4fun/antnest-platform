package dockerengine

import (
	"context"
	"errors"
	"testing"

	"soft/antnest-platform/services/runtime-provider-docker/internal/protocol"
)

func TestEnsureReusesMatchingRunningContainer(t *testing.T) {
	engine := newFakeEngine()
	engine.container = &Container{
		ID: "container-1", Name: "antnest-runtime-agent-1", Running: true,
		Labels: map[string]string{
			labelAgentID: "agent-1", labelGeneration: "2", labelInstanceID: "instance-2",
		},
	}
	driver := newTestDriver(t, engine)

	result := driver.Ensure(context.Background(), ensureRequest())

	if result.Outcome.State != protocol.EffectCompleted || result.ContainerID != "container-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(engine.created) != 0 || engine.startCalls != 0 {
		t.Fatalf("matching container was recreated: created=%d starts=%d", len(engine.created), engine.startCalls)
	}
}

func TestEnsureCreatesHardenedRuntimeAndStableVolumes(t *testing.T) {
	engine := newFakeEngine()
	driver := newTestDriver(t, engine)

	result := driver.Ensure(context.Background(), ensureRequest())

	if result.Outcome.State != protocol.EffectCompleted || len(engine.created) != 1 || engine.startCalls != 1 {
		t.Fatalf("unexpected ensure: result=%+v engine=%+v", result, engine)
	}
	spec := engine.created[0]
	if spec.Name != "antnest-runtime-agent-1" || spec.Image != "antnest/runtime:test" {
		t.Fatalf("unexpected container identity: %+v", spec)
	}
	if !spec.ReadOnlyRootFS || spec.User != "0:0" || spec.Environment["HOME"] != "/workspace" {
		t.Fatalf("runtime bootstrap is not hardened: %+v", spec)
	}
	if spec.Environment["ANTNEST_RUNTIME_ADMISSION_TOKEN"] == "" ||
		spec.Environment["ANTNEST_RUNTIME_TUNNEL_IPV4"] != "100.64.0.2" {
		t.Fatalf("runtime bootstrap is incomplete: %+v", spec.Environment)
	}
	if spec.Mounts["/workspace"].Source != "antnest-workspace-agent-1" ||
		spec.Mounts["/skills"].Source != "antnest-system-skills" || !spec.Mounts["/skills"].ReadOnly {
		t.Fatalf("unexpected mounts: %+v", spec.Mounts)
	}
	if len(spec.DNS) != 1 || spec.DNS[0] != "100.64.0.1" ||
		len(spec.DNSOptions) != 1 || spec.DNSOptions[0] != "use-vc" ||
		len(spec.Devices) != 1 || spec.Devices[0] != "/dev/net/tun" {
		t.Fatalf("runtime TUN or resolver is missing: dns=%v options=%v devices=%v",
			spec.DNS, spec.DNSOptions, spec.Devices)
	}
}

func TestEnsureReplacesStaleGenerationButKeepsWorkspace(t *testing.T) {
	engine := newFakeEngine()
	engine.container = &Container{
		ID: "old", Name: "antnest-runtime-agent-1", Running: true,
		Labels: map[string]string{
			labelAgentID: "agent-1", labelGeneration: "1", labelInstanceID: "instance-1",
		},
	}
	driver, err := NewDriver(engine)
	if err != nil {
		t.Fatalf("new driver: %v", err)
	}

	result := driver.Ensure(context.Background(), ensureRequest())

	if result.Outcome.State != protocol.EffectCompleted || engine.stopCalls != 1 || engine.removeCalls != 1 {
		t.Fatalf("stale generation did not converge: result=%+v engine=%+v", result, engine)
	}
	if engine.removedVolumes["antnest-workspace-agent-1"] {
		t.Fatal("generation replacement deleted workspace")
	}
}

func TestRemoveDeletesWorkspaceOnlyForPurge(t *testing.T) {
	for _, test := range []struct {
		name         string
		purge        bool
		wantDeletion bool
	}{
		{name: "retire", purge: false, wantDeletion: false},
		{name: "purge", purge: true, wantDeletion: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := newFakeEngine()
			engine.container = &Container{ID: "container-1", Name: "antnest-runtime-agent-1", Running: true}
			driver := newTestDriver(t, engine)
			result := driver.Remove(context.Background(), protocol.RuntimeTarget{
				AgentID: "agent-1", Generation: 2, ContainerID: "container-1",
			}, test.purge)
			if result.Outcome.State != protocol.EffectCompleted {
				t.Fatalf("remove: %+v", result)
			}
			if engine.removedVolumes["antnest-workspace-agent-1"] != test.wantDeletion {
				t.Fatalf("workspace deletion=%t want=%t", engine.removedVolumes["antnest-workspace-agent-1"], test.wantDeletion)
			}
		})
	}
}

func TestEnsureReportsUnknownWhenCreateDispatchIsAmbiguous(t *testing.T) {
	engine := newFakeEngine()
	engine.createErr = Uncertain(errors.New("connection reset"))
	driver, err := NewDriver(engine)
	if err != nil {
		t.Fatalf("new driver: %v", err)
	}

	result := driver.Ensure(context.Background(), ensureRequest())

	if result.Outcome.State != protocol.EffectUnknown {
		t.Fatalf("ambiguous create was declared retryable: %+v", result)
	}
}

func ensureRequest() protocol.EnsureRequest {
	return protocol.EnsureRequest{
		AgentID: "agent-1", Generation: 2, RuntimeInstanceID: "instance-2",
		ImageRef: "antnest/runtime:test", NetworkMode: protocol.NetworkRestricted,
		NetworkPolicyEpoch: 1, TunnelIPv4: "100.64.0.2", AllocatorEpoch: 2,
		AdvertisedEndpoint: "172.30.255.2:8091", EgressEndpoint: "172.30.255.3:8092",
		ManagementNetwork: "antnest-runtime-management",
		DNSIPv4:           "100.64.0.1",
		BootstrapToken:    "01234567890123456789012345678901",
	}
}

func newTestDriver(t *testing.T, engine *fakeEngine) *Driver {
	t.Helper()
	driver, err := NewDriver(engine)
	if err != nil {
		t.Fatalf("new driver: %v", err)
	}
	return driver
}

type fakeEngine struct {
	container      *Container
	created        []ContainerSpec
	startCalls     int
	stopCalls      int
	removeCalls    int
	createErr      error
	removedVolumes map[string]bool
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{removedVolumes: make(map[string]bool)}
}

func (e *fakeEngine) InspectContainer(context.Context, string) (Container, error) {
	if e.container == nil {
		return Container{}, ErrNotFound
	}
	return *e.container, nil
}

func (e *fakeEngine) EnsureVolume(context.Context, string) error { return nil }

func (e *fakeEngine) CreateContainer(_ context.Context, spec ContainerSpec) (string, error) {
	e.created = append(e.created, spec)
	if e.createErr != nil {
		return "", e.createErr
	}
	e.container = &Container{ID: "created", Name: spec.Name, Labels: spec.Labels}
	return "created", nil
}

func (e *fakeEngine) StartContainer(context.Context, string) error {
	e.startCalls++
	if e.container != nil {
		e.container.Running = true
	}
	return nil
}

func (e *fakeEngine) StopContainer(context.Context, string) error {
	e.stopCalls++
	if e.container != nil {
		e.container.Running = false
	}
	return nil
}

func (e *fakeEngine) RemoveContainer(context.Context, string) error {
	e.removeCalls++
	e.container = nil
	return nil
}

func (e *fakeEngine) RemoveVolume(_ context.Context, name string) error {
	e.removedVolumes[name] = true
	return nil
}
