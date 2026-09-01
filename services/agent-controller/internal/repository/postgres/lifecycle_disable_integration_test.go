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
          jsonb_build_object('runtime', jsonb_build_object('runtime_revision', $9::text)), $10, $10)`,
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
    terminal_report = '{"terminal_class":"unresolved","tool_effect_state":"unknown","stop_reason":"","error_class":"tool_outcome_unknown"}'::jsonb,
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

	policy := ports.NetworkPolicyAssignment{
		AgentID: base.Agent.AgentID, PolicyID: "internet-enabled", Revision: 3, ResourceVersion: 7,
	}
	withPolicy, err := repository.RecordAgentDisablePolicy(
		ctx, requestID, fingerprint, policy, now.Add(3*time.Second),
	)
	if err != nil || withPolicy.Operation.NetworkPolicyAssignment == nil ||
		*withPolicy.Operation.NetworkPolicyAssignment != policy {
		t.Fatalf("record disable policy: state=%+v err=%v", withPolicy, err)
	}
	withFence, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
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
	failed, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		Stage: domain.PhaseDrain, Code: "run_drain_timeout", Detail: "Run did not settle",
		PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-failed-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: started.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisableFailed,
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
	if _, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	); err != nil {
		t.Fatalf("settle Agent disable drain: %v", err)
	}
	policy := ports.NetworkPolicyAssignment{
		AgentID: base.Agent.AgentID, PolicyID: "internet-enabled", Revision: 1, ResourceVersion: 7,
	}
	if _, err := repository.RecordAgentDisablePolicy(
		ctx, requestID, fingerprint, policy, now.Add(2*time.Second),
	); err != nil {
		t.Fatalf("record Agent disable policy: %v", err)
	}
	if _, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
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
		Stage: domain.PhaseRuntimeDisable, Code: "runtime_lifecycle_conflict",
		Detail: "source Runtime could not be proven", PreserveExecutable: false,
		SourceRuntimeInspection: &inspection,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-disable-unverified-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: started.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisableFailed,
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
