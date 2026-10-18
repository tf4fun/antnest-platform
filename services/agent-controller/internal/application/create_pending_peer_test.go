package application

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type pendingCreateDependencies struct {
	lifecycleDependenciesStub
	phase      string
	inspection *ports.RuntimeInspection
	inspectErr error
}

func (deps *pendingCreateDependencies) InspectRuntime(_ context.Context, agentID string) (ports.RuntimeInspection, error) {
	deps.calls = append(deps.calls, "runtime.inspect")
	if deps.inspectErr != nil {
		return ports.RuntimeInspection{}, deps.inspectErr
	}
	if deps.inspection != nil {
		value := *deps.inspection
		if value.AgentID == "" {
			value.AgentID = agentID
		}
		return value, nil
	}
	return ports.RuntimeInspection{AgentID: agentID, RuntimeRevision: deps.runtime.RuntimeRevision,
		LifecycleState: "provisioned", Phase: deps.phase, Health: "starting", Reason: "runtime_restarting"}, nil
}

func TestCreateRejectsUnprovenPendingPeerAndPreservesInspectionCause(t *testing.T) {
	for _, kind := range []string{"foreign_agent", "foreign_revision", "unknown", "absent", "running_without_peer", "created_with_peer", "exited_with_key", "not_provisioned", "inspect_failure"} {
		t.Run(kind, func(t *testing.T) {
			inspection := ports.RuntimeInspection{RuntimeRevision: "runtime-created", LifecycleState: "provisioned", Phase: "created"}
			cause := &ports.DependencyError{Service: "runtime-controller", Code: "inspection_unavailable", Retryable: true}
			deps := &pendingCreateDependencies{inspection: &inspection, lifecycleDependenciesStub: lifecycleDependenciesStub{network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "runtime-created", LifecycleState: "provisioned", Health: "unknown"}}}
			switch kind {
			case "foreign_agent":
				inspection.AgentID = "another-agent"
			case "foreign_revision":
				inspection.RuntimeRevision = "another-revision"
			case "unknown":
				inspection.Phase = "unknown"
			case "absent":
				inspection.Phase = "absent"
			case "running_without_peer":
				inspection.Phase = "running"
			case "created_with_peer":
				inspection.RuntimeEndpoint = "10.20.0.9"
			case "exited_with_key":
				inspection.Phase = "exited"
				inspection.TunnelKeyID = "rtk_0123456789abcdef0123456789abcdef"
			case "not_provisioned":
				inspection.LifecycleState = "disabled"
			case "inspect_failure":
				deps.inspectErr = cause
			}
			store := &lifecycleStoreStub{}
			_, err := executeCreateForTest(newLifecycleTestService(t, store, deps), t.Context(), lifecycleCreateInput("invalid-pending-"+kind))
			if !errors.Is(err, ErrDependencyUnavailable) || store.published.RequestID != "" {
				t.Fatalf("invalid inspection published target: %v %+v", err, store.published)
			}
			var dependency *ports.DependencyError
			if !errors.As(err, &dependency) || dependency.Service != "runtime-controller" {
				t.Fatalf("inspection failure lost RC attribution: %v", err)
			}
			if kind == "inspect_failure" && !errors.Is(err, cause) {
				t.Fatalf("inspection cause lost: %v", err)
			}
			for _, call := range deps.calls {
				if call == "egress.attachment.pending" || call == "egress.attachment.open" {
					t.Fatalf("unproven inspection changed network: %v", deps.calls)
				}
			}
		})
	}
}

// Models Egress CAS, including an effect committed before the caller loses its reply.
type pendingCreateReplayDependencies struct {
	pendingCreateDependencies
	current   ports.NetworkAttachment
	loseReply bool
	getErr    error
	beforeSet func()
	versions  []uint64
}

func (deps *pendingCreateReplayDependencies) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return deps.current, deps.getErr
}
func (deps *pendingCreateReplayDependencies) SetAgentNetworkAttachment(_ context.Context, id, state string, version uint64, peer, key string) (ports.NetworkAttachment, error) {
	deps.versions = append(deps.versions, version)
	if deps.beforeSet != nil {
		hook := deps.beforeSet
		deps.beforeSet = nil
		hook()
	}
	if deps.current.AgentID == "" {
		deps.current.AgentID = id
	}
	if version != deps.current.AttachmentResourceVersion {
		if deps.current.AttachmentResourceVersion > version && deps.current.AttachmentResourceVersion-version == 1 && deps.current.AttachmentState == state && deps.current.RuntimeEndpoint == peer && deps.current.TunnelKeyID == key {
			return deps.current, nil
		}
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict", Retryable: true}
	}
	if deps.current.AttachmentState != state || deps.current.RuntimeEndpoint != peer || deps.current.TunnelKeyID != key {
		deps.current.AttachmentResourceVersion++
	}
	deps.current.AttachmentState = state
	deps.current.RuntimeEndpoint = peer
	deps.current.TunnelKeyID = key
	if deps.loseReply {
		deps.loseReply = false
		return ports.NetworkAttachment{}, context.DeadlineExceeded
	}
	return deps.current, nil
}

func TestCreateRecoversOnlyItsOwnLostAttachmentReplyAcrossRuntimePhaseChanges(t *testing.T) {
	for _, initial := range []string{"pending", "open"} {
		for _, change := range []string{"same_cycle", "closed", "next_pending", "changed_network", "changed_coordinates"} {
			t.Run(initial+"/"+change, func(t *testing.T) {
				inspection := peerInspectionForTest("", "runtime-created")
				if initial == "pending" {
					inspection.Phase = "created"
					inspection.RuntimeEndpoint = ""
					inspection.TunnelKeyID = ""
				}
				deps := &pendingCreateReplayDependencies{pendingCreateDependencies: pendingCreateDependencies{inspection: &inspection, lifecycleDependenciesStub: lifecycleDependenciesStub{network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "runtime-created", LifecycleState: "provisioned", Health: "unknown"}}}, current: validLifecycleNetwork(), loseReply: true}
				store := &lifecycleStoreStub{}
				service := newLifecycleTestService(t, store, deps)
				input := lifecycleCreateInput("lost-" + initial + "-" + change)
				if _, err := executeCreateForTest(service, t.Context(), input); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("lost reply was not preserved: %v", err)
				}
				if store.published.RequestID != "" || deps.current.AttachmentResourceVersion != 2 {
					t.Fatal("unexpected first publication", store.published, deps.current)
				}
				if initial == "pending" {
					inspection = peerInspectionForTest("", "runtime-created")
				} else {
					inspection.Phase = "exited"
					inspection.RuntimeEndpoint = ""
					inspection.TunnelKeyID = ""
				}
				switch change {
				case "closed":
					deps.current.AttachmentState = "closed"
					deps.current.AttachmentResourceVersion = 3
					deps.current.RuntimeEndpoint = ""
					deps.current.TunnelKeyID = ""
				case "next_pending":
					deps.current.AttachmentState = "pending"
					deps.current.AttachmentResourceVersion = 4
					deps.current.RuntimeEndpoint = ""
					deps.current.TunnelKeyID = ""
				case "changed_network":
					deps.current.NetworkResourceVersion++
				case "changed_coordinates":
					deps.current.TunnelIPv4 = "100.64.0.99"
				}
				before := deps.current
				result, err := executeCreateForTest(service, t.Context(), input)
				if change == "same_cycle" {
					if err != nil || result.Operation.State != domain.OperationCompleted || store.published.NetworkAttachment != before || result.Agent.ExecutionRevisionID != "" {
						t.Fatalf("own committed effect did not recover: %v %+v", err, result)
					}
				} else if err == nil || store.published.RequestID != "" {
					t.Fatalf("borrowed later/foreign attachment: %v %+v", err, store.published)
				}
				if deps.current != before {
					t.Fatal("recovery mutated a later attachment", deps.current, before)
				}
			})
		}
	}
}

func TestCreateCompletesWithPendingNetworkWhenProvisionedRuntimeHasNoPeer(t *testing.T) {
	for _, phase := range []string{"created", "exited"} {
		t.Run(phase, func(t *testing.T) {
			store := &lifecycleStoreStub{}
			deps := &pendingCreateDependencies{phase: phase, lifecycleDependenciesStub: lifecycleDependenciesStub{
				network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{
					State: "completed", Effect: "completed", RuntimeRevision: "runtime-created",
					LifecycleState: "provisioned", Health: "unknown",
				},
			}}
			service := newLifecycleTestService(t, store, deps)
			input := lifecycleCreateInput("create-no-peer-" + phase)
			result, err := executeCreateForTest(service, t.Context(), input)
			if err != nil {
				t.Fatalf("provisioned Runtime blocked Create: %v", err)
			}
			if result.Operation.State != domain.OperationCompleted || result.Agent.ActiveOperationRequestID != "" ||
				result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ExecutionRevisionID != "" ||
				result.Agent.RuntimeExecutionID != "" || result.Agent.RuntimeMCPEndpoint != "" {
				t.Fatalf("creation did not preserve a non-executable configured target: %+v", result)
			}
			attachment := store.published.NetworkAttachment
			if attachment.AttachmentState != "pending" || attachment.RuntimeEndpoint != "" || attachment.TunnelKeyID != "" {
				t.Fatalf("missing peer must remain network pending: %+v", attachment)
			}
			calls := append([]string(nil), deps.calls...)
			replayed, err := executeCreateForTest(service, t.Context(), input)
			if err != nil || !reflect.DeepEqual(replayed.Operation, result.Operation) || !reflect.DeepEqual(deps.calls, calls) {
				t.Fatalf("completed replay repeated dependencies: %v %v", deps.calls, err)
			}
		})
	}
}

func TestCreateLostOpenReplyRebindsChangedRunningPeerOrKey(t *testing.T) {
	for _, change := range []string{"peer", "key"} {
		t.Run(change, func(t *testing.T) {
			inspection := peerInspectionForTest("", "runtime-created")
			deps := &pendingCreateReplayDependencies{pendingCreateDependencies: pendingCreateDependencies{inspection: &inspection, lifecycleDependenciesStub: lifecycleDependenciesStub{network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "runtime-created", LifecycleState: "provisioned", Health: "unknown"}}}, current: validLifecycleNetwork(), loseReply: true}
			store := &lifecycleStoreStub{}
			service := newLifecycleTestService(t, store, deps)
			input := lifecycleCreateInput("lost-open-running-" + change)
			if _, err := executeCreateForTest(service, t.Context(), input); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			if change == "peer" {
				inspection.RuntimeEndpoint = "10.20.0.10"
			} else {
				inspection.TunnelKeyID = "rtk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}
			result, err := executeCreateForTest(service, t.Context(), input)
			if err != nil || result.Operation.State != domain.OperationCompleted || store.published.NetworkAttachment != deps.current || deps.current.AttachmentResourceVersion != 3 || deps.current.RuntimeEndpoint != inspection.RuntimeEndpoint || deps.current.TunnelKeyID != inspection.TunnelKeyID {
				t.Fatalf("lost open did not rebind current peer: %v %+v %+v", err, result, deps.current)
			}
			if !reflect.DeepEqual(deps.versions, []uint64{1, 1, 2}) {
				t.Fatal("rebind used another cycle", deps.versions)
			}
		})
	}
}
