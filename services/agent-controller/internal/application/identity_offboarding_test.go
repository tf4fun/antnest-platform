package application

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestIdentityDisableFailureNeverReopensNetwork(t *testing.T) {
	for _, strict := range []bool{true, false} {
		t.Run(map[bool]string{true: "identity_requested", false: "revoked_during_manual_disable"}[strict], func(t *testing.T) {
			base := disableLifecycleBase(t)
			base.Agent.IdentityRevocationSequence = 7
			store := &disableLifecycleStoreStub{base: base}
			dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "platform_unavailable"})
			service := NewLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(220, 0).UTC()})
			input := DisableAgentInput{RequestID: "identity-disable", AgentID: base.Agent.AgentID}
			if strict {
				input.OwnerRevocationSequence = 7
			}
			result, err := executeDisableForTest(service, context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if slices.Contains(dependencies.calls, "egress.attachment.open") {
				t.Fatalf("revocation reopened network: %v", dependencies.calls)
			}
			if result.Operation.State != domain.OperationFailed || !store.failed.PreserveExecutable {
				t.Fatalf("failure proof lost: %+v %+v", result, store.failed)
			}
			if store.begin.Operation.OwnerRevocationSequence != input.OwnerRevocationSequence {
				t.Fatal("durable cause lost")
			}
		})
	}
}

func TestIdentityConsumerConvergesLocalWorkDuringIdentityOutage(t *testing.T) {
	store := &revocationStoreStub{pending: []ports.PendingOwnerRevocation{{AgentID: "agent-a", Sequence: 7, AggregateSequence: 9}}}
	scheduler := &revocationSchedulerStub{}
	worker, err := NewIdentityRevocationWorker(&revocationSourceStub{err: errors.New("offline")}, store, scheduler, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err == nil {
		t.Fatal("missing source failure")
	}
	if len(scheduler.inputs) != 1 || scheduler.inputs[0].OwnerRevocationSequence != 7 {
		t.Fatalf("local offboarding starved: %+v", scheduler.inputs)
	}
}

func TestIdentityConsumerReceiptFailureDoesNotAdvancePage(t *testing.T) {
	source := &revocationSourceStub{page: ports.PrincipalRevocationPage{Events: []ports.PrincipalRevocation{{Sequence: 5}, {Sequence: 7}}, NextSequence: 7}}
	store := &revocationStoreStub{applyErr: errors.New("transaction failed")}
	worker, err := NewIdentityRevocationWorker(source, store, &revocationSchedulerStub{}, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err == nil {
		t.Fatal("missing receipt failure")
	}
	if len(store.applied) != 1 || store.cursor != 0 {
		t.Fatalf("receipt advanced: %+v", store)
	}
}

func TestIdentityConsumerContinuesPastBusyAgent(t *testing.T) {
	store := &revocationStoreStub{pending: []ports.PendingOwnerRevocation{{AgentID: "agent-busy", Sequence: 7, AggregateSequence: 1}, {AgentID: "agent-ready", Sequence: 7, AggregateSequence: 2}}}
	scheduler := &revocationSchedulerStub{firstErr: ErrLifecycleConflict}
	worker, err := NewIdentityRevocationWorker(&revocationSourceStub{}, store, scheduler, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(scheduler.inputs) != 2 || scheduler.inputs[1].AgentID != "agent-ready" {
		t.Fatalf("busy Agent starved page: %+v", scheduler.inputs)
	}
}

type revocationSourceStub struct {
	page ports.PrincipalRevocationPage
	err  error
}

func (source *revocationSourceStub) ListPrincipalRevocations(context.Context, int64, int) (ports.PrincipalRevocationPage, error) {
	return source.page, source.err
}

type revocationStoreStub struct {
	cursor   int64
	applied  []ports.PrincipalRevocation
	pending  []ports.PendingOwnerRevocation
	applyErr error
}

func (store *revocationStoreStub) GetIdentityRevocationCursor(context.Context) (int64, error) {
	return store.cursor, nil
}
func (store *revocationStoreStub) ApplyIdentityRevocation(_ context.Context, _ int64, event ports.PrincipalRevocation, _ string) error {
	store.applied = append(store.applied, event)
	if store.applyErr != nil {
		return store.applyErr
	}
	store.cursor = event.Sequence
	return nil
}
func (store *revocationStoreStub) ListPendingOwnerRevocations(context.Context, string, int) ([]ports.PendingOwnerRevocation, error) {
	return store.pending, nil
}

type revocationSchedulerStub struct {
	inputs   []DisableAgentInput
	firstErr error
}

func (scheduler *revocationSchedulerStub) DisableAgent(_ context.Context, input DisableAgentInput) (DisableAgentResult, error) {
	scheduler.inputs = append(scheduler.inputs, input)
	if len(scheduler.inputs) == 1 {
		return DisableAgentResult{}, scheduler.firstErr
	}
	return DisableAgentResult{}, nil
}

func TestCompensationObservesRevocationDuringNetworkRead(t *testing.T) {
	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	deps := newDisableDependencies(base, ports.RuntimeOperation{})
	deps.attachmentClosed = true
	egress := &revokingNetworkRead{disableDependenciesStub: deps, revoke: func() { store.base.Agent.IdentityRevocationSequence = 7 }}
	service := NewLifecycleService(lifecycleSpecSourceStub{}, store, egress, deps, fixedClock{now: time.Now()})
	if err := service.restoreNetworkUnlessRevoked(context.Background(), base.Agent.AgentID, 0); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(deps.calls, "egress.attachment.open") {
		t.Fatalf("opened after revocation during GET: %v", deps.calls)
	}
}

type revokingNetworkRead struct {
	*disableDependenciesStub
	revoke func()
}

func (deps *revokingNetworkRead) GetAgentNetwork(ctx context.Context, id string) (ports.NetworkAttachment, error) {
	result, err := deps.disableDependenciesStub.GetAgentNetwork(ctx, id)
	deps.revoke()
	return result, err
}

func TestCompensationReclosesWhenRevocationCommitsDuringOpen(t *testing.T) {
	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	deps := newDisableDependencies(base, ports.RuntimeOperation{})
	deps.attachmentClosed = true
	egress := &revokingNetworkOpen{disableDependenciesStub: deps, revoke: func() { store.base.Agent.IdentityRevocationSequence = 7 }}
	service := NewLifecycleService(lifecycleSpecSourceStub{}, store, egress, deps, fixedClock{now: time.Now()})
	if err := service.restoreNetworkUnlessRevoked(context.Background(), base.Agent.AgentID, 0); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(deps.calls, []string{"egress.get", "egress.attachment.open", "egress.attachment.closed"}) || !deps.attachmentClosed {
		t.Fatalf("compensation did not reclose: %v", deps.calls)
	}
}

type revokingNetworkOpen struct {
	*disableDependenciesStub
	revoke func()
}

func (deps *revokingNetworkOpen) SetAgentNetworkAttachment(ctx context.Context, id, state string, version uint64) (ports.NetworkAttachment, error) {
	result, err := deps.disableDependenciesStub.SetAgentNetworkAttachment(ctx, id, state, version)
	if state == ports.NetworkAttachmentOpen {
		deps.revoke()
	}
	return result, err
}

func TestWorkspaceMarksRevokedAgentOfflineBeforeRuntimeStops(t *testing.T) {
	availability := workspaceAvailability(ports.WorkspaceAgentRecord{IdentityRevoked: true, LifecycleState: domain.AgentAvailable})
	if availability != WorkspaceAgentOffline {
		t.Fatalf("revoked Agent appeared ready: %s", availability)
	}
}
