package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRepositoryPersistsAndPublishesDisableSaga(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(300, 0).UTC()
	requestID := "request-disable-integration"
	fingerprint := strings.Repeat("4", 64)
	begin := disableBegin(base, requestID, fingerprint, now)
	started, replayed, err := repository.BeginAgentDisable(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent disable: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	if started.Agent.DesiredState != domain.DesiredDisabled ||
		started.Agent.LifecycleState != domain.AgentAvailable ||
		started.Agent.ActiveOperationRequestID != requestID {
		t.Fatalf("started disable = %+v", started)
	}

	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9,
          jsonb_build_object(
              'runtime', jsonb_build_object('runtime_revision', $9::text),
              'execution_spec', jsonb_build_object('skill_instructions', '[]'::jsonb)
          ), $10, $10)`,
		"admission-disable-integration", "request-run-disable-integration",
		strings.Repeat("5", 64), base.Agent.AgentID, "session-disable-integration",
		base.Agent.OwnerUserID, base.Agent.AccessRevision, now.Add(time.Hour),
		base.Agent.RuntimeRevision, now,
	); err != nil {
		t.Fatalf("insert active Run admission: %v", err)
	}
	blocked, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint, domain.ChildRequestID(requestID, domain.PhaseNetworkFence),
		now.Add(time.Second),
	)
	if err != nil || blocked.Operation.Phase != domain.PhaseDrain {
		t.Fatalf("active Run did not block disable: state=%+v err=%v", blocked, err)
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET state = 'blocked_unknown_effect',
    terminal_report = '{"terminal_class":"unresolved","tool_effect_state":"unknown","unknown_effect_source":"runtime_mcp","stop_reason":"","error_class":"tool_outcome_unknown"}'::jsonb,
    finished_at = $2,
    updated_at = $2
WHERE admission_id = $1`,
		"admission-disable-integration", now.Add(time.Second),
	); err != nil {
		t.Fatalf("mark Run effect unresolved: %v", err)
	}
	drained, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint, domain.ChildRequestID(requestID, domain.PhaseNetworkFence),
		now.Add(2*time.Second),
	)
	if err != nil || drained.Operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle disable drain: state=%+v err=%v", drained, err)
	}

	withFence, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
		NetworkAttachment:  closedNetworkAttachment(base.Agent.AgentID),
		Now:                now.Add(4 * time.Second),
	})
	if err != nil || withFence.Operation.Phase != domain.PhaseRuntimeDisable {
		t.Fatalf("record disable fence: state=%+v err=%v", withFence, err)
	}

	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_33333333333333333333333333333333",
		LifecycleState:  "disabled", Health: "absent",
	}
	advanceRuntime := ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeDisable, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhasePublish),
		RuntimeResult:      &runtime,
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-run-release-disable-integration", "runtime_disabled",
			base.Agent.RuntimeRevision, now.Add(5*time.Second),
		),
		Now: now.Add(5 * time.Second),
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET runtime_revision = $2,
    snapshot = jsonb_set(snapshot, '{runtime,runtime_revision}', to_jsonb($2::text))
WHERE admission_id = $1`,
		"admission-disable-integration", "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	); err != nil {
		t.Fatalf("set mismatched unresolved Run revision: %v", err)
	}
	if _, err := repository.AdvanceAgentDisable(ctx, advanceRuntime); err == nil {
		t.Fatal("Runtime disable released an unresolved Run from another Runtime revision")
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET runtime_revision = $2,
    snapshot = jsonb_set(snapshot, '{runtime,runtime_revision}', to_jsonb($2::text))
WHERE admission_id = $1`,
		"admission-disable-integration", base.Agent.RuntimeRevision,
	); err != nil {
		t.Fatalf("restore unresolved Run revision: %v", err)
	}
	withRuntime, err := repository.AdvanceAgentDisable(ctx, advanceRuntime)
	if err != nil || withRuntime.Operation.Phase != domain.PhasePublish {
		t.Fatalf("record Runtime disable: state=%+v err=%v", withRuntime, err)
	}
	var admissionState, releasedBy string
	if err := repository.pool.QueryRow(ctx, `
SELECT state, released_by_operation_request_id
FROM agent_controller.run_admissions WHERE admission_id = $1`,
		"admission-disable-integration",
	).Scan(&admissionState, &releasedBy); err != nil {
		t.Fatalf("load released Run admission: %v", err)
	}
	if admissionState != "released" || releasedBy != requestID {
		t.Fatalf("released Run state=%q operation=%q", admissionState, releasedBy)
	}
	assertLifecycleRunRelease(
		t, ctx, repository, "event-run-release-disable-integration", base.Agent.AgentID,
		"admission-disable-integration", requestID,
		begin.RequestedEvent.AggregateSequence+1,
	)

	published, err := repository.PublishAgentDisable(ctx, ports.PublishAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		DisabledEvent: ports.AgentEventRecord{
			EventID: "event-disabled-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: withRuntime.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisabled,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(6 * time.Second),
		},
		Now: now.Add(6 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish Agent disable: %v", err)
	}
	if published.Agent.DesiredState != domain.DesiredDisabled ||
		published.Agent.LifecycleState != domain.AgentDisabled ||
		published.Agent.AgentSpecRevisionID != base.Agent.AgentSpecRevisionID ||
		published.Agent.ExecutionRevisionID != "" ||
		published.Agent.LastSuccessfulExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		published.Agent.RuntimeRevision != runtime.RuntimeRevision ||
		published.Agent.RuntimeExecutionID != "" || published.Agent.RuntimeMCPEndpoint != "" ||
		published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published disable = %+v", published)
	}
	replayedState, found, err := repository.ReplayAgentDisable(ctx, requestID, fingerprint)
	if err != nil || !found || replayedState.Operation.State != domain.OperationCompleted {
		t.Fatalf("replay Agent disable: state=%+v found=%t err=%v", replayedState, found, err)
	}
}

func TestLifecycleRepositoryDisableFailureRestoresExecutableSource(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(400, 0).UTC()
	requestID := "request-disable-failure-integration"
	fingerprint := strings.Repeat("6", 64)
	begin := disableBegin(base, requestID, fingerprint, now)
	started, _, err := repository.BeginAgentDisable(ctx, begin)
	if err != nil {
		t.Fatalf("begin Agent disable: %v", err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	if _, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseDrain, Code: "runtime_drift", Detail: "invalid early absence",
		RuntimeAbsenceProof: &ports.RuntimeAbsenceProof{
			Reason: "runtime_deleted", RuntimeRevision: base.Agent.RuntimeRevision,
			ObservedAt: now.Add(time.Second),
		},
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-invalid-early-disable-release", "runtime_deleted",
			base.Agent.RuntimeRevision, now.Add(time.Second),
		),
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-invalid-early-disable-failure", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now.Add(time.Second),
		},
		Now: now.Add(time.Second),
	}); err == nil {
		t.Fatal("disable accepted Runtime absence proof before Runtime barrier")
	}
	unchanged, found, err := repository.ReplayAgentDisable(ctx, requestID, fingerprint)
	if err != nil || !found || unchanged.Operation.State != domain.OperationRunning ||
		unchanged.Operation.Phase != domain.PhaseDrain ||
		unchanged.Agent.AggregateSequence != started.Agent.AggregateSequence {
		t.Fatalf("early absence changed disable state: state=%+v found=%t err=%v", unchanged, found, err)
	}
	failed, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseDrain, Code: "run_drain_timeout", Detail: "Run did not settle",
		PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-failed-integration", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now.Add(time.Second),
		},
		Now: now.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("fail Agent disable: %v", err)
	}
	if failed.Agent.DesiredState != domain.DesiredEnabled ||
		failed.Agent.LifecycleState != domain.AgentAvailable ||
		failed.Agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		failed.Agent.RuntimeRevision != base.Agent.RuntimeRevision ||
		failed.Operation.State != domain.OperationFailed {
		t.Fatalf("disable failure did not restore source: %+v", failed)
	}
}

func TestLifecycleRepositoryDisableFailureWithoutSourceProofFailsClosed(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(500, 0).UTC()
	requestID := "request-disable-unverified-integration"
	fingerprint := strings.Repeat("7", 64)
	started, _, err := repository.BeginAgentDisable(
		ctx, disableBegin(base, requestID, fingerprint, now),
	)
	if err != nil {
		t.Fatalf("begin Agent disable: %v", err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	if _, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	); err != nil {
		t.Fatalf("settle Agent disable drain: %v", err)
	}
	if _, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
		NetworkAttachment:  closedNetworkAttachment(base.Agent.AgentID),
		Now:                now.Add(3 * time.Second),
	}); err != nil {
		t.Fatalf("advance Agent disable to Runtime: %v", err)
	}
	inspection := ports.RuntimeInspection{
		AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		RuntimeExecutionID: "different-execution", MCPEndpoint: base.Agent.RuntimeMCPEndpoint,
		LifecycleState: "ready", Health: "healthy",
	}
	failed, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseRuntimeDisable, Code: "runtime_lifecycle_conflict",
		Detail: "source Runtime could not be proven", PreserveExecutable: false,
		SourceRuntimeInspection: &inspection,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-unverified-integration", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now.Add(4 * time.Second),
		},
		Now: now.Add(4 * time.Second),
	})
	if err != nil {
		t.Fatalf("fail unverified Agent disable: %v", err)
	}
	if failed.Agent.DesiredState != domain.DesiredDisabled ||
		failed.Agent.LifecycleState != domain.AgentUnavailable ||
		failed.Agent.AgentSpecRevisionID != "" || failed.Agent.ExecutionRevisionID != "" ||
		failed.Agent.RuntimeRevision != "" ||
		failed.Agent.LastSuccessfulExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		failed.Operation.SourceExecutionRevisionID != base.ExecutableExecution.ID ||
		failed.Operation.SourceRuntimeInspection == nil ||
		*failed.Operation.SourceRuntimeInspection != inspection {
		t.Fatalf("unverified disable did not fail closed: %+v", failed)
	}
}

func TestLifecycleRepositoryRuntimeAbsenceFailureReleasesRunExactlyOnce(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(600, 0).UTC()
	requestID := "request-disable-runtime-absent"
	fingerprint := strings.Repeat("8", 64)
	started, admissionID, ctx := prepareDisableRuntimeFailure(
		t, ctx, repository, base, requestID, fingerprint, now, true,
	)
	input := ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseRuntimeDisable, Code: "runtime_drift",
		Detail: "source Runtime is absent", PreserveExecutable: false,
		RuntimeAbsenceProof: &ports.RuntimeAbsenceProof{
			Reason: "runtime_deleted", RuntimeRevision: base.Agent.RuntimeRevision,
			ObservedAt: now.Add(4 * time.Second),
		},
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-run-release-disable-absent", "runtime_deleted",
			base.Agent.RuntimeRevision, now.Add(4*time.Second),
		),
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-runtime-absent", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(4 * time.Second),
		},
		Now: now.Add(4 * time.Second),
	}

	failed, err := repository.FailAgentDisable(ctx, input)
	if err != nil {
		t.Fatalf("fail disable after Runtime absence: %v", err)
	}
	if failed.Agent.LifecycleState != domain.AgentUnavailable ||
		failed.Operation.State != domain.OperationFailed ||
		failed.Operation.SourceRuntimeAbsenceProof == nil ||
		failed.Operation.SourceRuntimeAbsenceProof.Reason != "runtime_deleted" ||
		failed.Agent.AggregateSequence != started.Agent.AggregateSequence+2 {
		t.Fatalf("Runtime-absence failure = %+v", failed)
	}
	assertLifecycleRunRelease(
		t, ctx, repository, "event-run-release-disable-absent", base.Agent.AgentID,
		admissionID, requestID, started.Agent.AggregateSequence+1,
	)
	var failureSequence int64
	if err := repository.pool.QueryRow(ctx, `
SELECT aggregate_sequence FROM agent_controller.agent_events WHERE event_id = $1`,
		"event-disable-runtime-absent",
	).Scan(&failureSequence); err != nil {
		t.Fatalf("load disable failure event: %v", err)
	}
	if failureSequence != started.Agent.AggregateSequence+2 {
		t.Fatalf("disable failure sequence = %d", failureSequence)
	}

	replayed, err := repository.FailAgentDisable(ctx, input)
	if err != nil || replayed.Agent.AggregateSequence != failed.Agent.AggregateSequence {
		t.Fatalf("replay Runtime-absence failure: state=%+v err=%v", replayed, err)
	}
	var eventCount int
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*) FROM agent_controller.agent_events
WHERE operation_request_id = $1 AND event_type IN ('run_admission_released', 'agent_disable_failed')`,
		requestID,
	).Scan(&eventCount); err != nil || eventCount != 2 {
		t.Fatalf("terminal event count = %d err=%v", eventCount, err)
	}
}

func TestLifecycleRepositoryRuntimeAbsenceFailureRollsBackReleaseWithEventConflict(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(700, 0).UTC()
	requestID := "request-disable-runtime-absence-rollback"
	fingerprint := strings.Repeat("9", 64)
	started, admissionID, ctx := prepareDisableRuntimeFailure(
		t, ctx, repository, base, requestID, fingerprint, now, true,
	)
	var cursorBefore int64
	var eventCountBefore int
	if err := repository.pool.QueryRow(ctx, `
SELECT last_sequence FROM agent_controller.event_journal_cursor WHERE singleton = TRUE`,
	).Scan(&cursorBefore); err != nil {
		t.Fatalf("load event cursor before rollback: %v", err)
	}
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*) FROM agent_controller.agent_events`,
	).Scan(&eventCountBefore); err != nil {
		t.Fatalf("count events before rollback: %v", err)
	}
	_, err = repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseRuntimeDisable, Code: "runtime_drift",
		Detail: "source Runtime is absent", PreserveExecutable: false,
		RuntimeAbsenceProof: &ports.RuntimeAbsenceProof{
			Reason: "runtime_deleted", RuntimeRevision: base.Agent.RuntimeRevision,
			ObservedAt: now.Add(4 * time.Second),
		},
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-run-release-disable-rollback", "runtime_deleted",
			base.Agent.RuntimeRevision, now.Add(4*time.Second),
		),
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-requested-" + requestID, AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(4 * time.Second),
		},
		Now: now.Add(4 * time.Second),
	})
	if err == nil {
		t.Fatal("duplicate failure event ID did not abort the transaction")
	}

	operation, err := repository.GetLifecycleOperation(ctx, requestID)
	if err != nil || operation.State != domain.OperationRunning ||
		operation.Phase != domain.PhaseRuntimeDisable || operation.SourceRuntimeAbsenceProof != nil {
		t.Fatalf("operation changed after rollback: operation=%+v err=%v", operation, err)
	}
	var admissionState string
	if err := repository.pool.QueryRow(ctx, `
SELECT state FROM agent_controller.run_admissions WHERE admission_id = $1`, admissionID,
	).Scan(&admissionState); err != nil || admissionState != "blocked_unknown_effect" {
		t.Fatalf("admission state after rollback = %q err=%v", admissionState, err)
	}
	agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.AggregateSequence != started.Agent.AggregateSequence ||
		agent.ActiveOperationRequestID != requestID {
		t.Fatalf("Agent projection changed after rollback: agent=%+v err=%v", agent, err)
	}
	var cursorAfter int64
	var eventCountAfter int
	if err := repository.pool.QueryRow(ctx, `
SELECT last_sequence FROM agent_controller.event_journal_cursor WHERE singleton = TRUE`,
	).Scan(&cursorAfter); err != nil {
		t.Fatalf("load event cursor after rollback: %v", err)
	}
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*) FROM agent_controller.agent_events`,
	).Scan(&eventCountAfter); err != nil {
		t.Fatalf("count events after rollback: %v", err)
	}
	if cursorAfter != cursorBefore || eventCountAfter != eventCountBefore {
		t.Fatalf(
			"event journal changed after rollback: cursor %d->%d events %d->%d",
			cursorBefore, cursorAfter, eventCountBefore, eventCountAfter,
		)
	}
}

func TestLifecycleRepositoryRuntimeAbsenceFailureWithoutBlockedRunAddsNoReleaseEvent(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(800, 0).UTC()
	requestID := "request-disable-runtime-absent-no-run"
	fingerprint := strings.Repeat("b", 64)
	started, _, ctx := prepareDisableRuntimeFailure(
		t, ctx, repository, base, requestID, fingerprint, now, false,
	)
	failed, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseRuntimeDisable, Code: "runtime_drift",
		Detail: "source Runtime is absent", PreserveExecutable: false,
		RuntimeAbsenceProof: &ports.RuntimeAbsenceProof{
			Reason: "runtime_deleted", RuntimeRevision: base.Agent.RuntimeRevision,
			ObservedAt: now.Add(4 * time.Second),
		},
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-unused-run-release", "runtime_deleted",
			base.Agent.RuntimeRevision, now.Add(4*time.Second),
		),
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-runtime-absent-no-run", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(4 * time.Second),
		},
		Now: now.Add(4 * time.Second),
	})
	if err != nil {
		t.Fatalf("fail disable without blocked Run: %v", err)
	}
	if failed.Agent.AggregateSequence != started.Agent.AggregateSequence+1 {
		t.Fatalf("failure sequence = %d", failed.Agent.AggregateSequence)
	}
	var releaseCount int
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*) FROM agent_controller.agent_events
WHERE operation_request_id = $1 AND event_type = 'run_admission_released'`, requestID,
	).Scan(&releaseCount); err != nil || releaseCount != 0 {
		t.Fatalf("synthetic release event count = %d err=%v", releaseCount, err)
	}
}

func prepareDisableRuntimeFailure(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	base ports.AgentLifecycleBase,
	requestID string,
	fingerprint string,
	now time.Time,
	withBlockedRun bool,
) (ports.AgentDisableState, string, context.Context) {
	t.Helper()
	_, _, err := repository.BeginAgentDisable(
		ctx, disableBegin(base, requestID, fingerprint, now),
	)
	if err != nil {
		t.Fatalf("begin Agent disable: %v", err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	admissionID := ""
	if withBlockedRun {
		admissionID = "admission-" + requestID
		if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, terminal_report, finished_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked_unknown_effect', $8, $9,
          jsonb_build_object(
              'runtime', jsonb_build_object('runtime_revision', $9::text),
              'execution_spec', jsonb_build_object('skill_instructions', '[]'::jsonb)
          ),
          '{"terminal_class":"unresolved","tool_effect_state":"unknown","unknown_effect_source":"runtime_mcp","stop_reason":"","error_class":"tool_outcome_unknown"}'::jsonb,
          $10, $10, $10)`,
			admissionID, "run-"+requestID, strings.Repeat("d", 64), base.Agent.AgentID,
			"session-"+requestID, base.Agent.OwnerUserID, base.Agent.AccessRevision,
			now.Add(time.Hour), base.Agent.RuntimeRevision, now,
		); err != nil {
			t.Fatalf("insert blocked Run admission: %v", err)
		}
	}
	if _, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	); err != nil {
		t.Fatalf("settle Agent disable drain: %v", err)
	}
	state, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
		NetworkAttachment:  closedNetworkAttachment(base.Agent.AgentID),
		Now:                now.Add(3 * time.Second),
	})
	if err != nil {
		t.Fatalf("advance Agent disable to Runtime: %v", err)
	}
	return state, admissionID, ctx
}

func disableBegin(
	base ports.AgentLifecycleBase, requestID string, fingerprint string, now time.Time,
) ports.BeginAgentDisable {
	return ports.BeginAgentDisable{
		AgentID:                     base.Agent.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ExecutableSpec.ID,
		ExpectedExecutionRevisionID: base.ExecutableExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID, Kind: domain.OperationDisable,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.ExecutableSpec.ID,
			SourceExecutionRevisionID: base.ExecutableExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			ChildRequestID:            domain.ChildRequestID(requestID, domain.PhaseDrain),
			Attempt:                   1, CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-disable-requested-" + requestID,
			AgentID: base.Agent.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDisableRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now,
		},
		Now: now,
	}
}

func closedNetworkAttachment(agentID string) *ports.NetworkAttachment {
	return &ports.NetworkAttachment{
		AgentID: agentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateActive, NetworkResourceVersion: 1,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2,
	}
}
