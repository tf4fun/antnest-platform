package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type peerRetrySource struct {
	runtimeObservationSourceStub
	current map[string]ports.RuntimeInspection
}

func (source *peerRetrySource) InspectRuntime(_ context.Context, id string) (ports.RuntimeInspection, error) {
	return source.current[id], nil
}

type peerRetryEgress struct {
	*enableDependenciesStub
	failure error
	onRead  func(context.Context, string)
}

func (egress *peerRetryEgress) GetAgentNetwork(ctx context.Context, id string) (ports.NetworkAttachment, error) {
	if egress.onRead != nil {
		egress.onRead(ctx, id)
	}
	if egress.failure != nil {
		return ports.NetworkAttachment{}, egress.failure
	}
	return egress.enableDependenciesStub.GetAgentNetwork(ctx, id)
}

func TestEgressOutageCannotStopRuntimeJournalAndRetrySurvivesTheConsumedEvent(t *testing.T) {
	first := peerInspectionForTest("agent-1", "runtime-1")
	first.RuntimeEndpoint = "10.20.0.10"
	second := peerInspectionForTest("agent-2", "runtime-2")
	second.Phase, second.Health, second.RuntimeEndpoint = "exited", "unknown", ""
	source := &peerRetrySource{current: map[string]ports.RuntimeInspection{"agent-1": first, "agent-2": second}, runtimeObservationSourceStub: runtimeObservationSourceStub{pages: []ports.RuntimeObservationPage{{
		Observations: []ports.RuntimeObservation{{Sequence: 1, AgentID: "agent-1", Kind: ports.RuntimeObservationRestarted}, {Sequence: 2, AgentID: "agent-2", Kind: ports.RuntimeObservationMissing}}, NextSequence: 2,
	}}}}
	store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: true}}
	worker := newRuntimeObservationWorkerForTest(t, source, store)
	egress := &peerRetryEgress{enableDependenciesStub: worker.egress.(*enableDependenciesStub), failure: errors.New("Egress unavailable")}
	egress.onRead = func(ctx context.Context, _ string) {
		if _, bounded := ctx.Deadline(); !bounded {
			t.Error("peer retry has no time budget")
		}
		if store.cursor.Sequence != 2 {
			t.Error("Egress was contacted before the journal drained")
		}
	}
	worker.egress = egress
	_ = worker.RunOnce(t.Context())
	if store.cursor.Sequence != 2 || len(store.applied) != 2 || store.applied[1].Current.Phase != "exited" {
		t.Fatal("outage blocked Runtime health", store)
	}
	egress.failure = nil
	if err := worker.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if egress.network.RuntimeEndpoint != "10.20.0.10" || len(store.published) != 0 {
		t.Fatal("consumed event lost its pending rebind or republished execution", egress.network, store.published)
	}
}

func TestRuntimeInventoryRestoresPeerWorkWithoutNewJournalEvents(t *testing.T) {
	for _, mode := range []string{"initialize", "worker_restart", "cursor_reset"} {
		t.Run(mode, func(t *testing.T) {
			current := peerInspectionForTest("agent-1", "runtime-1")
			current.RuntimeEndpoint = "10.20.0.10"
			source := &runtimeObservationSourceStub{inspection: current, runtimes: []ports.RuntimeEnvironmentSnapshot{{AgentID: "agent-1", RuntimeRevision: "runtime-1", Phase: "running", LifecycleState: "provisioned"}}}
			store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: mode != "initialize"}}
			if mode == "cursor_reset" {
				source.pageErrors = []error{&ports.RuntimeObservationCursorExpiredError{ResetSequence: 41}, nil}
			}
			worker := newRuntimeObservationWorkerForTest(t, source, store)
			if err := worker.RunOnce(t.Context()); err != nil {
				t.Fatal(err)
			}
			if worker.egress.(*enableDependenciesStub).network.RuntimeEndpoint != "10.20.0.10" || len(store.published) != 0 {
				t.Fatal("inventory did not restore the binding independently of execution", mode)
			}
		})
	}
}

func TestEgressFailureDoesNotReplaceCurrentRuntimeHealthWithUnknown(t *testing.T) {
	current := peerInspectionForTest("agent-1", "runtime-1")
	current.Health, current.RuntimeExecutionID, current.MCPEndpoint = "healthy", "execution-1", "http://runtime/mcp"
	source := &runtimeObservationSourceStub{inspection: current}
	store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: true}, pending: []ports.PendingRuntimeBinding{{Agent: ports.AgentRecord{AgentID: "agent-1", RuntimeRevision: "runtime-1", AgentSpecRevisionID: "spec-1", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, DesiredState: domain.DesiredEnabled, RuntimeState: domain.RuntimeUnknown}}}}
	worker := newRuntimeObservationWorkerForTest(t, source, store)
	worker.egress = &peerRetryEgress{enableDependenciesStub: worker.egress.(*enableDependenciesStub), failure: errors.New("Egress unavailable")}
	if err := worker.RunOnce(t.Context()); err == nil {
		t.Fatal("new execution was accepted without binding")
	}
	if len(store.conditions) != 1 || store.conditions[0].Inspection.Health != "healthy" || len(store.published) != 0 {
		t.Fatal("binding failure corrupted Runtime health or published execution", store)
	}
}

func TestCanceledPeerAttemptDoesNotStarveTheNextAgent(t *testing.T) {
	first := peerInspectionForTest("agent-1", "runtime-1")
	second := peerInspectionForTest("agent-2", "runtime-2")
	second.RuntimeEndpoint = "10.20.0.10"
	source := &peerRetrySource{current: map[string]ports.RuntimeInspection{"agent-1": first, "agent-2": second}, runtimeObservationSourceStub: runtimeObservationSourceStub{runtimes: []ports.RuntimeEnvironmentSnapshot{{AgentID: "agent-1"}, {AgentID: "agent-2"}}}}
	worker := newRuntimeObservationWorkerForTest(t, source, &runtimeObservationStoreStub{})
	firstCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	firstAttempt := true
	egress := &peerRetryEgress{enableDependenciesStub: worker.egress.(*enableDependenciesStub)}
	egress.onRead = func(ctx context.Context, id string) {
		if id == "agent-1" {
			if firstAttempt {
				firstAttempt = false
				cancel()
				<-ctx.Done()
				egress.failure = ctx.Err()
			} else {
				egress.failure = errors.New("Agent peer unavailable")
			}
		} else {
			egress.failure = nil
		}
	}
	worker.egress = egress
	_ = worker.RunOnce(firstCtx)
	_ = worker.RunOnce(t.Context())
	if egress.network.RuntimeEndpoint != "10.20.0.10" {
		t.Fatal("one timeout starved the other Agent", egress.network)
	}
}
