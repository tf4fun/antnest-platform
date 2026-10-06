package postgres

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type peerRetryComponentSource struct{ current ports.RuntimeInspection }

func (source *peerRetryComponentSource) InspectRuntime(context.Context, string) (ports.RuntimeInspection, error) {
	current := source.current
	current.ObservedAt = time.Now().UTC()
	return current, nil
}
func (source *peerRetryComponentSource) ListRuntimes(context.Context) ([]ports.RuntimeEnvironmentSnapshot, error) {
	return []ports.RuntimeEnvironmentSnapshot{{AgentID: source.current.AgentID, RuntimeRevision: source.current.RuntimeRevision, LifecycleState: "provisioned", Phase: "running", Health: "healthy", RuntimeExecutionID: source.current.RuntimeExecutionID}}, nil
}
func (source *peerRetryComponentSource) ListRuntimeObservations(_ context.Context, after uint64, _ int) (ports.RuntimeObservationPage, error) {
	if after == 0 {
		return ports.RuntimeObservationPage{Observations: []ports.RuntimeObservation{{Sequence: 1, AgentID: source.current.AgentID, RuntimeRevision: source.current.RuntimeRevision, Kind: ports.RuntimeObservationRestarted}}, NextSequence: 1}, nil
	}
	return ports.RuntimeObservationPage{NextSequence: after}, nil
}

type peerRetryComponentEgress struct {
	offboardingDependencies
	failure error
}

func (egress *peerRetryComponentEgress) GetAgentNetwork(ctx context.Context, id string) (ports.NetworkAttachment, error) {
	if egress.failure != nil {
		return ports.NetworkAttachment{}, egress.failure
	}
	return egress.offboardingDependencies.GetAgentNetwork(ctx, id)
}

func TestPeerRetryCommitsJournalAndHealthBeforeEgressAndRecoversAfterWorkerRestart(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	source := &peerRetryComponentSource{current: ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, RuntimeEndpoint: "10.20.0.10", RuntimeExecutionID: "new-process", MCPEndpoint: "http://runtime:8091/mcp", Phase: "running", LifecycleState: "provisioned", Health: "healthy"}}
	network := *closedNetworkAttachment(base.Agent.AgentID)
	network.AttachmentState, network.RuntimeEndpoint = ports.NetworkAttachmentOpen, "10.20.0.9"
	egress := &peerRetryComponentEgress{offboardingDependencies: offboardingDependencies{network: network}, failure: errors.New("Egress unavailable")}
	newWorker := func() *application.RuntimeObservationWorker {
		worker, err := application.NewRuntimeObservationWorker(source, repo, egress, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		return worker
	}
	if err := newWorker().RunOnce(ctx); err == nil {
		t.Fatal("binding failure was not reported")
	}
	cursor, err := repo.GetRuntimeObservationCursor(ctx)
	if err != nil || cursor.Sequence != 1 {
		t.Fatal("Egress outage held the journal cursor", cursor, err)
	}
	agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.RuntimeState != domain.RuntimeAvailable || agent.ExecutionRevisionID != "" {
		t.Fatal("health was not saved or execution was published before binding", agent, err)
	}
	assertExecutionClosed(t, repo, agent)
	egress.failure = nil
	if err := newWorker().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	agent, err = repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.ExecutionRevisionID == "" || egress.network.RuntimeEndpoint != "10.20.0.10" {
		t.Fatal("fresh worker lost pending binding/readiness", agent, egress.network, err)
	}
}
