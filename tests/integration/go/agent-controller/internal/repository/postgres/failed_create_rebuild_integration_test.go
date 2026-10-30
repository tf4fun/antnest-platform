package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func rebuildSeedFailedCreate(
	t *testing.T, repository *Repository, base ports.AgentLifecycleBase, id string,
) (ports.AgentRecord, ports.LifecycleOperationRecord) {
	t.Helper()
	ctx := context.Background()
	create := reliabilitySeedCreate(t, repository, base, id)
	termination := ports.TerminateLifecycleOperation{
		RequestID: create.RequestID, Fingerprint: create.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, ErrorCode: "phase_deadline_exceeded",
		ErrorDetail: "create phase exceeded", EventID: "event-rb-term-" + id,
	}
	if _, err := repository.TerminateLifecycleOperation(ctx, termination); err != nil {
		t.Fatalf("fail create %s: %v", id, err)
	}
	agent, err := loadAgentRecord(ctx, repository.pool, id)
	if err != nil {
		t.Fatal(err)
	}
	return agent, create
}

func rebuildBeginForRetry(
	agent ports.AgentRecord, spec ports.AgentSpecRecord, create ports.LifecycleOperationRecord, now time.Time,
) ports.BeginAgentRebuild {
	requestID := "request-retry-" + agent.AgentID
	deadline := now.Add(time.Minute)
	return ports.BeginAgentRebuild{
		AgentID: agent.AgentID, ExpectedAggregateSequence: agent.AggregateSequence,
		ExpectedSpecRevisionID: spec.ID, ExpectedExecutionRevisionID: "",
		ExpectedRuntimeRevision: "",
		TargetSpec: ports.AgentSpecRecord{
			ID: "spec-retry-" + agent.AgentID, AgentID: agent.AgentID, Revision: spec.Revision + 1,
			Snapshot: spec.Snapshot, CanonicalDigest: spec.CanonicalDigest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: strings.Repeat("f", 64),
			AgentID: agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:        spec.ID,
			TargetSpecRevisionID:        "spec-retry-" + agent.AgentID,
			SourceFailedCreateRequestID: create.RequestID,
			DrainDeadlineAt:             &deadline,
			ChildRequestID:              domain.ChildRequestID(requestID, domain.PhaseDrain),
			CreatedAt:                   now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID:           domain.DeriveResourceID("event", "event-rebuild-requested", requestID),
			AgentID:           agent.AgentID,
			AggregateSequence: agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType:          ports.EventAgentRebuildRequested,
			OperationRequestID: requestID,
			Data:               map[string]any{"actor_principal_id": "actor-1"}, OccurredAt: now,
		},
		Now: now,
	}
}

func TestFailedCreateRebuildMarkerBaseAndBegin(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	agent, create := rebuildSeedFailedCreate(t, repository, base, "retry-agent")
	loaded, err := repository.GetAgentLifecycleBase(ctx, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.FailedCreateOperation == nil || loaded.FailedCreateOperation.RequestID != create.RequestID {
		t.Fatalf("base failed-create source %+v", loaded.FailedCreateOperation)
	}
	if loaded.ConfiguredSpec.ID != create.TargetSpecRevisionID {
		t.Fatalf("configured spec %q, want %q", loaded.ConfiguredSpec.ID, create.TargetSpecRevisionID)
	}
	if !ports.FailedCreateRebuildSourceMatches(loaded) {
		t.Fatal("loaded base must satisfy the pure retry guard")
	}
	now := time.Now().UTC()
	state, replayed, err := repository.BeginAgentRebuild(ctx, rebuildBeginForRetry(agent, loaded.ConfiguredSpec, create, now))
	if err != nil {
		t.Fatal(err)
	}
	if replayed {
		t.Fatal("first retry admission must not replay")
	}
	if state.Operation.SourceFailedCreateRequestID != create.RequestID {
		t.Fatalf("stored marker %q", state.Operation.SourceFailedCreateRequestID)
	}
	forfeits := []struct {
		name   string
		mutate func(id string)
	}{
		{"second lifecycle", func(id string) {
			gcInsertTerminalOperation(t, repository, id, time.Now().UTC())
		}},
		{"ever ready", func(id string) {
			agent, err := loadAgentRecord(ctx, repository.pool, id)
			if err != nil {
				t.Fatal(err)
			}
			gcInsertReadyEvent(t, repository, id, agent.AggregateSequence+1, time.Now().UTC())
		}},
		{"runtime pointer", func(id string) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET runtime_revision = 'runtime-1' WHERE id = $1", id); err != nil {
				t.Fatal(err)
			}
		}},
		{"cancelled create", func(id string) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agent_lifecycle_operations SET error_code = 'lifecycle_cancelled' WHERE agent_id = $1", id); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range forfeits {
		t.Run(tc.name, func(t *testing.T) {
			freshAgent, freshCreate := rebuildSeedFailedCreate(t, repository, base, "retry-x-"+strings.ReplaceAll(tc.name, " ", "-"))
			tc.mutate(freshAgent.AgentID)
			loaded, err := repository.GetAgentLifecycleBase(ctx, freshAgent.AgentID)
			if err != nil {
				t.Fatal(err)
			}
			if loaded.FailedCreateOperation != nil {
				t.Fatalf("%s must forfeit the retry source", tc.name)
			}
			if ports.FailedCreateRebuildSourceMatches(loaded) {
				t.Fatalf("%s must fail the pure guard", tc.name)
			}
			now := time.Now().UTC()
			spec := loaded.ConfiguredSpec
			if spec.ID == "" {
				spec = ports.AgentSpecRecord{ID: freshCreate.TargetSpecRevisionID, AgentID: freshAgent.AgentID, Revision: 1}
			}
			_, _, err = repository.BeginAgentRebuild(ctx, rebuildBeginForRetry(freshAgent, spec, freshCreate, now))
			if !errors.Is(err, ports.ErrConcurrentChange) {
				t.Fatalf("%s must reject the forged begin: %v", tc.name, err)
			}
		})
	}
}

func TestFailedCreateRebuildGCCompetesUnderLocks(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	agent, create := rebuildSeedFailedCreate(t, repository, base, "gc-vs-rebuild")
	if _, err := repository.pool.Exec(ctx,
		"UPDATE agent_controller.agent_lifecycle_operations SET updated_at = $1 WHERE request_id = $2",
		cutoff.Add(-24*time.Hour), create.RequestID); err != nil {
		t.Fatal(err)
	}
	loaded, err := repository.GetAgentLifecycleBase(ctx, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	rebuildInput := rebuildBeginForRetry(agent, loaded.ConfiguredSpec, create, now)
	candidate := gcCandidateFor(agent, create)
	gcInput := gcBeginDelete(agent, create, candidate, cutoff, now)
	raceCtx, raceDone := context.WithTimeout(ctx, 5*time.Second)
	defer raceDone()
	var rebuildErr, gcErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, _, rebuildErr = repository.BeginAgentRebuild(raceCtx, rebuildInput)
	}()
	go func() {
		defer wait.Done()
		_, _, gcErr = repository.BeginAgentDelete(raceCtx, gcInput)
	}()
	wait.Wait()
	wins := 0
	if rebuildErr == nil {
		wins++
	} else if !errors.Is(rebuildErr, ports.ErrConcurrentChange) {
		t.Fatalf("rebuild error %v", rebuildErr)
	}
	if gcErr == nil {
		wins++
	} else if !errors.Is(gcErr, ports.ErrConcurrentChange) {
		t.Fatalf("GC error %v", gcErr)
	}
	if wins != 1 {
		t.Fatalf("exactly one admission must win under the locks, got %d (rebuild=%v gc=%v)", wins, rebuildErr, gcErr)
	}
	agent, err = loadAgentRecord(ctx, repository.pool, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if rebuildErr == nil {
		if agent.ActiveOperationRequestID != rebuildInput.Operation.RequestID {
			t.Fatalf("rebuild won but active op is %q", agent.ActiveOperationRequestID)
		}
		if reliabilityEvents(t, repository, "agent_gc_scheduled", agent.AgentID) != 0 {
			t.Fatal("rebuild winner must emit no GC event")
		}
		if reliabilityEvents(t, repository, ports.EventAgentRebuildRequested, agent.AgentID) != 1 ||
			reliabilityEvents(t, repository, ports.EventAgentDeleteRequested, agent.AgentID) != 0 {
			t.Fatal("only the winning rebuild may emit a requested event")
		}
	} else {
		if agent.ActiveOperationRequestID != gcInput.Operation.RequestID {
			t.Fatalf("GC won but active op is %q", agent.ActiveOperationRequestID)
		}
		if reliabilityEvents(t, repository, "agent_gc_scheduled", agent.AgentID) != 1 {
			t.Fatal("GC winner must emit exactly one GC event")
		}
		if reliabilityEvents(t, repository, ports.EventAgentDeleteRequested, agent.AgentID) != 1 ||
			reliabilityEvents(t, repository, ports.EventAgentRebuildRequested, agent.AgentID) != 0 {
			t.Fatal("only the winning delete may emit a requested event")
		}
	}
}

func TestFailedCreateRebuildPhasesPublishAndReplay(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	agent, create := rebuildSeedFailedCreate(t, repository, base, "retry-flow")
	loaded, err := repository.GetAgentLifecycleBase(ctx, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	begin := rebuildBeginForRetry(agent, loaded.ConfiguredSpec, create, now)
	_, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil {
		t.Fatal(err)
	}
	if replayed {
		t.Fatal("first admission must not replay")
	}
	// Exact replay emits nothing twice.
	replayedState, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil || !replayed {
		t.Fatalf("exact begin replay must return stored state: %v replayed=%v", err, replayed)
	}
	if replayedState.Operation.SourceFailedCreateRequestID != create.RequestID {
		t.Fatal("replay must preserve the marker")
	}
	request, fingerprint := begin.Operation.RequestID, begin.Operation.RequestFingerprint
	if _, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{
		RequestID: request, Fingerprint: fingerprint, Kind: domain.OperationRebuild,
		Outcome: ports.ExecutionSettled, Now: now,
	}); err != nil {
		t.Fatal(err)
	}
	attachment := closedNetworkAttachment(agent.AgentID)
	if _, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeUpdate,
		NextChildRequestID: domain.ChildRequestID(request, domain.PhaseRuntimeUpdate),
		NetworkAttachment:  attachment, Now: now,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := ports.RuntimeOperation{State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_55555555555555555555555555555555",
		LifecycleState:  "provisioned", Health: "unknown"}
	if _, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure,
		NextChildRequestID: domain.ChildRequestID(request, domain.PhaseNetworkEnsure),
		RuntimeResult:      &runtime, Now: now,
	}); err != nil {
		t.Fatal(err)
	}
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	attachment.AttachmentResourceVersion++
	attachment.RuntimeEndpoint = "10.20.0.11"
	attachment.TunnelKeyID = "rtk_55555555555555555555555555555555"
	advanced, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(request, domain.PhasePublish),
		NetworkAttachment:  attachment, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	publish := ports.PublishAgentRebuild{
		RequestID: request, Fingerprint: fingerprint, AccessRevision: "access-retry-" + agent.AgentID,
		RebuiltEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-rebuilt", request),
			AgentID: agent.AgentID, AggregateSequence: advanced.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentRebuilt,
			OperationRequestID: request, Data: map[string]any{}, OccurredAt: now,
		}, Now: now,
	}
	published, err := repository.PublishAgentRebuild(ctx, publish)
	if err != nil {
		t.Fatal(err)
	}
	if published.Agent.LifecycleState != domain.AgentCreated ||
		published.Agent.ActivationState != domain.ActivationEnabled ||
		published.Agent.AgentSpecRevisionID != begin.TargetSpec.ID ||
		published.Agent.RuntimeRevision != runtime.RuntimeRevision ||
		published.Agent.ExecutionRevisionID != "" ||
		published.Agent.ActiveOperationRequestID != "" ||
		published.Agent.FailureCode != "" || published.Agent.FailureStage != "" {
		t.Fatalf("published agent %+v", published.Agent)
	}
	if published.Operation.SourceFailedCreateRequestID != create.RequestID ||
		published.Operation.State != domain.OperationCompleted {
		t.Fatalf("marker roundtrip %+v", published.Operation)
	}
	replayedPublish, err := repository.PublishAgentRebuild(ctx, publish)
	if err != nil {
		t.Fatalf("replay publish: %v", err)
	}
	if replayedPublish.Agent.AggregateSequence != published.Agent.AggregateSequence ||
		replayedPublish.Operation.UpdatedAt != published.Operation.UpdatedAt ||
		replayedPublish.Operation.SourceFailedCreateRequestID != create.RequestID {
		t.Fatal("exact publish replay changed the persisted outcome")
	}
	if reliabilityEvents(t, repository, "agent_rebuilt", agent.AgentID) != 1 {
		t.Fatal("agent_rebuilt must be emitted exactly once")
	}
}

func TestFailedCreateRebuildBlankStoredSpecFallback(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	agent, create := rebuildSeedFailedCreate(t, repository, base, "retry-blank")
	if _, err := repository.pool.Exec(ctx,
		"UPDATE agent_controller.agents SET executable_spec_revision_id = '' WHERE id = $1",
		agent.AgentID); err != nil {
		t.Fatal(err)
	}
	loaded, err := repository.GetAgentLifecycleBase(ctx, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.FailedCreateOperation == nil || loaded.ConfiguredSpec.ID != create.TargetSpecRevisionID {
		t.Fatalf("blank stored spec must fall back to the failed create target: %+v", loaded)
	}
	if !ports.FailedCreateRebuildSourceMatches(loaded) {
		t.Fatal("blank-stored-spec base must satisfy the guard")
	}
	now := time.Now().UTC()
	begin := rebuildBeginForRetry(agent, loaded.ConfiguredSpec, create, now)
	state, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil {
		t.Fatal(err)
	}
	if replayed {
		t.Fatal("first admission must not replay")
	}
	if state.SourceSpec.ID != create.TargetSpecRevisionID {
		t.Fatalf("begin must rebuild the failed create target spec: %+v", state.SourceSpec)
	}
	if state.Operation.SourceFailedCreateRequestID != create.RequestID {
		t.Fatalf("begin must carry the retry marker: %+v", state.Operation)
	}
	replayedState, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil || !replayed {
		t.Fatalf("exact begin replay must return stored state: %v replayed=%v", err, replayed)
	}
	if replayedState.Operation.RequestID != state.Operation.RequestID ||
		replayedState.Operation.SourceFailedCreateRequestID != create.RequestID {
		t.Fatalf("replay must preserve the operation and marker: %+v", replayedState.Operation)
	}
}
