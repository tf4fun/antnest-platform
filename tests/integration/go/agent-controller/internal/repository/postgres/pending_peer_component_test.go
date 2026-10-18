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

type pendingPeerSource struct {
	current       ports.RuntimeInspection
	beforeInspect func()
}

func (s *pendingPeerSource) InspectRuntime(context.Context, string) (ports.RuntimeInspection, error) {
	if s.beforeInspect != nil {
		hook := s.beforeInspect
		s.beforeInspect = nil
		hook()
	}
	value := s.current
	value.ObservedAt = time.Now().UTC()
	return value, nil
}
func (s *pendingPeerSource) ListRuntimes(context.Context) ([]ports.RuntimeEnvironmentSnapshot, error) {
	return nil, nil
}
func (s *pendingPeerSource) ListRuntimeObservations(_ context.Context, after uint64, _ int) (ports.RuntimeObservationPage, error) {
	return ports.RuntimeObservationPage{NextSequence: after}, nil
}

type pendingPeerComponentEgress struct {
	offboardingDependencies
	fail      bool
	beforeSet func()
	versions  []uint64
}

func (e *pendingPeerComponentEgress) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	if e.fail {
		return ports.NetworkAttachment{}, errors.New("egress unavailable")
	}
	return e.network, nil
}
func (e *pendingPeerComponentEgress) SetAgentNetworkAttachment(_ context.Context, _ string, state string, version uint64, peer, key string) (ports.NetworkAttachment, error) {
	e.versions = append(e.versions, version)
	if e.beforeSet != nil {
		hook := e.beforeSet
		e.beforeSet = nil
		hook()
	}
	if version != e.network.AttachmentResourceVersion {
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict", Retryable: true}
	}
	if state != e.network.AttachmentState || peer != e.network.RuntimeEndpoint || key != e.network.TunnelKeyID {
		e.network.AttachmentResourceVersion++
	}
	e.network.AttachmentState = state
	e.network.RuntimeEndpoint = peer
	e.network.TunnelKeyID = key
	return e.network, nil
}

func TestPendingCreatePeerReconcilesFromDatabaseWithoutNewJournalAfterRestart(t *testing.T) {
	for _, mode := range []string{"recover", "aggregate_race", "late_disable", "late_next_pending"} {
		t.Run(mode, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, _ := seedConfiguredAgentForTest(t, ctx, repo, false, "pending")
			page, err := repo.ListPendingRuntimeBindings(ctx, "", 500)
			if err != nil || len(page) != 1 || page[0].Operation.NetworkAttachment.AttachmentState != "pending" {
				t.Fatalf("durable pending target missing: %+v %v", page, err)
			}
			source := &pendingPeerSource{current: ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, LifecycleState: "provisioned", Phase: "running", Health: "starting", RuntimeEndpoint: "10.20.0.9", TunnelKeyID: "rtk_0123456789abcdef0123456789abcdef"}}
			egress := &pendingPeerComponentEgress{offboardingDependencies: offboardingDependencies{network: *page[0].Operation.NetworkAttachment}, fail: true}
			newWorker := func() *application.RuntimeObservationWorker {
				worker, err := application.NewRuntimeObservationWorker(source, repo, egress, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
				if err != nil {
					t.Fatal(err)
				}
				return worker
			}
			if err := newWorker().RunOnce(ctx); err == nil {
				t.Fatal("missing Egress was ignored")
			}
			assertExecutionClosed(t, repo, base.Agent)
			egress.fail = false
			if err := repo.ResetRuntimeObservationCursor(ctx, nil, 41); err != nil {
				t.Fatal(err)
			}
			if mode == "aggregate_race" {
				source.beforeInspect = func() {
					if _, err := repo.pool.Exec(ctx, "UPDATE agent_controller.agents SET desired_state='disabled', aggregate_sequence=aggregate_sequence+1 WHERE id=$1", base.Agent.AgentID); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "late_disable" || mode == "late_next_pending" {
				egress.beforeSet = func() {
					// An already-dispatched request reaches Egress after a lifecycle fence.
					if _, err := repo.pool.Exec(ctx, "UPDATE agent_controller.agents SET desired_state='disabled', aggregate_sequence=aggregate_sequence+1 WHERE id=$1", base.Agent.AgentID); err != nil {
						t.Fatal(err)
					}
					egress.network.AttachmentState = "closed"
					egress.network.AttachmentResourceVersion++
					if mode == "late_next_pending" {
						egress.network.AttachmentState = "pending"
						egress.network.AttachmentResourceVersion++
					}
				}
			}
			err = newWorker().RunOnce(ctx)
			if mode == "aggregate_race" {
				if err != nil || len(egress.versions) != 0 || egress.network.AttachmentState != "pending" {
					t.Fatal("aggregate CAS did not precede network effects", err, egress.versions, egress.network)
				}
				assertExecutionClosed(t, repo, base.Agent)
				return
			}
			if mode != "recover" {
				if err == nil || egress.network.AttachmentState == "open" {
					t.Fatal("late request reopened fenced attachment", err, egress.network)
				}
				assertExecutionClosed(t, repo, base.Agent)
				return
			}
			if err != nil || egress.network.AttachmentState != "open" {
				t.Fatal("persisted target did not bind while starting", err, egress.network)
			}
			assertExecutionClosed(t, repo, base.Agent)
			source.current.RuntimeEndpoint = "10.20.0.10"
			if err := newWorker().RunOnce(ctx); err != nil {
				t.Fatal(err)
			}
			source.current.Health = "healthy"
			source.current.RuntimeExecutionID = "process-1"
			source.current.MCPEndpoint = "http://runtime:8091/mcp"
			if err := newWorker().RunOnce(ctx); err != nil {
				t.Fatal(err)
			}
			agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
			if err != nil || agent.RuntimeState != domain.RuntimeAvailable || agent.ExecutionRevisionID == "" || egress.network.RuntimeEndpoint != "10.20.0.10" {
				t.Fatal("healthy target did not publish after rebind", err, agent, egress.network)
			}
			if err := newWorker().RunOnce(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := repo.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.execution_revisions WHERE agent_id=$1", agent.AgentID).Scan(&count); err != nil || count != 1 {
				t.Fatal("replayed observation duplicated execution", count, err)
			}
		})
	}
}
