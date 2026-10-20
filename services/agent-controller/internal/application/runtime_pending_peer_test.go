package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func pendingPeerTarget() ports.PendingRuntimeBinding {
	network := validLifecycleNetwork()
	network.AgentID = "agent-1"
	network.AttachmentState = "pending"
	network.AttachmentResourceVersion = 2
	network.RuntimeEndpoint = ""
	network.TunnelKeyID = ""
	return ports.PendingRuntimeBinding{
		Agent:     ports.AgentRecord{AgentID: "agent-1", AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-1", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, DesiredState: domain.DesiredEnabled, RuntimeState: domain.RuntimeUnknown, AggregateSequence: 2},
		Spec:      ports.AgentSpecRecord{ID: "spec-1", AgentID: "agent-1"},
		Operation: ports.LifecycleOperationRecord{RequestID: "create-1", AgentID: "agent-1", Kind: domain.OperationCreate, State: domain.OperationCompleted, Phase: domain.PhaseCompleted, TargetSpecRevisionID: "spec-1", NetworkAttachment: &network, RuntimeResult: &ports.RuntimeOperation{State: "completed", Effect: "completed", LifecycleState: "provisioned", Health: "unknown", RuntimeRevision: "runtime-1"}}, NextExecutionRevision: 1,
	}
}

func TestPendingCreateBindsBeforeHealthyWithoutANewEventAndSurvivesRestart(t *testing.T) {
	for _, initial := range []string{"pending", "open"} {
		t.Run(initial, func(t *testing.T) {
			target := pendingPeerTarget()
			target.Operation.NetworkAttachment.AttachmentState = initial
			if initial == "open" {
				target.Operation.NetworkAttachment.RuntimeEndpoint = "10.20.0.8"
				target.Operation.NetworkAttachment.TunnelKeyID = "rtk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}
			source := &runtimeObservationSourceStub{inspection: peerInspectionForTest("agent-1", "runtime-1")}
			source.inspection.Health = "starting"
			store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: true}, pending: []ports.PendingRuntimeBinding{target}}
			egress := &pendingCreateReplayDependencies{current: *target.Operation.NetworkAttachment, getErr: errors.New("Egress offline")}
			worker := newRuntimeObservationWorkerForTest(t, source, store)
			worker.egress = egress
			if err := worker.RunOnce(t.Context()); err == nil || len(store.published) != 0 {
				t.Fatalf("Egress failure bypassed first binding: %v %+v", err, store.published)
			}
			egress.getErr = nil
			// A new process has no in-memory retry set and receives no new journal event.
			worker = newRuntimeObservationWorkerForTest(t, source, store)
			worker.egress = egress
			if err := worker.RunOnce(t.Context()); err != nil {
				t.Fatal(err)
			}
			if egress.current.AttachmentState != "open" || egress.current.RuntimeEndpoint != source.inspection.RuntimeEndpoint || egress.current.TunnelKeyID != source.inspection.TunnelKeyID || len(store.published) != 0 {
				t.Fatal("first binding waited for health or published early", egress.current, store.published)
			}
			// Another restart changes the peer before readiness; the saved pending receipt stays unchanged.
			source.inspection.RuntimeEndpoint = "10.20.0.10"
			if err := worker.RunOnce(t.Context()); err != nil {
				t.Fatal(err)
			}
			if egress.current.AttachmentResourceVersion != 4 || egress.current.RuntimeEndpoint != "10.20.0.10" {
				t.Fatal("later open peer did not converge", egress.current)
			}
			source.inspection.Health = "healthy"
			source.inspection.RuntimeExecutionID = "execution-1"
			source.inspection.MCPEndpoint = "http://runtime/mcp"
			if err := worker.RunOnce(t.Context()); err != nil || len(store.published) != 1 {
				t.Fatalf("healthy publication failed after prior rebind: %v %+v", err, store.published)
			}
			if store.published[0].Execution.RuntimeExecutionID != "execution-1" {
				t.Fatal(store.published)
			}
		})
	}
}

func TestPendingFirstBindingRejectsForeignTargetsAndNewerFences(t *testing.T) {
	for _, kind := range []string{"closed", "new_pending_cycle", "changed_network", "changed_coordinates", "pending_with_peer", "pending_with_key", "unfinished_create", "rebuild", "wrong_spec", "wrong_runtime", "wrong_agent", "running_without_key", "disabled", "deleted", "late_close", "late_new_pending"} {
		t.Run(kind, func(t *testing.T) {
			target := pendingPeerTarget()
			source := &runtimeObservationSourceStub{inspection: peerInspectionForTest("agent-1", "runtime-1")}
			source.inspection.Health = "healthy"
			source.inspection.RuntimeExecutionID = "execution-1"
			source.inspection.MCPEndpoint = "http://runtime/mcp"
			egress := &pendingCreateReplayDependencies{current: *target.Operation.NetworkAttachment}
			switch kind {
			case "closed":
				egress.current.AttachmentState = "closed"
				egress.current.AttachmentResourceVersion++
			case "new_pending_cycle":
				egress.current.AttachmentResourceVersion += 2
			case "changed_network":
				egress.current.NetworkResourceVersion++
			case "changed_coordinates":
				egress.current.ResolverIPv4 = "100.64.0.99"
			case "pending_with_peer":
				egress.current.RuntimeEndpoint = "10.20.0.9"
			case "pending_with_key":
				egress.current.TunnelKeyID = "rtk_0123456789abcdef0123456789abcdef"
			case "unfinished_create":
				target.Operation.State = domain.OperationRunning
			case "rebuild":
				target.Operation.Kind = domain.OperationRebuild
			case "wrong_spec":
				target.Operation.TargetSpecRevisionID = "spec-2"
			case "wrong_runtime":
				target.Operation.RuntimeResult.RuntimeRevision = "runtime-2"
			case "wrong_agent":
				target.Operation.AgentID = "agent-2"
			case "running_without_key":
				source.inspection.TunnelKeyID = ""
			case "disabled":
				target.Agent.DesiredState = domain.DesiredDisabled
			case "deleted":
				target.Agent.LifecycleState = domain.AgentDeleted
			case "late_close", "late_new_pending":
				egress.beforeSet = func() {
					egress.current.AttachmentState = "closed"
					egress.current.AttachmentResourceVersion++
					if kind == "late_new_pending" {
						egress.current.AttachmentState = "pending"
						egress.current.AttachmentResourceVersion++
					}
				}
			}
			before := egress.current
			store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: true}, pending: []ports.PendingRuntimeBinding{target}}
			worker := newRuntimeObservationWorkerForTest(t, source, store)
			worker.egress = egress
			_ = worker.RunOnce(context.Background())
			if len(store.published) != 0 || egress.current.AttachmentState == "open" {
				t.Fatal("stale first binding crossed lifecycle fence", store.published, egress.current)
			}
			if kind != "late_close" && kind != "late_new_pending" && egress.current != before {
				t.Fatal("rejected binding mutated network", before, egress.current)
			}
			if (kind == "late_close" || kind == "late_new_pending") && (len(egress.versions) != 1 || egress.versions[0] != 2) {
				t.Fatal("first bind borrowed a newer CAS version", egress.versions)
			}
		})
	}
}
