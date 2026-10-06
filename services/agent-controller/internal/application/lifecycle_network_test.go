package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestNetworkMutationRejectsExpiredPhaseAfterAttachmentRead(t *testing.T) {
	t.Parallel()
	for _, terminal := range []bool{false, true} {
		t.Run(map[bool]string{false: "advanced", true: "completed"}[terminal], func(t *testing.T) {
			op := ports.LifecycleOperationRecord{RequestID: "request", AgentID: "agent", RequestFingerprint: "fingerprint", Kind: domain.OperationRebuild, State: domain.OperationRunning, Phase: domain.PhaseNetworkFence}
			current := op
			current.Phase = domain.PhasePublish
			if terminal {
				current.State = domain.OperationCompleted
			}
			store := &lifecycleStoreStub{operation: current}
			dependencies := &lifecycleDependenciesStub{}
			service := newLifecycleTestService(t, store, dependencies)
			_, err := service.setOperationNetworkAttachment(context.Background(), op, ports.NetworkAttachmentClosed, ports.NetworkAttachment{AgentID: "agent", State: ports.NetworkStateActive, AttachmentState: ports.NetworkAttachmentOpen, AttachmentResourceVersion: 9})
			if !errors.Is(err, ports.ErrConcurrentChange) {
				t.Fatalf("stale phase error = %v", err)
			}
			if len(dependencies.calls) != 0 {
				t.Fatalf("stale phase changed network: %v", dependencies.calls)
			}
		})
	}
}

type lostOpenResponse struct {
	*enableDependenciesStub
	lost     bool
	versions []uint64
}

func (dependency *lostOpenResponse) SetAgentNetworkAttachment(ctx context.Context, agentID, state string, expected uint64, runtimeEndpoint string) (ports.NetworkAttachment, error) {
	dependency.versions = append(dependency.versions, expected)
	if dependency.lost {
		current := dependency.network
		if state != current.AttachmentState || current.AttachmentResourceVersion != expected+1 {
			return ports.NetworkAttachment{}, errors.New("resource version conflict")
		}
		return current, nil
	}
	result, err := dependency.enableDependenciesStub.SetAgentNetworkAttachment(ctx, agentID, state, expected, runtimeEndpoint)
	if err != nil {
		return result, err
	}
	dependency.lost = true
	return ports.NetworkAttachment{}, context.DeadlineExceeded
}

func TestEnableRetriesLostOpenResponseWithoutCompensatingClose(t *testing.T) {
	t.Parallel()
	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := &lostOpenResponse{enableDependenciesStub: newEnableDependencies(base, readyEnableRuntime())}
	service := newLifecycleTestService(t, store, dependencies)
	input := EnableAgentInput{RequestID: "lost-open", AgentID: base.Agent.AgentID}
	result, err := executeEnableForTest(service, context.Background(), input)
	if !errors.Is(err, ErrDependencyUnavailable) || result.Operation.Phase != domain.PhaseNetworkRestore {
		t.Fatalf("first attempt = %+v, %v", result, err)
	}
	result, err = executeEnableForTest(service, context.Background(), input)
	if err != nil || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("retry = %+v, %v", result, err)
	}
	if len(dependencies.versions) != 2 || dependencies.versions[0] != dependencies.versions[1] {
		t.Fatalf("retry changed resource version: %v", dependencies.versions)
	}
}
