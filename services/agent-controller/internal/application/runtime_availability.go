package application

import (
	"context"
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Events detect loss; current inspections publish readiness. A ready event can
// arrive before the lifecycle transaction, so every pass also reconciles intent.
func (worker *RuntimeObservationWorker) reconcilePendingBindings(ctx, peerCtx context.Context) error {
	var failures []error
	after := ""
	for {
		page, err := worker.store.ListPendingRuntimeBindings(ctx, after, runtimeObservationPageSize)
		if err != nil {
			return errors.Join(append(failures, err)...)
		}
		for _, pending := range page {
			if pending.Agent.AgentID <= after {
				return errors.Join(append(failures, errors.New("pending Runtime page is not ordered"))...)
			}
			after = pending.Agent.AgentID
			if err := worker.reconcilePendingBinding(ctx, peerCtx, pending); err != nil {
				failures = append(failures, fmt.Errorf("observe Agent %s: %w", after, err))
			}
		}
		if len(page) < runtimeObservationPageSize {
			return errors.Join(failures...)
		}
	}
}

func (worker *RuntimeObservationWorker) reconcilePendingBinding(ctx, peerCtx context.Context, pending ports.PendingRuntimeBinding) error {
	if !pending.Agent.CanObserveRuntime() {
		return nil
	}
	inspection, err := worker.source.InspectRuntime(ctx, pending.Agent.AgentID)
	if err != nil {
		_, saveErr := worker.store.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
			ExpectedAggregateSequence: pending.Agent.AggregateSequence, TraceID: currentTraceID(ctx),
			Inspection: ports.RuntimeInspection{AgentID: pending.Agent.AgentID, RuntimeRevision: pending.Agent.RuntimeRevision,
				Phase: "unknown", Health: "unknown", Reason: "runtime_observation_failed", ObservedAt: time.Now().UTC()},
		})
		return errors.Join(err, saveErr)
	}
	sequence, err := worker.store.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: pending.Agent.AggregateSequence, Inspection: inspection, TraceID: currentTraceID(ctx),
	})
	if errors.Is(err, ports.ErrConcurrentChange) {
		return nil
	}
	if err != nil {
		return err
	}
	pending.Agent.AggregateSequence = sequence
	if !pending.Agent.AwaitingRuntimeBinding() || !observedBindingMatches(pending.Agent, inspection) {
		return nil
	}
	if err := worker.bindObservedPeer(peerCtx, pending, inspection); err != nil {
		worker.pendingPeers[pending.Agent.AgentID] = struct{}{}
		return err
	}
	now := time.Now().UTC()
	execution := ports.ExecutionRecord{
		ID:      domain.DeriveResourceID("execution", "execution-observed", pending.Operation.RequestID),
		AgentID: pending.Agent.AgentID, Revision: pending.NextExecutionRevision,
		AgentSpecRevisionID: pending.Spec.ID, RuntimeRevision: inspection.RuntimeRevision,
		RuntimeExecutionID: inspection.RuntimeExecutionID, RuntimeMCPEndpoint: inspection.MCPEndpoint,
		RuntimeMCPSourceDigest: digestString(inspection.MCPEndpoint),
		ChangeSummary:          map[string]any{"kind": pending.Operation.Kind}, PublishedAt: now,
	}
	_, err = worker.store.PublishRuntimeBinding(ctx, ports.PublishRuntimeBinding{
		ExpectedAggregateSequence: pending.Agent.AggregateSequence,
		OperationRequestID:        pending.Operation.RequestID, Execution: execution,
		ReadyEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-ready", pending.Operation.RequestID), AgentID: pending.Agent.AgentID,
			AggregateSequence: pending.Agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType: ports.EventAgentReady, OperationRequestID: pending.Operation.RequestID,
			TraceID: currentTraceID(ctx), OccurredAt: now,
			Data: map[string]any{"agent_spec_revision_id": pending.Spec.ID,
				"execution_revision_id": execution.ID, "runtime_revision": inspection.RuntimeRevision},
		},
	})
	if errors.Is(err, ports.ErrConcurrentChange) {
		return nil
	}
	return err
}

func observedBindingMatches(agent ports.AgentRecord, inspection ports.RuntimeInspection) bool {
	if inspection.AgentID != agent.AgentID || inspection.RuntimeRevision != agent.RuntimeRevision ||
		inspection.LifecycleState != "provisioned" || inspection.Phase != "running" || inspection.Health != "healthy" ||
		strings.TrimSpace(inspection.RuntimeExecutionID) == "" {
		return false
	}
	endpoint, err := url.ParseRequestURI(inspection.MCPEndpoint)
	return err == nil && endpoint.Host != "" && endpoint.User == nil && endpoint.Fragment == "" &&
		(endpoint.Scheme == "http" || endpoint.Scheme == "https")
}

func (worker *RuntimeObservationWorker) applyObservation(ctx context.Context, observation ports.RuntimeObservation) error {
	if observation.AgentID != "" {
		current, err := worker.source.InspectRuntime(ctx, observation.AgentID)
		if err != nil {
			return err
		}
		if current.AgentID != observation.AgentID {
			return errors.New("runtime observation inspection belongs to another Agent")
		}
		observation.Current = &current
	}
	if err := worker.store.ApplyRuntimeObservation(ctx, observation); err != nil {
		return err
	}
	if current := observation.Current; current != nil && current.Phase == "running" && current.LifecycleState == "provisioned" {
		worker.pendingPeers[current.AgentID] = struct{}{}
	} else {
		delete(worker.pendingPeers, observation.AgentID)
	}
	return nil
}
