package application

import (
	"context"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type peerReplayDependencies struct {
	peerDependencies
	current  ports.NetworkAttachment
	versions []uint64
}

func (deps *peerReplayDependencies) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return deps.current, nil
}
func (deps *peerReplayDependencies) SetAgentNetworkAttachment(_ context.Context, _ string, _ string, version uint64, peer string) (ports.NetworkAttachment, error) {
	deps.versions = append(deps.versions, version)
	if version != deps.current.AttachmentResourceVersion {
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict"}
	}
	deps.current.RuntimeEndpoint = peer
	deps.current.AttachmentResourceVersion++
	return deps.current, nil
}

func TestOpenRetryRebindsAfterLostResponseAndRuntimeAddressChange(t *testing.T) {
	for _, version := range []uint64{2, 4} {
		t.Run(map[uint64]string{2: "own_lost_open", 4: "newer_cycle"}[version], func(t *testing.T) {
			original := validLifecycleNetwork()
			original.AgentID = "agent-1"
			original.AttachmentResourceVersion = 1
			current := original
			current.AttachmentState = ports.NetworkAttachmentOpen
			current.AttachmentResourceVersion = version
			current.RuntimeEndpoint = "10.20.0.8"
			deps := &peerReplayDependencies{peerDependencies: peerDependencies{inspection: peerInspectionForTest("agent-1", "runtime-1")}, current: current}
			service := &LifecycleService{runtime: deps, egress: deps}
			result, err := service.openRuntimeNetwork(t.Context(), "agent-1", "runtime-1", original)
			if version == 2 {
				if err != nil || result.RuntimeEndpoint != "10.20.0.9" || len(deps.versions) != 2 || deps.versions[1] != 2 {
					t.Fatal("lost open could not recover a changed peer", result, err, deps.versions)
				}
			} else if err == nil || len(deps.versions) != 1 {
				t.Fatal("borrowed a newer lifecycle version", err, deps.versions)
			}
		})
	}
}
