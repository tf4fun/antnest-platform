package control

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

func TestInstanceAuthorityIsAdmittedAndReplayedWithCompute(t *testing.T) {
	ctx := context.Background()
	repo, driver := newLifecycleRepository(), newLifecyclePlatform()
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	service := newLifecycleService(t, repo, driver)
	if err := service.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	first, err := service.InitializeRuntime(ctx, "instance-auth-1", "agent-1", lifecycleConfiguration())
	if err != nil || first.InstanceAuthentication == nil {
		t.Fatal("accepted compute has no durable instance authority", err)
	}
	token, err := issuer.Open(instanceauth.Identity{Scope: "scope-a", AgentID: "agent-1", Generation: 1}, first.InstanceAuthentication, "agent-acp-service")
	if err != nil {
		t.Fatal(err)
	}
	persisted, _ := repo.GetOperation(ctx, first.RequestID)
	if persisted.InstanceAuthentication.ConnectionID != first.InstanceAuthentication.ConnectionID {
		t.Fatal("instance record not admitted with operation")
	}
	// Process recovery uses the persisted record, not a second Issue operation.
	restarted := newLifecycleService(t, repo, driver)
	if err := restarted.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectCompleted}
	second, err := restarted.InitializeRuntime(ctx, first.RequestID, "agent-1", lifecycleConfiguration())
	if err != nil || second.State != deployment.OperationCompleted || second.InstanceAuthentication.ConnectionID != first.InstanceAuthentication.ConnectionID {
		t.Fatal("recovery replaced instance identity", err)
	}
	for _, physical := range driver.deployments {
		if physical.RuntimeSpec.Authentication == nil || physical.RuntimeSpec.Authentication.ConnectionID != first.InstanceAuthentication.ConnectionID {
			t.Fatal("private descriptor missing from deployment")
		}
		encoded, _ := json.Marshal(physical)
		if bytes.Contains(encoded, []byte(token)) {
			t.Fatal("plaintext token in physical deployment")
		}
	}
	updated, err := restarted.UpdateRuntime(ctx, "instance-auth-2", "agent-1", second.RuntimeRevision, lifecycleConfiguration())
	if err != nil || updated.InstanceAuthentication.ConnectionID == first.InstanceAuthentication.ConnectionID {
		t.Fatal("replacement compute reused authority", err)
	}
}

func TestInstanceAuthorityMissingOnAcceptedRecoveryFailsClosed(t *testing.T) {
	repo, driver := newLifecycleRepository(), newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	first, err := service.InitializeRuntime(context.Background(), "pre-auth-1", "agent-1", lifecycleConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	if err := service.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	before := len(driver.deployments)
	if _, err := service.InitializeRuntime(context.Background(), first.RequestID, "agent-1", lifecycleConfiguration()); err == nil {
		t.Fatal("old accepted operation silently acquired new authority")
	}
	if len(driver.deployments) != before {
		t.Fatal("invalid accepted authority reached Docker")
	}
}

func (r *lifecycleRepository) GenerationOperation(_ context.Context, key deployment.Key) (deployment.Operation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, operation := range r.operations {
		if operation.CreatesCompute() && operation.RuntimeKey() == key {
			return operation, nil
		}
	}
	return deployment.Operation{}, ErrNotFound
}

func TestPrivateConnectionRejectsStaleBindingAndHiddenCredentials(t *testing.T) {
	ctx := context.Background()
	repo, driver := newLifecycleRepository(), newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	if err := service.SetInstanceCredentials("scope-a", issuer); err != nil {
		t.Fatal(err)
	}
	operation, err := service.InitializeRuntime(ctx, "resolve-private-1", "agent-1", lifecycleConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	connection, err := service.ResolveRuntimeConnection(ctx, "agent-1", operation.RuntimeRevision, "execution-1")
	if err != nil || connection.Credential.Caller != "agent-acp-service" {
		t.Fatal("current private connection unavailable", err)
	}
	rc, _ := issuer.Open(instanceauth.Identity{Scope: "scope-a", AgentID: "agent-1", Generation: 1}, operation.InstanceAuthentication, "runtime-controller")
	encoded, _ := json.Marshal(connection)
	if bytes.Contains(encoded, []byte(rc)) {
		t.Fatal("RC's status credential was exported")
	}
	if _, err := service.ResolveRuntimeConnection(ctx, "agent-1", operation.RuntimeRevision, "old-execution"); err != ErrConnectionStale {
		t.Fatal("old execution accepted", err)
	}
	if _, err := service.ResolveRuntimeConnection(ctx, "agent-1", deployment.RevisionFor("other", lifecycleDigest), "execution-1"); err != ErrConnectionStale {
		t.Fatal("old revision accepted", err)
	}
	current := driver.containers["agent-1"]
	delete(driver.containers, "agent-1")
	if _, err := service.ResolveRuntimeConnection(ctx, "agent-1", operation.RuntimeRevision, "execution-1"); err != ErrNotFound {
		t.Fatal("confirmed absent compute is not 404", err)
	}
	driver.containers["agent-1"] = current
	if _, err := service.DisableRuntime(ctx, "disable-private-1", "agent-1", operation.RuntimeRevision); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveRuntimeConnection(ctx, "agent-1", operation.RuntimeRevision, "execution-1"); err != ErrNotFound {
		t.Fatal("disabled connection accepted", err)
	}
}
