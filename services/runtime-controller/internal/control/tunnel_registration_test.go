package control

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

type tunnelRegistrarStub struct {
	err           error
	registrations []instanceauth.TunnelRegistration
}

func TestTunnelRegistrationRejectionPreservesSourceWithoutDockerMutation(t *testing.T) {
	repo, driver := newLifecycleRepository(), newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	if err := service.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	registrar := &tunnelRegistrarStub{}
	service.SetTunnelRegistrar(registrar)
	first, err := service.InitializeRuntime(context.Background(), "tunnel-source", "agent-1", lifecycleConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	before := driver.mutationCalls()
	registrar.err = instanceauth.ErrTunnelRegistrationRejected
	rejected, err := service.UpdateRuntime(context.Background(), "tunnel-rejected", "agent-1", first.RuntimeRevision, lifecycleConfiguration())
	if err != nil || rejected.State != deployment.OperationFailed || rejected.Effect != deployment.EffectNotStarted || driver.mutationCalls() != before {
		t.Fatal("rejection mutated source", rejected.State, err)
	}
	source := requireLifecycleEnvironment(t, repo, "agent-1", deployment.LifecycleProvisioned)
	if source.RuntimeRevision != first.RuntimeRevision {
		t.Fatal("source revision changed")
	}
}

func (r *tunnelRegistrarStub) Register(_ context.Context, _ string, value instanceauth.TunnelRegistration) error {
	r.registrations = append(r.registrations, value)
	return r.err
}

func TestTunnelRegistrationOutagePreservesAcceptedKeyBeforePlatformEffects(t *testing.T) {
	repo, driver := newLifecycleRepository(), newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	if err := service.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	registrar := &tunnelRegistrarStub{err: ErrTunnelRegistrationUnavailable}
	service.SetTunnelRegistrar(registrar)
	first, err := service.InitializeRuntime(context.Background(), "tunnel-init-1", "agent-1", lifecycleConfiguration())
	if !errors.Is(err, ErrTunnelRegistrationUnavailable) || first.State != deployment.OperationRunning {
		t.Fatal("outage finalized accepted operation", first.State, err)
	}
	if len(driver.deployments) != 0 || driver.ensureStorageCalls != 0 {
		t.Fatal("platform mutated before tunnel registration")
	}
	registrar.err = nil
	second, err := service.InitializeRuntime(context.Background(), first.RequestID, "agent-1", lifecycleConfiguration())
	if err != nil || second.State != deployment.OperationCompleted {
		t.Fatal("registration recovery failed", err)
	}
	if len(registrar.registrations) != 2 || registrar.registrations[0] != registrar.registrations[1] {
		t.Fatal("retry replaced accepted tunnel material")
	}
	if driver.deployments[0].RuntimeSpec.Authentication.Tunnel.KeyID != registrar.registrations[0].KeyID {
		t.Fatal("registered and delivered identities differ")
	}
}
