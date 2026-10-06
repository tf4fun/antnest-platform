package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type peerDependencies struct {
	lifecycleDependenciesStub
	inspection ports.RuntimeInspection
	inspectErr error
}

func (deps *peerDependencies) InspectRuntime(context.Context, string) (ports.RuntimeInspection, error) {
	deps.calls = append(deps.calls, "runtime.inspect")
	return deps.inspection, deps.inspectErr
}

func TestNetworkOpenPinsCurrentRuntimeRevisionAndAddressBeforeEffects(t *testing.T) {
	for _, name := range []string{"ready", "missing_key", "malformed_key", "missing_peer", "hostname", "stale_revision", "another_agent", "exited", "inspection_failed"} {
		t.Run(name, func(t *testing.T) {
			network := validLifecycleNetwork()
			network.AgentID = "agent-1"
			deps := &peerDependencies{lifecycleDependenciesStub: lifecycleDependenciesStub{network: network}, inspection: peerInspectionForTest("agent-1", "runtime-1")}
			switch name {
			case "missing_key":
				deps.inspection.TunnelKeyID = ""
			case "malformed_key":
				deps.inspection.TunnelKeyID = "rtk_bad"
			case "missing_peer":
				deps.inspection.RuntimeEndpoint = ""
			case "hostname":
				deps.inspection.RuntimeEndpoint = "runtime-host"
			case "stale_revision":
				deps.inspection.RuntimeRevision = "runtime-old"
			case "another_agent":
				deps.inspection.AgentID = "agent-2"
			case "exited":
				deps.inspection.Phase = "exited"
			case "inspection_failed":
				deps.inspectErr = errors.New("RC unavailable")
			}
			service := &LifecycleService{runtime: deps, egress: deps}
			opened, err := service.openRuntimeNetwork(t.Context(), "agent-1", "runtime-1", network)
			if name == "ready" {
				if err != nil || opened.RuntimeEndpoint != "10.20.0.9" {
					t.Fatal("inspected peer was not forwarded", opened, err)
				}
				if len(deps.calls) != 2 || deps.calls[0] != "runtime.inspect" || deps.calls[1] != "egress.attachment.open" {
					t.Fatal(deps.calls)
				}
			} else if err == nil || len(deps.calls) != 1 {
				t.Fatal("opened without a current peer", deps.calls, err)
			}
		})
	}
}

func TestObservationRebindsBeforeReadinessAndNeverReopensClosedAttachments(t *testing.T) {
	for _, state := range []string{ports.NetworkAttachmentOpen, ports.NetworkAttachmentClosed, "write_failed"} {
		t.Run(state, func(t *testing.T) {
			source := &runtimeObservationSourceStub{inspection: peerInspectionForTest("agent-1", "runtime-1")}
			source.inspection.Health = "healthy"
			source.inspection.RuntimeExecutionID = "execution-new"
			source.inspection.MCPEndpoint = "http://runtime/mcp"
			source.inspection.RuntimeEndpoint = "10.20.0.10"
			store := &runtimeObservationStoreStub{cursor: ports.RuntimeObservationCursor{Initialized: true}, pending: []ports.PendingRuntimeBinding{{
				Agent: ports.AgentRecord{AgentID: "agent-1", RuntimeRevision: "runtime-1", AgentSpecRevisionID: "spec-1", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, DesiredState: domain.DesiredEnabled, RuntimeState: domain.RuntimeUnknown},
				Spec:  ports.AgentSpecRecord{ID: "spec-1", AgentID: "agent-1"}, Operation: ports.LifecycleOperationRecord{RequestID: "create-1", Kind: domain.OperationCreate}, NextExecutionRevision: 1,
			}}}
			worker := newRuntimeObservationWorkerForTest(t, source, store)
			egress := worker.egress.(*enableDependenciesStub)
			if state == ports.NetworkAttachmentClosed {
				egress.attachmentClosed = true
				egress.network.AttachmentState = state
				egress.network.RuntimeEndpoint = ""
			}
			if state == "write_failed" {
				egress.attachmentOpenErr = errors.New("Egress unavailable")
			}
			err := worker.RunOnce(t.Context())
			if state == ports.NetworkAttachmentOpen {
				if err != nil || len(store.published) != 1 || egress.network.RuntimeEndpoint != "10.20.0.10" {
					t.Fatal("readiness was not preceded by rebinding", err, egress.network, store.published)
				}
			} else {
				if err == nil || len(store.published) != 0 {
					t.Fatal("published readiness before binding", err, store.published)
				}
				if state == ports.NetworkAttachmentClosed {
					for _, call := range egress.calls {
						if call == "egress.attachment.open" {
							t.Fatal("observation reopened a lifecycle fence")
						}
					}
				}
			}
		})
	}
}

func TestRestartObservationRebindsOpenPeerWithoutPublishingExecution(t *testing.T) {
	for _, closed := range []bool{false, true} {
		t.Run(map[bool]string{false: "open", true: "closed"}[closed], func(t *testing.T) {
			source := &runtimeObservationSourceStub{inspection: peerInspectionForTest("agent-1", "runtime-1")}
			source.inspection.RuntimeEndpoint = "10.20.0.10"
			store := &runtimeObservationStoreStub{}
			worker := newRuntimeObservationWorkerForTest(t, source, store)
			egress := worker.egress.(*enableDependenciesStub)
			egress.attachmentClosed = closed
			if err := worker.applyObservation(t.Context(), ports.RuntimeObservation{AgentID: "agent-1", Kind: ports.RuntimeObservationRestarted}); err != nil {
				t.Fatal(err)
			}
			if err := worker.RunOnce(t.Context()); err != nil {
				t.Fatal(err)
			}
			if len(store.applied) != 1 || len(store.published) != 0 {
				t.Fatal("peer reconciliation changed execution publication", store)
			}
			if !closed && egress.network.RuntimeEndpoint != "10.20.0.10" {
				t.Fatal("restart left the previous peer bound", egress.network)
			}
			if closed {
				for _, call := range egress.calls {
					if call == "egress.attachment.open" {
						t.Fatal("restart reopened a lifecycle fence")
					}
				}
			}
		})
	}
}

func TestObservationRebindsWhenKeyChangesAtTheSameAddress(t *testing.T) {
	network := validLifecycleNetwork()
	network.AgentID = "agent-1"
	network.AttachmentState = ports.NetworkAttachmentOpen
	network.RuntimeEndpoint = "10.20.0.9"
	network.TunnelKeyID = "rtk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	egress := &enableDependenciesStub{network: network}
	worker := &RuntimeObservationWorker{egress: egress}
	inspection := peerInspectionForTest("agent-1", "runtime-1")
	if err := worker.bindCurrentOpenPeer(t.Context(), inspection, false, true); err != nil {
		t.Fatal(err)
	}
	if egress.network.TunnelKeyID != inspection.TunnelKeyID || egress.network.AttachmentResourceVersion != 2 {
		t.Fatal("key-only replacement was not rebound", egress.network)
	}
}
