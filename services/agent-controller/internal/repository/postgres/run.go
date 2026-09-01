package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const runRequestLockNamespace int32 = 0x52554e41

var runFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (repository *Repository) ResolveAgentAccess(
	ctx context.Context, accessSubject string,
) (ports.AgentAccessResolution, error) {
	var result ports.AgentAccessResolution
	err := repository.pool.QueryRow(ctx, `
SELECT principal_id, agent_id, access_revision, prompt_image, prompt_embedded_context
FROM agent_controller.agent_access_bindings
WHERE access_subject = $1 AND active`, accessSubject).Scan(
		&result.PrincipalID, &result.AgentID, &result.AccessRevision,
		&result.PromptCapabilities.Image, &result.PromptCapabilities.EmbeddedContext,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AgentAccessResolution{}, ports.ErrRunAccessDenied
	}
	if err != nil {
		return ports.AgentAccessResolution{}, fmt.Errorf("resolve Agent access binding: %w", err)
	}
	return result, nil
}

func (repository *Repository) AcquireRun(
	ctx context.Context, input ports.AcquireRunRecord,
) (ports.RunAdmissionRecord, bool, error) {
	if !validAcquireRunRecord(input) {
		return ports.RunAdmissionRecord{}, false, fmt.Errorf("invalid Run admission command")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.RunAdmissionRecord{}, false, fmt.Errorf("begin Run admission transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockRunRequest(ctx, transaction, input.RequestID); err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	existing, err := loadRunAdmissionByRequest(ctx, transaction, input.RequestID, "")
	switch {
	case err == nil:
		if existing.RequestFingerprint != input.RequestFingerprint {
			return ports.RunAdmissionRecord{}, false, ports.ErrRequestConflict
		}
		return existing, true, nil
	case !errors.Is(err, ports.ErrAdmissionNotFound):
		return ports.RunAdmissionRecord{}, false, err
	}

	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.RunAdmissionRecord{}, false, ports.ErrNotFound
	}
	if err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	if err := validateAgentForRun(agent); err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	if err := validateRunAccess(ctx, transaction, agent, input); err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	if occupied, err := agentRunOccupied(ctx, transaction, input.AgentID); err != nil {
		return ports.RunAdmissionRecord{}, false, err
	} else if occupied {
		return ports.RunAdmissionRecord{}, false, ports.ErrAgentBusy
	}
	snapshot, err := loadRunExecutionSnapshot(ctx, transaction, agent)
	if err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	if err := ports.ValidateRunExecutionSnapshot(snapshot); err != nil {
		return ports.RunAdmissionRecord{}, false, fmt.Errorf("validate Run execution snapshot: %w", err)
	}
	record := ports.RunAdmissionRecord{
		AdmissionID: input.AdmissionID, RequestID: input.RequestID,
		RequestFingerprint: input.RequestFingerprint, AgentID: input.AgentID,
		SessionID: input.SessionID, PrincipalID: input.PrincipalID,
		AccessRevision: input.ExpectedAccessRevision, State: domain.AdmissionActive,
		Deadline: input.Deadline, RuntimeRevision: snapshot.Runtime.RuntimeRevision,
		Snapshot: snapshot, CreatedAt: input.Now, UpdatedAt: input.Now,
	}
	if err := insertRunAdmission(ctx, transaction, record); err != nil {
		return ports.RunAdmissionRecord{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.RunAdmissionRecord{}, false, fmt.Errorf("commit Run admission: %w", err)
	}
	return record, false, nil
}

func (repository *Repository) FinishRun(
	ctx context.Context, input ports.FinishRunCommand,
) (ports.FinishRunRecord, error) {
	resultingState, err := domain.ValidateTerminalReport(input.Report)
	if err != nil || strings.TrimSpace(input.RequestID) == "" ||
		strings.TrimSpace(input.AdmissionID) == "" ||
		!validFinishRunEvent(input.Event, resultingState) || input.Now.IsZero() {
		return ports.FinishRunRecord{}, fmt.Errorf("invalid FinishRun command")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.FinishRunRecord{}, fmt.Errorf("begin FinishRun transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var agent ports.AgentRecord
	if resultingState == domain.AdmissionBlockedUnknownEffect {
		var agentID string
		err = transaction.QueryRow(ctx, `
SELECT agent_id FROM agent_controller.run_admissions WHERE admission_id = $1`,
			input.AdmissionID,
		).Scan(&agentID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.FinishRunRecord{}, ports.ErrAdmissionNotFound
		}
		if err != nil {
			return ports.FinishRunRecord{}, fmt.Errorf("load FinishRun Agent identity: %w", err)
		}
		agent, err = loadAgentRecordForUpdate(ctx, transaction, agentID)
		if err != nil {
			return ports.FinishRunRecord{}, err
		}
	}
	admission, err := loadRunAdmissionByID(ctx, transaction, input.AdmissionID, "FOR UPDATE")
	if err != nil {
		return ports.FinishRunRecord{}, err
	}
	if admission.TerminalReport != nil {
		if err := domain.ValidateTerminalReplay(
			admission.State, admission.TerminalReport, input.Report,
		); err != nil {
			return ports.FinishRunRecord{}, ports.ErrRequestConflict
		}
		return ports.FinishRunRecord{
			Status: "already_finished", AdmissionState: admission.State,
		}, nil
	}
	if admission.State != domain.AdmissionActive {
		return ports.FinishRunRecord{}, ports.ErrRequestConflict
	}
	terminalPayload, err := json.Marshal(input.Report)
	if err != nil {
		return ports.FinishRunRecord{}, fmt.Errorf("encode Run terminal report: %w", err)
	}
	releasedAt := any(nil)
	if resultingState == domain.AdmissionReleased {
		releasedAt = input.Now
	}
	updated, err := transaction.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET state = $2, terminal_report = $3, finished_at = $4,
    released_at = $5, updated_at = $4
WHERE admission_id = $1 AND state = 'active' AND terminal_report IS NULL`,
		input.AdmissionID, resultingState, terminalPayload, input.Now, releasedAt,
	)
	if err != nil {
		return ports.FinishRunRecord{}, fmt.Errorf("seal Run terminal report: %w", err)
	}
	if updated.RowsAffected() != 1 {
		return ports.FinishRunRecord{}, ports.ErrConcurrentChange
	}
	if input.Event != nil {
		nextSequence := agent.AggregateSequence + 1
		projected, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET aggregate_sequence = $2, updated_at = $3
WHERE id = $1 AND aggregate_sequence = $4`,
			agent.AgentID, nextSequence, input.Now, agent.AggregateSequence,
		)
		if err != nil {
			return ports.FinishRunRecord{}, fmt.Errorf("advance Agent Run event sequence: %w", err)
		}
		if projected.RowsAffected() != 1 {
			return ports.FinishRunRecord{}, ports.ErrConcurrentChange
		}
		if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
			EventID: input.Event.EventID, AgentID: agent.AgentID,
			AggregateSequence: nextSequence, SchemaVersion: 1, EventType: input.Event.EventType,
			AdmissionID: input.AdmissionID, TraceID: input.Event.TraceID,
			Data: input.Event.Data, OccurredAt: input.Event.OccurredAt,
		}); err != nil {
			return ports.FinishRunRecord{}, mapRunConstraintError(err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.FinishRunRecord{}, fmt.Errorf("commit FinishRun: %w", err)
	}
	if input.Event != nil {
		repository.recordEventAppend(ctx, input.Event.EventType)
	}
	return ports.FinishRunRecord{Status: "finished", AdmissionState: resultingState}, nil
}

func (repository *Repository) GetAdmissionCredential(
	ctx context.Context, admissionID string, credentialRef string, now time.Time,
) (ports.AdmissionCredential, error) {
	if now.IsZero() {
		return ports.AdmissionCredential{}, fmt.Errorf("credential resolution time is required")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AdmissionCredential{}, fmt.Errorf("begin admission credential transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	admission, err := loadRunAdmissionByID(ctx, transaction, admissionID, "FOR UPDATE")
	if err != nil {
		return ports.AdmissionCredential{}, err
	}
	if admission.State != domain.AdmissionActive || !admission.Deadline.After(now) ||
		admission.Snapshot.ExecutionSpec.CredentialRef != credentialRef {
		return ports.AdmissionCredential{}, ports.ErrCredentialNotAllowed
	}
	var record ports.AdmissionCredential
	err = transaction.QueryRow(ctx, `
SELECT c.organization_id, c.credential_ref, c.credential_version, c.secret_type,
       c.ciphertext, c.nonce, c.key_version
FROM agent_controller.agents a
JOIN agent_controller.provider_credentials c ON c.organization_id = a.organization_id
WHERE a.id = $1 AND c.credential_ref = $2 AND c.credential_version = $3`,
		admission.AgentID, credentialRef, admission.Snapshot.CredentialVersion,
	).Scan(
		&record.Identity.OrganizationID, &record.Identity.CredentialRef,
		&record.Identity.CredentialVersion, &record.SecretType,
		&record.Sealed.Ciphertext, &record.Sealed.Nonce, &record.Sealed.KeyVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AdmissionCredential{}, ports.ErrCredentialNotAllowed
	}
	if err != nil {
		return ports.AdmissionCredential{}, fmt.Errorf("load admission Provider credential: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AdmissionCredential{}, fmt.Errorf("commit admission credential read: %w", err)
	}
	return record, nil
}

func lockRunRequest(ctx context.Context, transaction pgx.Tx, requestID string) error {
	if _, err := transaction.Exec(
		ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", runRequestLockNamespace, requestID,
	); err != nil {
		return fmt.Errorf("lock Run request: %w", err)
	}
	return nil
}

func validateAgentForRun(agent ports.AgentRecord) error {
	if agent.ActiveOperationRequestID != "" {
		return ports.ErrAgentRebuilding
	}
	if agent.LifecycleState == domain.AgentUnavailable && agent.FailureCode != "" {
		return ports.ErrAgentBuildFailed
	}
	if agent.DesiredState != domain.DesiredEnabled || agent.LifecycleState != domain.AgentAvailable {
		return ports.ErrAgentNotReady
	}
	if agent.AgentSpecRevisionID == "" || agent.ExecutionRevisionID == "" ||
		agent.RuntimeRevision == "" || agent.RuntimeExecutionID == "" || agent.RuntimeMCPEndpoint == "" {
		return ports.ErrAgentBuildFailed
	}
	return nil
}

func validateRunAccess(
	ctx context.Context, transaction pgx.Tx, agent ports.AgentRecord, input ports.AcquireRunRecord,
) error {
	var active bool
	err := transaction.QueryRow(ctx, `
SELECT active FROM agent_controller.agent_access_bindings
WHERE agent_id = $1 AND principal_id = $2 AND access_revision = $3
ORDER BY access_subject LIMIT 1 FOR UPDATE`,
		input.AgentID, input.PrincipalID, input.ExpectedAccessRevision,
	).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!active || agent.AccessRevision != input.ExpectedAccessRevision)) {
		return ports.ErrRunAccessDenied
	}
	if err != nil {
		return fmt.Errorf("validate Run access binding: %w", err)
	}
	return nil
}

func agentRunOccupied(ctx context.Context, transaction pgx.Tx, agentID string) (bool, error) {
	var admissionID string
	err := transaction.QueryRow(ctx, `
SELECT admission_id FROM agent_controller.run_admissions
WHERE agent_id = $1 AND state IN ('active', 'blocked_unknown_effect')
ORDER BY admission_id LIMIT 1 FOR UPDATE`, agentID).Scan(&admissionID)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	default:
		return false, fmt.Errorf("inspect Agent Run occupancy: %w", err)
	}
}

func loadRunExecutionSnapshot(
	ctx context.Context, queryer catalogQueryer, agent ports.AgentRecord,
) (ports.RunExecutionSnapshot, error) {
	spec, err := loadAgentSpec(ctx, queryer, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.RunExecutionSnapshot{}, err
	}
	execution, err := loadExecutionRevision(ctx, queryer, agent.ExecutionRevisionID)
	if err != nil {
		return ports.RunExecutionSnapshot{}, err
	}
	if spec.AgentID != agent.AgentID || execution.AgentID != agent.AgentID ||
		execution.AgentSpecRevisionID != spec.ID || execution.RuntimeRevision != agent.RuntimeRevision ||
		execution.RuntimeExecutionID != agent.RuntimeExecutionID ||
		execution.RuntimeMCPEndpoint != agent.RuntimeMCPEndpoint {
		return ports.RunExecutionSnapshot{}, fmt.Errorf("agent executable projection is inconsistent")
	}
	snapshot := spec.Snapshot
	return ports.RunExecutionSnapshot{
		AgentSpecRevisionID: spec.ID, ExecutionRevisionID: execution.ID,
		RuntimeMCPSourceDigest:   execution.RuntimeMCPSourceDigest,
		AgentExecutionSpecDigest: spec.CanonicalDigest,
		CredentialVersion:        snapshot.CredentialVersion,
		Runtime: ports.AdmittedRuntime{
			RuntimeRevision:    execution.RuntimeRevision,
			RuntimeExecutionID: execution.RuntimeExecutionID,
			MCPEndpoint:        execution.RuntimeMCPEndpoint,
		},
		ExecutionSpec: ports.AdmittedExecutionSpec{
			SystemPrompt: snapshot.SystemPrompt, ContextPolicyVersion: snapshot.ContextPolicyVersion,
			SkillInstructions: make([]ports.SkillInstruction, 0), Model: snapshot.Model,
			MaxModelRequests: snapshot.MaxModelRequests, CredentialRef: snapshot.CredentialRef,
		},
	}, nil
}

func insertRunAdmission(
	ctx context.Context, transaction pgx.Tx, record ports.RunAdmissionRecord,
) error {
	snapshot, err := json.Marshal(record.Snapshot)
	if err != nil {
		return fmt.Errorf("encode Run execution snapshot: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		record.AdmissionID, record.RequestID, record.RequestFingerprint, record.AgentID,
		record.SessionID, record.PrincipalID, record.AccessRevision, record.State,
		record.Deadline, record.RuntimeRevision, snapshot, record.CreatedAt, record.UpdatedAt,
	)
	if err != nil {
		return mapRunConstraintError(err)
	}
	return nil
}

func loadRunAdmissionByRequest(
	ctx context.Context, queryer catalogQueryer, requestID string, lockClause string,
) (ports.RunAdmissionRecord, error) {
	return loadRunAdmission(ctx, queryer, "request_id", requestID, lockClause)
}

func loadRunAdmissionByID(
	ctx context.Context, queryer catalogQueryer, admissionID string, lockClause string,
) (ports.RunAdmissionRecord, error) {
	return loadRunAdmission(ctx, queryer, "admission_id", admissionID, lockClause)
}

func loadRunAdmission(
	ctx context.Context, queryer catalogQueryer, column string, identity string, lockClause string,
) (ports.RunAdmissionRecord, error) {
	if column != "request_id" && column != "admission_id" {
		return ports.RunAdmissionRecord{}, fmt.Errorf("invalid Run admission identity column")
	}
	query := `
SELECT admission_id, request_id, request_fingerprint, agent_id, session_id,
       principal_id, access_revision, state, deadline, runtime_revision,
       snapshot, terminal_report, finished_at, released_by_operation_request_id,
       released_at, created_at, updated_at
FROM agent_controller.run_admissions WHERE ` + column + ` = $1`
	if lockClause == "FOR UPDATE" {
		query += " FOR UPDATE"
	}
	var record ports.RunAdmissionRecord
	var snapshotPayload, reportPayload []byte
	err := queryer.QueryRow(ctx, query, identity).Scan(
		&record.AdmissionID, &record.RequestID, &record.RequestFingerprint,
		&record.AgentID, &record.SessionID, &record.PrincipalID, &record.AccessRevision,
		&record.State, &record.Deadline, &record.RuntimeRevision, &snapshotPayload,
		&reportPayload, &record.FinishedAt, &record.ReleasedByOperationRequestID,
		&record.ReleasedAt, &record.CreatedAt, &record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.RunAdmissionRecord{}, ports.ErrAdmissionNotFound
	}
	if err != nil {
		return ports.RunAdmissionRecord{}, fmt.Errorf("load Run admission: %w", err)
	}
	if err := json.Unmarshal(snapshotPayload, &record.Snapshot); err != nil {
		return ports.RunAdmissionRecord{}, fmt.Errorf("decode Run execution snapshot: %w", err)
	}
	if record.RuntimeRevision != record.Snapshot.Runtime.RuntimeRevision {
		return ports.RunAdmissionRecord{}, fmt.Errorf("run admission Runtime revision is inconsistent")
	}
	if len(reportPayload) != 0 {
		var report domain.TerminalReport
		if err := json.Unmarshal(reportPayload, &report); err != nil {
			return ports.RunAdmissionRecord{}, fmt.Errorf("decode Run terminal report: %w", err)
		}
		record.TerminalReport = &report
	}
	return record, nil
}

func validAcquireRunRecord(input ports.AcquireRunRecord) bool {
	return strings.TrimSpace(input.RequestID) != "" && runFingerprintPattern.MatchString(input.RequestFingerprint) &&
		strings.TrimSpace(input.AdmissionID) != "" && strings.TrimSpace(input.AgentID) != "" &&
		strings.TrimSpace(input.PrincipalID) != "" && strings.TrimSpace(input.ExpectedAccessRevision) != "" &&
		strings.TrimSpace(input.SessionID) != "" && !input.Now.IsZero() && input.Deadline.After(input.Now)
}

func validFinishRunEvent(event *ports.RunAdmissionEvent, state domain.AdmissionState) bool {
	if state == domain.AdmissionReleased {
		return event == nil
	}
	return event != nil && event.EventID != "" &&
		event.EventType == ports.EventRunAdmissionUnresolved &&
		event.Data != nil && !event.OccurredAt.IsZero()
}

func validRunEvent(event ports.RunAdmissionEvent, state domain.AdmissionState) bool {
	want := ports.EventRunAdmissionReleased
	if state == domain.AdmissionBlockedUnknownEffect {
		want = ports.EventRunAdmissionUnresolved
	}
	return event.EventID != "" && event.EventType == want &&
		event.Data != nil && !event.OccurredAt.IsZero()
}

func mapRunConstraintError(err error) error {
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) {
		return err
	}
	switch databaseError.ConstraintName {
	case "admissions_agent_occupancy_unique":
		return ports.ErrAgentBusy
	case "run_admissions_request_id_key", "run_admissions_pkey", "agent_events_event_id_key":
		return ports.ErrRequestConflict
	default:
		return err
	}
}

var _ ports.RunStore = (*Repository)(nil)
