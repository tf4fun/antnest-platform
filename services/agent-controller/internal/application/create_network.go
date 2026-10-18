package application

import (
	"context"
	"errors"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Create may publish a configured, non-executable target before its first peer
// exists. Rebuild and Enable retain their separate open-only path.
func (service *LifecycleService) prepareCreateNetwork(ctx context.Context, agentID, revision string, original ports.NetworkAttachment) (ports.NetworkAttachment, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, agentID)
	if err != nil {
		var failure *ports.DependencyError
		if errors.As(err, &failure) {
			return ports.NetworkAttachment{}, err
		}
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-controller", Code: "runtime_inspection_unavailable", Retryable: true, Cause: err}
	}
	desired := ports.NetworkAttachmentOpen
	valid := inspection.AgentID == agentID && inspection.RuntimeRevision == revision && inspection.LifecycleState == "provisioned"
	switch inspection.Phase {
	case "running":
		valid = valid && ports.ValidRuntimePeer(inspection.RuntimeEndpoint) && ports.ValidTunnelKeyID(inspection.TunnelKeyID)
	case "created", "exited":
		desired = ports.NetworkAttachmentPending
		valid = valid && inspection.RuntimeEndpoint == "" && inspection.TunnelKeyID == ""
	default:
		valid = false
	}
	if !valid {
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-controller", Code: "runtime_peer_unavailable", Retryable: true}
	}
	result, err := service.egress.SetAgentNetworkAttachment(ctx, agentID, desired, original.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
	var conflict *ports.DependencyError
	if !errors.As(err, &conflict) || conflict.Service != "runtime-egress" || conflict.Code != "resource_version_conflict" {
		return result, err
	}
	current, readErr := service.egress.GetAgentNetwork(ctx, agentID)
	if readErr != nil {
		return ports.NetworkAttachment{}, readErr
	}
	if !sameNetworkCoordinates(current, original) || current.NetworkResourceVersion != original.NetworkResourceVersion || !immediatelyAfter(current.AttachmentResourceVersion, original.AttachmentResourceVersion) {
		return ports.NetworkAttachment{}, err
	}
	// Recover exactly this operation's committed effect, even if the Runtime phase
	// changed while its reply was lost. Observation supplies any later first peer.
	if pendingCreateAttachment(current, original) {
		return current, nil
	}
	if !networkAttachmentReady(current, agentID) || !ports.ValidRuntimePeer(current.RuntimeEndpoint) || !ports.ValidTunnelKeyID(current.TunnelKeyID) {
		return ports.NetworkAttachment{}, err
	}
	if desired == ports.NetworkAttachmentPending || (current.RuntimeEndpoint == inspection.RuntimeEndpoint && current.TunnelKeyID == inspection.TunnelKeyID) {
		return current, nil
	}
	// Preserve the existing lost-open recovery when the running generation changed.
	return service.egress.SetAgentNetworkAttachment(ctx, agentID, ports.NetworkAttachmentOpen, current.AttachmentResourceVersion, inspection.RuntimeEndpoint, inspection.TunnelKeyID)
}

func immediatelyAfter(current, previous uint64) bool {
	return previous != 0 && current > previous && current-previous == 1
}

func pendingCreateAttachment(current, original ports.NetworkAttachment) bool {
	return networkAttachmentInState(current, original.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentPending) &&
		original.AttachmentState == ports.NetworkAttachmentClosed && current.RuntimeEndpoint == "" && current.TunnelKeyID == "" &&
		sameNetworkCoordinates(current, original) && current.NetworkResourceVersion == original.NetworkResourceVersion && immediatelyAfter(current.AttachmentResourceVersion, original.AttachmentResourceVersion)
}
