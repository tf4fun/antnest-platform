package application

import (
	"context"
	"errors"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (service *LifecycleService) openRuntimeNetwork(ctx context.Context, agentID, revision string, attachment ports.NetworkAttachment) (ports.NetworkAttachment, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, agentID)
	if err != nil {
		return ports.NetworkAttachment{}, err
	}
	if inspection.AgentID != agentID || inspection.RuntimeRevision != revision ||
		inspection.LifecycleState != "provisioned" || inspection.Phase != "running" ||
		(!ports.ValidRuntimePeer(inspection.RuntimeEndpoint) || !ports.ValidTunnelKeyID(inspection.TunnelKeyID)) {
		return ports.NetworkAttachment{}, &ports.DependencyError{
			Service: "runtime-controller", Code: "runtime_peer_unavailable", Retryable: true,
		}
	}
	result, err := service.egress.SetAgentNetworkAttachment(ctx, agentID, ports.NetworkAttachmentOpen, attachment.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
	var conflict *ports.DependencyError
	if !errors.As(err, &conflict) || conflict.Service != "runtime-egress" || conflict.Code != "resource_version_conflict" {
		return result, err
	}
	current, readErr := service.egress.GetAgentNetwork(ctx, agentID)
	if readErr != nil {
		return ports.NetworkAttachment{}, readErr
	}
	if !networkAttachmentReady(current, agentID) || !sameNetworkCoordinates(current, attachment) ||
		current.AttachmentResourceVersion <= attachment.AttachmentResourceVersion ||
		current.AttachmentResourceVersion-attachment.AttachmentResourceVersion != 1 ||
		(current.RuntimeEndpoint == inspection.RuntimeEndpoint && current.TunnelKeyID == inspection.TunnelKeyID) {
		return ports.NetworkAttachment{}, err
	}
	// The immediately preceding CAS may be this operation's lost open response.
	// A restart changed its peer, so consume a new CAS without borrowing a later cycle.
	return service.egress.SetAgentNetworkAttachment(ctx, agentID, ports.NetworkAttachmentOpen, current.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
}

func (worker *RuntimeObservationWorker) bindObservedPeer(ctx context.Context, pending ports.PendingRuntimeBinding, inspection ports.RuntimeInspection) error {
	if inspection.RuntimeRevision != pending.Agent.RuntimeRevision || inspection.AgentID != pending.Agent.AgentID ||
		inspection.Phase != "running" || inspection.LifecycleState != "provisioned" {
		return nil
	}
	if pending.Operation.NetworkAttachment != nil && pending.Operation.NetworkAttachment.AttachmentState == ports.NetworkAttachmentPending {
		return worker.bindPendingCreatePeer(ctx, pending, inspection)
	}
	return worker.bindCurrentOpenPeer(ctx, inspection, pending.Agent.AwaitingRuntimeBinding(), true)
}

func (worker *RuntimeObservationWorker) bindPendingCreatePeer(ctx context.Context, pending ports.PendingRuntimeBinding, inspection ports.RuntimeInspection) error {
	op := pending.Operation
	if op.Kind != domain.OperationCreate || op.State != domain.OperationCompleted || op.Phase != domain.PhaseCompleted ||
		op.AgentID != pending.Agent.AgentID || op.TargetSpecRevisionID != pending.Agent.AgentSpecRevisionID ||
		pending.Spec.ID != op.TargetSpecRevisionID || pending.Spec.AgentID != pending.Agent.AgentID ||
		op.RuntimeResult == nil || !completedProvisionedRuntime(*op.RuntimeResult) || op.RuntimeResult.RuntimeRevision != inspection.RuntimeRevision ||
		!ports.ValidRuntimePeer(inspection.RuntimeEndpoint) || !ports.ValidTunnelKeyID(inspection.TunnelKeyID) {
		return ErrDependencyUnavailable
	}
	expected := *op.NetworkAttachment
	network, err := worker.egress.GetAgentNetwork(ctx, inspection.AgentID)
	if err != nil {
		return err
	}
	if !sameNetworkCoordinates(network, expected) || network.NetworkResourceVersion != expected.NetworkResourceVersion {
		return ErrDependencyUnavailable
	}
	if network.AttachmentState == ports.NetworkAttachmentOpen {
		// Subsequent restarts can have advanced the open version repeatedly; this
		// is ordinary rebind, not permission to borrow a later pending cycle.
		return worker.bindCurrentOpenPeer(ctx, inspection, true, true)
	}
	if !networkAttachmentInState(network, inspection.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentPending) ||
		network.AttachmentResourceVersion != expected.AttachmentResourceVersion || network.RuntimeEndpoint != "" || network.TunnelKeyID != "" ||
		expected.RuntimeEndpoint != "" || expected.TunnelKeyID != "" {
		return ErrDependencyUnavailable
	}
	bound, err := worker.egress.SetAgentNetworkAttachment(ctx, inspection.AgentID, ports.NetworkAttachmentOpen, expected.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
	if err != nil {
		return err
	}
	if !networkAttachmentReady(bound, inspection.AgentID) || !sameNetworkCoordinates(bound, expected) || bound.NetworkResourceVersion != expected.NetworkResourceVersion ||
		!immediatelyAfter(bound.AttachmentResourceVersion, expected.AttachmentResourceVersion) || bound.RuntimeEndpoint != inspection.RuntimeEndpoint || bound.TunnelKeyID != inspection.TunnelKeyID {
		return ErrDependencyUnavailable
	}
	return nil
}

func (worker *RuntimeObservationWorker) bindCurrentOpenPeer(ctx context.Context, inspection ports.RuntimeInspection, confirm, requireOpen bool) error {
	if !ports.ValidRuntimePeer(inspection.RuntimeEndpoint) || !ports.ValidTunnelKeyID(inspection.TunnelKeyID) {
		return ErrDependencyUnavailable
	}
	network, err := worker.egress.GetAgentNetwork(ctx, inspection.AgentID)
	if err != nil {
		return err
	}
	if !networkAttachmentInState(network, inspection.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentOpen) {
		if requireOpen {
			return ErrDependencyUnavailable
		}
		return nil
	}
	if network.RuntimeEndpoint != inspection.RuntimeEndpoint || network.TunnelKeyID != inspection.TunnelKeyID || confirm {
		rebound, err := worker.egress.SetAgentNetworkAttachment(ctx, inspection.AgentID, ports.NetworkAttachmentOpen, network.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
		if err != nil {
			return err
		}
		if !networkAttachmentReady(rebound, inspection.AgentID) || (rebound.RuntimeEndpoint != inspection.RuntimeEndpoint || rebound.TunnelKeyID != inspection.TunnelKeyID) {
			return ErrDependencyUnavailable
		}
	}
	return nil
}
