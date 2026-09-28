package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLegacySourceRecoveryAdmissionBindsObservedRuntimeAndKeepsMigrationGate(t *testing.T) {
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
	input := ports.BeginLegacySourceRecovery{RequestID: "legacy-source-recovery-1", Fingerprint: strings.Repeat("a", 64),
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		ExpectedAggregateSequence: base.Agent.AggregateSequence, SourceSpecRevisionID: base.ConfiguredSpec.ID,
		SourceRuntimeRevision: base.Agent.RuntimeRevision, ObservedRuntimeExecutionID: "observed-process-1",
		ObservedAttachmentVersion: 2, ChildRequestID: "legacy-source-disable-child",
		DrainDeadlineAt: time.Now().UTC().Add(5 * time.Minute), Now: time.Now().UTC()}
	if _, _, err := repository.BeginLegacySourceRecovery(ctx, input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("healthy source admitted to recovery: %v", err)
	}
	// An observed process exit clears the executable binding, but retains the
	// last successful revision as a proven source. A restarted container does
	// not turn that ordinary lifecycle case into legacy source recovery.
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents
		SET executable_execution_revision_id='',runtime_execution_id='',runtime_mcp_endpoint='',
		failure_code='runtime_exited',runtime_state='waiting' WHERE id=$1`, input.AgentID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repository.BeginLegacySourceRecovery(ctx, input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("proven last successful source admitted after process exit: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET executable_execution_revision_id='missing-execution'
		WHERE id=$1`, input.AgentID); err != nil {
		t.Fatal(err)
	}
	wrong := input
	wrong.SourceRuntimeRevision = "rtv_" + strings.Repeat("f", 32)
	if _, _, err := repository.BeginLegacySourceRecovery(ctx, wrong); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("wrong RC revision admitted: %v", err)
	}
	first, replay, err := repository.BeginLegacySourceRecovery(ctx, input)
	if err != nil || replay || first.State != "running" || first.Phase != "drain" || first.SourceRuntimeRevision != input.SourceRuntimeRevision {
		t.Fatalf("admit source recovery=%+v replay=%t err=%v", first, replay, err)
	}
	newRepository, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(newRepository.Close)
	repeated := input
	repeated.ObservedRuntimeExecutionID = ""
	repeated.ObservedAttachmentVersion = 0
	repeated.Now = time.Time{}
	again, replay, err := newRepository.BeginLegacySourceRecovery(ctx, repeated)
	if err != nil || !replay || again != first {
		t.Fatalf("durable replay=%+v replay=%t err=%v", again, replay, err)
	}
	changed := input
	changed.Fingerprint = strings.Repeat("b", 64)
	if _, _, err := newRepository.BeginLegacySourceRecovery(ctx, changed); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("changed request replay: %v", err)
	}
	competing := input
	competing.RequestID = "legacy-source-recovery-2"
	if _, _, err := newRepository.BeginLegacySourceRecovery(ctx, competing); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("competing recovery admitted: %v", err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, input.AgentID); err != nil || !pending {
		t.Fatalf("admission opened legacy gate: pending=%t err=%v", pending, err)
	}
	if _, err := repository.RecordLegacySourceFence(ctx, input.RequestID, input.Fingerprint, 3, input.Now.Add(time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("fenced before drain: %v", err)
	}
	drained, err := repository.CompleteLegacySourceDrain(ctx, input.RequestID, input.Fingerprint, input.Now.Add(time.Second))
	if err != nil || drained.Phase != "network_fence" {
		t.Fatalf("complete drain=%+v err=%v", drained, err)
	}
	fenced, err := repository.RecordLegacySourceFence(ctx, input.RequestID, input.Fingerprint, 3, input.Now.Add(2*time.Second))
	if err != nil || fenced.Phase != "disable_runtime" || fenced.ClosedAttachmentVersion != 3 {
		t.Fatalf("record fence=%+v err=%v", fenced, err)
	}
	disabled := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_" + strings.Repeat("d", 32),
		LifecycleState: "disabled", Health: "absent"}
	if _, err := repository.RecordLegacySourceRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, "wrong-child", disabled, input.Now.Add(3*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("accepted wrong RC child: %v", err)
	}
	recorded, err := repository.RecordLegacySourceRuntimeDisabled(ctx, input.RequestID, input.Fingerprint, input.ChildRequestID, disabled, input.Now.Add(3*time.Second))
	if err != nil || recorded.Phase != "publish" || recorded.DisabledRuntimeResult == nil || recorded.DisabledRuntimeRevision != disabled.RuntimeRevision {
		t.Fatalf("record disabled RC=%+v err=%v", recorded, err)
	}
	if _, err := repository.PublishLegacySourceRecovery(ctx, input.RequestID, input.Fingerprint, 4, "source-recovered-event", "", input.Now.Add(4*time.Second)); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("published with changed Egress version: %v", err)
	}
	completed, err := repository.PublishLegacySourceRecovery(ctx, input.RequestID, input.Fingerprint, 3, "source-recovered-event", "", input.Now.Add(4*time.Second))
	if err != nil || completed.State != "completed" || completed.Phase != "done" {
		t.Fatalf("publish source recovery=%+v err=%v", completed, err)
	}
	if _, err := repository.PublishLegacySourceRecovery(ctx, input.RequestID, input.Fingerprint, 3, "source-recovered-event", "", input.Now.Add(5*time.Second)); err != nil {
		t.Fatalf("publication replay: %v", err)
	}
	agent, err := repository.GetAgent(ctx, input.AgentID)
	if err != nil || agent.DesiredState != "disabled" || agent.ActivationState != "disabled" ||
		agent.RuntimeRevision != disabled.RuntimeRevision || agent.ExecutionRevisionID != "" ||
		agent.LastSuccessfulExecutionRevisionID != base.Agent.LastSuccessfulExecutionRevisionID || agent.ActiveOperationRequestID != "" {
		t.Fatalf("recovered Agent=%+v err=%v", agent, err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, input.AgentID); err != nil || !pending {
		t.Fatalf("publication opened legacy gate: pending=%t err=%v", pending, err)
	}
	var events int
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events WHERE operation_request_id=$1 AND event_type='agent_legacy_source_recovered'`, input.RequestID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("source recovery audit events=%d err=%v", events, err)
	}
}
