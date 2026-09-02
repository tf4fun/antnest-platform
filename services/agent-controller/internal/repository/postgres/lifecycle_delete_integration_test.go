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

func TestValidDeleteBeginBindsRuntimeEvidenceToAgentProjection(t *testing.T) {
	t.Parallel()

	now := time.Unix(790, 0).UTC()
	agent := deleteAgentBaseRecord()
	valid := deleteBegin(agent, "request-delete-valid", strings.Repeat("a", 64), now)
	if !validDeleteBegin(agent, valid) {
		t.Fatal("matching Runtime revision was rejected")
	}

	wrongRevision := valid
	wrongRevision.Operation.SourceRuntimeRevision = "rtv_wrong_revision"
	if validDeleteBegin(agent, wrongRevision) {
		t.Fatal("delete accepted a Runtime revision not owned by the Agent projection")
	}

	agent.RuntimeRevision = ""
	agent.RuntimeExecutionID = ""
	agent.RuntimeMCPEndpoint = ""
	absent := deleteBegin(agent, "request-delete-absent", strings.Repeat("b", 64), now)
	absent.Operation.SourceRuntimeRevision = ""
	absent.Operation.SourceRuntimeAbsent = true
	if validDeleteBegin(agent, absent) {
		t.Fatal("delete accepted an unstructured Runtime absence claim")
	}
	absent.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{
		Reason: "runtime_not_found", ObservedAt: now,
	}
	if !validDeleteBegin(agent, absent) {
		t.Fatal("authoritative Runtime absence proof was rejected")
	}

	orphan := deleteBegin(agent, "request-delete-orphan", strings.Repeat("c", 64), now)
	orphan.Operation.SourceRuntimeRevision = "rtv_orphan"
	orphan.Operation.SourceRuntimeInspection = &ports.RuntimeInspection{
		AgentID: agent.AgentID, RuntimeRevision: "rtv_orphan",
		LifecycleState: "ready", Health: "healthy",
	}
	if !validDeleteBegin(agent, orphan) {
		t.Fatal("matching inspected orphan Runtime was rejected")
	}
	orphan.Operation.SourceRuntimeInspection.AgentID = "another-agent"
	if validDeleteBegin(agent, orphan) {
		t.Fatal("delete accepted another Agent's inspected Runtime")
	}
}

func TestValidDeleteAdvanceRequiresExplicitNetworkReleaseOutcome(t *testing.T) {
	t.Parallel()

	operation := ports.LifecycleOperationRecord{
		RequestID: "request-delete-release", AgentID: "agent-delete",
		Kind: domain.OperationDelete, Phase: domain.PhaseNetworkRelease,
		State: domain.OperationRunning,
	}
	input := ports.AdvanceAgentDelete{
		RequestID: operation.RequestID, ExpectedPhase: domain.PhaseNetworkRelease,
		NextPhase:          domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(operation.RequestID, domain.PhasePublish),
	}
	if validDeleteAdvance(operation, input) {
		t.Fatal("delete accepted a missing network release result")
	}
	input.NetworkReleaseOutcome = ports.NetworkReleaseAuthoritativeNone
	if !validDeleteAdvance(operation, input) {
		t.Fatal("authoritative missing network result was rejected")
	}
}

func TestLifecycleRepositoryPersistsDeleteBarrierAndRetainsAuditFacts(t *testing.T) {
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
	requestID := "request-delete-integration"
	fingerprint := strings.Repeat("d", 64)
	begin := deleteBegin(base.Agent, requestID, fingerprint, now)
	started, replayed, err := repository.BeginAgentDelete(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent delete: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	if started.Agent.DesiredState != domain.DesiredDeleted ||
		started.Agent.LifecycleState != domain.AgentDeleting ||
		started.Agent.ActiveOperationRequestID != requestID {
		t.Fatalf("started delete = %+v", started)
	}

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
		"admission-delete-integration", "request-run-delete-integration",
		strings.Repeat("e", 64), base.Agent.AgentID, "session-delete-integration",
		base.Agent.OwnerUserID, base.Agent.AccessRevision, now.Add(time.Hour),
		base.Agent.RuntimeRevision, now,
	); err != nil {
		t.Fatalf("insert unresolved Run admission: %v", err)
	}

	state, err := repository.SettleAgentDeleteDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	)
	if err != nil || state.Operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle delete drain: state=%+v err=%v", state, err)
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDelete,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDelete),
		Now:                now.Add(2 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhaseRuntimeDelete {
		t.Fatalf("record delete fence: state=%+v err=%v", state, err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_99999999999999999999999999999999",
		LifecycleState:  "deleted", Health: "absent",
	}
	runtimeAdvance := ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeDelete, NextPhase: domain.PhaseNetworkRelease,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease),
		RuntimeResult:      &runtime,
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-run-release-delete-integration", "runtime_deleted",
			base.Agent.RuntimeRevision, now.Add(4*time.Second),
		),
		Now: now.Add(4 * time.Second),
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET terminal_report = '{"unknown_effect_source":"runtime_mcp"}'::jsonb
WHERE admission_id = $1`, "admission-delete-integration"); err != nil {
		t.Fatalf("set malformed unresolved terminal report: %v", err)
	}
	if _, err := repository.AdvanceAgentDelete(ctx, runtimeAdvance); err == nil {
		t.Fatal("Runtime deletion released a malformed unresolved terminal report")
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET terminal_report = '{"terminal_class":"unresolved","tool_effect_state":"unknown","unknown_effect_source":"runtime_mcp","stop_reason":"","error_class":"tool_outcome_unknown"}'::jsonb
WHERE admission_id = $1`, "admission-delete-integration"); err != nil {
		t.Fatalf("restore unresolved terminal report: %v", err)
	}
	state, err = repository.AdvanceAgentDelete(ctx, runtimeAdvance)
	if err != nil || state.Operation.Phase != domain.PhaseNetworkRelease {
		t.Fatalf("record Runtime deletion: state=%+v err=%v", state, err)
	}
	var admissionState, releasedBy string
	if err := repository.pool.QueryRow(ctx, `
SELECT state, released_by_operation_request_id
FROM agent_controller.run_admissions WHERE admission_id = $1`,
		"admission-delete-integration",
	).Scan(&admissionState, &releasedBy); err != nil {
		t.Fatalf("load released Run admission: %v", err)
	}
	if admissionState != "released" || releasedBy != requestID {
		t.Fatalf("released Run state=%q operation=%q", admissionState, releasedBy)
	}
	assertLifecycleRunRelease(
		t, ctx, repository, "event-run-release-delete-integration", base.Agent.AgentID,
		"admission-delete-integration", requestID,
		begin.RequestedEvent.AggregateSequence+1,
	)

	attachment := ports.NetworkAttachment{
		AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateQuarantined, NetworkResourceVersion: 2,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2,
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkRelease, NextPhase: domain.PhasePublish,
		NextChildRequestID:    domain.ChildRequestID(requestID, domain.PhasePublish),
		NetworkAttachment:     &attachment,
		NetworkReleaseOutcome: ports.NetworkReleaseQuarantined,
		Now:                   now.Add(5 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhasePublish ||
		state.Operation.NetworkReleaseOutcome != ports.NetworkReleaseQuarantined {
		t.Fatalf("record network release: state=%+v err=%v", state, err)
	}
	published, err := repository.PublishAgentDelete(ctx, ports.PublishAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		DeletedEvent: ports.AgentEventRecord{
			EventID: "event-deleted-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDeleted,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(6 * time.Second),
		},
		Now: now.Add(6 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish Agent delete: %v", err)
	}
	if published.Agent.DesiredState != domain.DesiredDeleted ||
		published.Agent.LifecycleState != domain.AgentDeleted ||
		published.Agent.AgentSpecRevisionID != "" || published.Agent.ExecutionRevisionID != "" ||
		published.Agent.RuntimeRevision != "" || published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published delete = %+v", published)
	}
	assertDeletedAgentRetention(
		t, ctx, repository, base.Agent.AgentID, base.Agent.LastSuccessfulExecutionRevisionID,
	)
	replayedState, found, err := repository.ReplayAgentDelete(ctx, requestID, fingerprint)
	if err != nil || !found || replayedState.Operation.State != domain.OperationCompleted {
		t.Fatalf("replay Agent delete: state=%+v found=%t err=%v", replayedState, found, err)
	}
}

func TestLifecycleRepositoryAuthoritativeAbsenceBarrierReleasesUnresolvedRun(t *testing.T) {
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
	now := time.Unix(850, 0).UTC()

	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agents
SET lifecycle_state = 'unavailable', runtime_revision = '',
    runtime_execution_id = '', runtime_mcp_endpoint = '', updated_at = $2
WHERE id = $1`, base.Agent.AgentID, now); err != nil {
		t.Fatalf("project authoritatively absent Runtime: %v", err)
	}
	base.Agent.LifecycleState = domain.AgentUnavailable
	base.Agent.RuntimeRevision = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""

	requestID := "request-delete-absent-runtime-integration"
	fingerprint := strings.Repeat("f", 64)
	begin := deleteBegin(base.Agent, requestID, fingerprint, now)
	begin.Operation.SourceRuntimeAbsent = true
	begin.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{
		Reason: "runtime_not_found", ObservedAt: now,
	}
	started, replayed, err := repository.BeginAgentDelete(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin absent Runtime delete: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)

	const admissionID = "admission-delete-absent-runtime-integration"
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
		admissionID, "request-run-delete-absent-runtime-integration",
		strings.Repeat("1", 64), base.Agent.AgentID, "session-delete-absent-runtime-integration",
		base.Agent.OwnerUserID, base.Agent.AccessRevision, now.Add(time.Hour),
		"rtv_orphaned_runtime", now,
	); err != nil {
		t.Fatalf("insert unresolved Run for absent Runtime: %v", err)
	}

	state, err := repository.SettleAgentDeleteDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	)
	if err != nil || state.Operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle absent Runtime delete drain: state=%+v err=%v", state, err)
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseNetworkRelease,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease),
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-run-release-delete-absent-runtime-integration",
			"runtime_absent", "", now.Add(2*time.Second),
		),
		Now: now.Add(2 * time.Second),
	})
	const eventID = "event-run-release-delete-absent-runtime-integration"
	if err != nil || state.Operation.Phase != domain.PhaseNetworkRelease {
		t.Fatalf("cross absent Runtime barrier: state=%+v err=%v", state, err)
	}
	assertLifecycleRunRelease(
		t, ctx, repository, eventID, base.Agent.AgentID, admissionID, requestID,
		begin.RequestedEvent.AggregateSequence+1,
	)
}

func TestRuntimeAbsenceRetainsClientMCPUnknownEffect(t *testing.T) {
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
	now := time.Unix(860, 0).UTC()
	requestID := "request-delete-client-effect-integration"
	fingerprint := strings.Repeat("e", 64)
	begin := deleteBegin(base.Agent, requestID, fingerprint, now)
	if _, _, err := repository.BeginAgentDelete(ctx, begin); err != nil {
		t.Fatalf("begin delete: %v", err)
	}
	ctx = claimLifecycleForTest(t, ctx, repository, requestID)
	const admissionID = "admission-client-effect-integration"
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
          '{"terminal_class":"unresolved","tool_effect_state":"unknown","unknown_effect_source":"client_mcp","stop_reason":"","error_class":"tool_outcome_unknown"}'::jsonb,
          $10, $10, $10)`,
		admissionID, "request-run-client-effect-integration", strings.Repeat("2", 64),
		base.Agent.AgentID, "session-client-effect-integration", base.Agent.OwnerUserID,
		base.Agent.AccessRevision, now.Add(time.Hour), base.Agent.RuntimeRevision, now,
	); err != nil {
		t.Fatalf("insert client MCP unresolved admission: %v", err)
	}

	state, err := repository.SettleAgentDeleteDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	)
	if err != nil || state.Operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle delete drain: state=%+v err=%v", state, err)
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDelete,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDelete),
		Now:                now.Add(2 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhaseRuntimeDelete {
		t.Fatalf("record delete fence: state=%+v err=%v", state, err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
		LifecycleState: "deleted", Health: "absent",
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeDelete, NextPhase: domain.PhaseNetworkRelease,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease),
		RuntimeResult:      &runtime,
		RunReleaseEvent: lifecycleRunReleaseEvent(
			"event-client-effect-release", "runtime_deleted", base.Agent.RuntimeRevision,
			now.Add(4*time.Second),
		),
		Now: now.Add(4 * time.Second),
	})
	if err != nil || state.RunReleaseOutcome != ports.RunReleaseOutcomeRetained {
		t.Fatalf("client MCP delete barrier: state=%+v err=%v", state, err)
	}
	var admissionState string
	var events int
	if err := repository.pool.QueryRow(ctx, `
SELECT state,
       (SELECT count(*) FROM agent_controller.agent_events WHERE event_id = 'event-client-effect-release')
FROM agent_controller.run_admissions WHERE admission_id = $1`, admissionID).Scan(&admissionState, &events); err != nil {
		t.Fatalf("read retained admission: %v", err)
	}
	if admissionState != "blocked_unknown_effect" || events != 0 {
		t.Fatalf("retained admission state=%q release events=%d", admissionState, events)
	}
}

func deleteBegin(
	agent ports.AgentRecord, requestID string, fingerprint string, now time.Time,
) ports.BeginAgentDelete {
	return ports.BeginAgentDelete{
		AgentID: agent.AgentID, ExpectedAggregateSequence: agent.AggregateSequence,
		ExpectedDesiredState: agent.DesiredState, ExpectedLifecycleState: agent.LifecycleState,
		ExpectedRuntimeRevision: agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: fingerprint,
			AgentID: agent.AgentID, Kind: domain.OperationDelete,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceRuntimeRevision: agent.RuntimeRevision,
			ChildRequestID:        domain.ChildRequestID(requestID, domain.PhaseDrain),
			Attempt:               1, CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-delete-requested-" + requestID,
			AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleteRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now,
		},
		Now: now,
	}
}

func deleteAgentBaseRecord() ports.AgentRecord {
	now := time.Unix(780, 0).UTC()
	return ports.AgentRecord{
		AgentID: "agent-delete-proof", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Delete Proof Agent", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentAvailable, AccessRevision: "access-delete-proof",
		AgentSpecRevisionID: "spec-delete-proof", ExecutionRevisionID: "execution-delete-proof",
		LastSuccessfulExecutionRevisionID: "execution-delete-proof",
		RuntimeRevision:                   "rtv_delete_proof", RuntimeExecutionID: "runtime-delete-proof",
		RuntimeMCPEndpoint: "http://runtime-delete-proof:8091/mcp",
		AggregateSequence:  3, CreatedAt: now, UpdatedAt: now,
	}
}

func assertDeletedAgentRetention(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	wantLastSuccessfulExecution string,
) {
	t.Helper()
	var accessActive bool
	if err := repository.pool.QueryRow(ctx, `
SELECT active FROM agent_controller.agent_access_bindings WHERE agent_id = $1`,
		agentID,
	).Scan(&accessActive); err != nil {
		t.Fatalf("load deleted Agent access: %v", err)
	}
	if accessActive {
		t.Fatal("deleted Agent owner access remains active")
	}
	var lastSuccessfulExecution string
	if err := repository.pool.QueryRow(ctx, `
SELECT last_successful_execution_revision_id
FROM agent_controller.agents WHERE id = $1`, agentID).Scan(&lastSuccessfulExecution); err != nil {
		t.Fatalf("load deleted Agent audit pointer: %v", err)
	}
	if lastSuccessfulExecution != wantLastSuccessfulExecution {
		t.Fatalf("deleted Agent last successful execution = %q", lastSuccessfulExecution)
	}
	var specs, executions, events int
	if err := repository.pool.QueryRow(ctx, `
SELECT
  (SELECT COUNT(*) FROM agent_controller.agent_spec_revisions WHERE agent_id = $1),
  (SELECT COUNT(*) FROM agent_controller.execution_revisions WHERE agent_id = $1),
  (SELECT COUNT(*) FROM agent_controller.agent_events WHERE agent_id = $1)`,
		agentID,
	).Scan(&specs, &executions, &events); err != nil {
		t.Fatalf("load retained audit facts: %v", err)
	}
	if specs != 1 || executions != 1 || events != 5 {
		t.Fatalf("retained facts specs=%d executions=%d events=%d", specs, executions, events)
	}
}
