package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLegacyProofLossRecoveryAdmissionIsDurableAndExclusive(t *testing.T) {
	url := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, base.Agent.AgentID, base.Agent.OrganizationID); err != nil {
		t.Fatal(err)
	}
	failedID := "legacy-proof-loss-source"
	target := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222",
		LifecycleState: "provisioned", Health: "unknown"}
	targetJSON, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := insertLifecycleOperation(ctx, transaction, ports.LifecycleOperationRecord{RequestID: failedID,
		RequestFingerprint: strings.Repeat("a", 64), AgentID: base.Agent.AgentID, Kind: domain.OperationRebuild,
		Phase: domain.PhasePublish, State: domain.OperationFailed,
		SourceSpecRevisionID: base.ConfiguredSpec.ID, SourceRuntimeRevision: base.Agent.RuntimeRevision,
		TargetSpecRevisionID: base.ConfiguredSpec.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_lifecycle_operations SET runtime_result=$2,error_code='legacy_migration_proof_lost' WHERE request_id=$1`, failedID, targetJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agents SET runtime_state='unknown',runtime_reason='lifecycle_invariant_failed',
		executable_execution_revision_id='',runtime_execution_id='',runtime_mcp_endpoint='',failure_stage='publish',failure_code='legacy_migration_proof_lost'
		WHERE id=$1`, base.Agent.AgentID); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	input := ports.BeginLegacyProofLossRecovery{RequestID: "legacy-proof-loss-recovery", Fingerprint: strings.Repeat("b", 64),
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		FailedMigrationRequestID: failedID, TargetRuntimeRevision: target.RuntimeRevision,
		ObservedRuntimeExecutionID: "runtime-observed-process", ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ClosedAttachmentVersion: 2,
		ChildRequestID:          "legacy-proof-loss-recovery-child", Now: time.Now().UTC()}
	bad := input
	bad.TargetRuntimeRevision = "rtv_33333333333333333333333333333333"
	if _, _, err := repository.BeginLegacyProofLossRecovery(ctx, bad); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("wrong target admitted: %v", err)
	}
	first, replay, err := repository.BeginLegacyProofLossRecovery(ctx, input)
	if err != nil || replay || first.State != "running" || first.Phase != "disable_runtime" {
		t.Fatalf("begin recovery=%+v replay=%t err=%v", first, replay, err)
	}
	again, replay, err := repository.BeginLegacyProofLossRecovery(ctx, input)
	if err != nil || !replay || again != first {
		t.Fatalf("replay recovery=%+v replay=%t err=%v", again, replay, err)
	}
	// RC observations may change after admission. The request body and stored
	// snapshot, not a later observation, define exact replay.
	bad.ObservedRuntimeExecutionID = ""
	bad.ClosedAttachmentVersion = 0
	bad.Now = time.Time{}
	if observedAgain, replay, err := repository.BeginLegacyProofLossRecovery(ctx, bad); err != nil || !replay || observedAgain != first {
		t.Fatalf("observation drift changed replay=%+v replay=%t err=%v", observedAgain, replay, err)
	}
	changed := input
	changed.Fingerprint = strings.Repeat("c", 64)
	if _, _, err := repository.BeginLegacyProofLossRecovery(ctx, changed); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("changed request replay: %v", err)
	}
	competing := input
	competing.RequestID = "legacy-proof-loss-recovery-other"
	if _, _, err := repository.BeginLegacyProofLossRecovery(ctx, competing); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("competing recovery admitted: %v", err)
	}
	var active, failure string
	if err := repository.pool.QueryRow(ctx, `SELECT active_operation_request_id,failure_code FROM agent_controller.agents WHERE id=$1`, input.AgentID).Scan(&active, &failure); err != nil {
		t.Fatal(err)
	}
	if active != input.RequestID || failure != "legacy_migration_proof_lost" {
		t.Fatalf("recovery changed quarantine before Runtime effect: active=%q failure=%q", active, failure)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, input.AgentID); err != nil || !pending {
		t.Fatalf("recovery admission opened legacy gate: pending=%t err=%v", pending, err)
	}
	completed := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_44444444444444444444444444444444", LifecycleState: "disabled", Health: "absent"}
	if _, err := repository.PublishLegacyProofLossRecovery(ctx, input.RequestID, input.Fingerprint, input.ClosedAttachmentVersion, "legacy-recovery-event", "", input.Now.Add(time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("published before RC receipt: %v", err)
	}
	if _, err := repository.RecordLegacyProofLossRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, "wrong-child", completed, input.Now.Add(time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("accepted wrong RC child: %v", err)
	}
	incomplete := completed
	incomplete.State = "running"
	if _, err := repository.RecordLegacyProofLossRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, input.ChildRequestID, incomplete, input.Now.Add(time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("accepted incomplete RC receipt: %v", err)
	}
	recorded, err := repository.RecordLegacyProofLossRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, input.ChildRequestID, completed, input.Now.Add(time.Second))
	if err != nil || recorded.Phase != "publish" || recorded.DisabledRuntimeRevision != completed.RuntimeRevision {
		t.Fatalf("record RC receipt=%+v err=%v", recorded, err)
	}
	if _, err := repository.RecordLegacyProofLossRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, input.ChildRequestID, completed, input.Now.Add(2*time.Second)); err != nil {
		t.Fatalf("replay RC receipt: %v", err)
	}
	if _, err := repository.PublishLegacyProofLossRecovery(ctx, input.RequestID, input.Fingerprint, input.ClosedAttachmentVersion+1, "legacy-recovery-event", "", input.Now.Add(2*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("published with different closed attachment: %v", err)
	}
	finished, err := repository.PublishLegacyProofLossRecovery(ctx, input.RequestID, input.Fingerprint, input.ClosedAttachmentVersion, "legacy-recovery-event", "", input.Now.Add(2*time.Second))
	if err != nil || finished.State != "completed" || finished.Phase != "done" || finished.DisabledRuntimeRevision != completed.RuntimeRevision {
		t.Fatalf("publish recovery=%+v err=%v", finished, err)
	}
	if _, err := repository.PublishLegacyProofLossRecovery(ctx, input.RequestID, input.Fingerprint, input.ClosedAttachmentVersion, "legacy-recovery-event", "", input.Now.Add(3*time.Second)); err != nil {
		t.Fatalf("replay publication: %v", err)
	}
	var desired, activation, runtimeState, runtimeRevision, activeAfter, failureAfter string
	if err := repository.pool.QueryRow(ctx, `SELECT desired_state,activation_state,runtime_state,runtime_revision,active_operation_request_id,failure_code FROM agent_controller.agents WHERE id=$1`, input.AgentID).
		Scan(&desired, &activation, &runtimeState, &runtimeRevision, &activeAfter, &failureAfter); err != nil {
		t.Fatal(err)
	}
	if desired != "disabled" || activation != "disabled" || runtimeState != "absent" || runtimeRevision != completed.RuntimeRevision || activeAfter != "" || failureAfter != "" {
		t.Fatalf("invalid recovered Agent state: desired=%q activation=%q runtime=%q revision=%q active=%q failure=%q", desired, activation, runtimeState, runtimeRevision, activeAfter, failureAfter)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, input.AgentID); err != nil || !pending {
		t.Fatalf("recovery publication opened legacy gate: pending=%t err=%v", pending, err)
	}
	var events int
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events WHERE operation_request_id=$1 AND event_type='agent_legacy_proof_loss_recovered'`, input.RequestID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("recovery audit events=%d err=%v", events, err)
	}
}

func TestLegacyProofLossManualOutcomeRemainsQuarantinedAndReplays(t *testing.T) {
	url := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, base.Agent.AgentID, base.Agent.OrganizationID); err != nil {
		t.Fatal(err)
	}
	target := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222", LifecycleState: "provisioned", Health: "unknown"}
	payload, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertLifecycleOperation(ctx, tx, ports.LifecycleOperationRecord{RequestID: "manual-source", RequestFingerprint: strings.Repeat("a", 64), AgentID: base.Agent.AgentID,
		Kind: domain.OperationRebuild, Phase: domain.PhasePublish, State: domain.OperationFailed, SourceSpecRevisionID: base.ConfiguredSpec.ID,
		SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: base.ConfiguredSpec.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.agent_lifecycle_operations SET runtime_result=$2,error_code='legacy_migration_proof_lost' WHERE request_id=$1`, "manual-source", payload); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET runtime_state='unknown',runtime_reason='lifecycle_invariant_failed',executable_execution_revision_id='',runtime_execution_id='',runtime_mcp_endpoint='',failure_stage='publish',failure_code='legacy_migration_proof_lost' WHERE id=$1`, base.Agent.AgentID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	input := ports.BeginLegacyProofLossRecovery{RequestID: "manual-recovery", Fingerprint: strings.Repeat("b", 64), AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID,
		ActorPrincipalID: "admin-1", FailedMigrationRequestID: "manual-source", TargetRuntimeRevision: target.RuntimeRevision, ObservedRuntimeExecutionID: "process-1",
		ClosedAttachmentVersion: 2, ExpectedAggregateSequence: base.Agent.AggregateSequence, ChildRequestID: "manual-child", Now: time.Now().UTC()}
	if _, _, err := repository.BeginLegacyProofLossRecovery(ctx, input); err != nil {
		t.Fatal(err)
	}
	manual, err := repository.MarkLegacyProofLossManualRecovery(ctx, input.RequestID, input.Fingerprint, "disable_runtime", "runtime_disable_rejected", input.Now.Add(time.Second))
	if err != nil || manual.State != "manual_recovery_required" || manual.ErrorCode != "legacy_migration_manual_recovery_required" || manual.ManualReason != "runtime_disable_rejected" {
		t.Fatalf("manual=%+v err=%v", manual, err)
	}
	if replay, replayed, err := repository.BeginLegacyProofLossRecovery(ctx, input); err != nil || !replayed || replay != manual {
		t.Fatalf("manual replay=%+v replayed=%t err=%v", replay, replayed, err)
	}
	if _, err := repository.MarkLegacyProofLossManualRecovery(ctx, input.RequestID, input.Fingerprint, "disable_runtime", "runtime_disable_rejected", input.Now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.MarkLegacyProofLossManualRecovery(ctx, input.RequestID, input.Fingerprint, "disable_runtime", "publication_conflict", input.Now.Add(2*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("changed manual reason: %v", err)
	}
	completed := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_33333333333333333333333333333333", LifecycleState: "disabled", Health: "absent"}
	if _, err := repository.RecordLegacyProofLossRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, input.ChildRequestID, completed, input.Now.Add(2*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("manual recovery resumed RC phase: %v", err)
	}
	if _, err := repository.PublishLegacyProofLossRecovery(ctx, input.RequestID, input.Fingerprint, input.ClosedAttachmentVersion, "manual-event", "", input.Now.Add(2*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("manual recovery published: %v", err)
	}
	var active, failure string
	if err := repository.pool.QueryRow(ctx, `SELECT active_operation_request_id,failure_code FROM agent_controller.agents WHERE id=$1`, input.AgentID).Scan(&active, &failure); err != nil {
		t.Fatal(err)
	}
	if active != input.RequestID || failure != "legacy_migration_proof_lost" {
		t.Fatalf("manual outcome released quarantine: active=%q failure=%q", active, failure)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, input.AgentID); err != nil || !pending {
		t.Fatalf("manual outcome opened marker: pending=%t err=%v", pending, err)
	}
}
