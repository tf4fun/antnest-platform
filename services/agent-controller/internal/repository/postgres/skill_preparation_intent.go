package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ReserveSkillPreparation(ctx context.Context, input ports.SkillPreparationIntent) (ports.SkillPreparationIntent, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin Skill preparation intent: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.RequestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	existing, err := loadSkillPreparationIntent(ctx, transaction, input.RequestID)
	if err == nil {
		if existing.RequestFingerprint != input.RequestFingerprint || existing.Kind != input.Kind || existing.AgentID != input.AgentID || existing.OrganizationID != input.OrganizationID {
			return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
		}
		return existing, nil
	}
	if !errors.Is(err, ports.ErrNotFound) {
		return ports.SkillPreparationIntent{}, err
	}
	if input.Kind != domain.OperationCreate {
		if input.Kind != domain.OperationRebuild && input.Kind != domain.OperationEnable {
			return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
		}
		if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
			return ports.SkillPreparationIntent{}, err
		}
		agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
		if err != nil {
			return ports.SkillPreparationIntent{}, err
		}
		expectedExecution := agent.ExecutionRevisionID
		if input.Kind == domain.OperationEnable {
			if expectedExecution != "" {
				return ports.SkillPreparationIntent{}, ports.ErrConcurrentChange
			}
			expectedExecution = agent.LastSuccessfulExecutionRevisionID
		} else if expectedExecution == "" {
			// Runtime loss clears the live execution binding, but Rebuild still
			// uses the last successful revision as its recovery source.
			expectedExecution = agent.LastSuccessfulExecutionRevisionID
		}
		if (input.Kind == domain.OperationEnable && agent.DesiredState != domain.DesiredDisabled) ||
			(input.Kind == domain.OperationRebuild && agent.DesiredState != domain.DesiredEnabled) {
			return ports.SkillPreparationIntent{}, ports.ErrConcurrentChange
		}
		if agent.OrganizationID != input.OrganizationID || agent.ActiveOperationRequestID != "" ||
			agent.AggregateSequence != input.ExpectedAggregateSequence ||
			agent.AgentSpecRevisionID != input.ExpectedSpecRevisionID ||
			expectedExecution != input.ExpectedExecutionRevisionID ||
			agent.RuntimeRevision != input.ExpectedRuntimeRevision {
			return ports.SkillPreparationIntent{}, ports.ErrConcurrentChange
		}
	}
	payload, err := json.Marshal(input.TargetSpec)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("encode Skill preparation target: %w", err)
	}
	input.State = "preparing"
	input.PreparationAttempt = 0
	input.PreparedReferenceID = ""
	input.CreatedAt = input.CreatedAt.UTC().Truncate(time.Microsecond)
	input.UpdatedAt = input.UpdatedAt.UTC().Truncate(time.Microsecond)
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_skill_preparation_intents (
 request_id, request_fingerprint, kind, agent_id, organization_id, target_spec, target_spec_digest,
 expected_aggregate_sequence, expected_spec_revision_id, expected_execution_revision_id,
 expected_runtime_revision, state, prepared_reference_id, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		input.RequestID, input.RequestFingerprint, input.Kind, input.AgentID, input.OrganizationID,
		payload, input.TargetSpecDigest, input.ExpectedAggregateSequence, input.ExpectedSpecRevisionID,
		input.ExpectedExecutionRevisionID, input.ExpectedRuntimeRevision, input.State, input.PreparedReferenceID,
		input.CreatedAt, input.UpdatedAt)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return ports.SkillPreparationIntent{}, ports.ErrConcurrentChange
		}
		return ports.SkillPreparationIntent{}, fmt.Errorf("insert Skill preparation intent: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit Skill preparation intent: %w", err)
	}
	return input, nil
}

func (repository *Repository) GetSkillPreparationIntent(ctx context.Context, requestID string) (ports.SkillPreparationIntent, error) {
	return loadSkillPreparationIntent(ctx, repository.pool, requestID)
}

func (repository *Repository) MarkSkillPreparationReady(ctx context.Context, requestID, fingerprint, referenceID string, at time.Time) (ports.SkillPreparationIntent, error) {
	if referenceID == "" {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin Skill preparation ready: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, requestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, requestID)
	if err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	if intent.RequestFingerprint != fingerprint || (intent.State != "preparing" && (intent.State != "ready" || intent.PreparedReferenceID != referenceID)) {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	if intent.State == "ready" {
		return intent, nil
	}
	at = at.UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_skill_preparation_intents SET state='ready', prepared_reference_id=$2, updated_at=$3 WHERE request_id=$1`, requestID, referenceID, at); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("mark Skill preparation ready: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit Skill preparation ready: %w", err)
	}
	intent.State, intent.PreparedReferenceID, intent.UpdatedAt = "ready", referenceID, at
	return intent, nil
}

func (repository *Repository) MarkSkillPreparationReleased(ctx context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin Skill preparation release: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, requestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, requestID)
	if err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	if intent.RequestFingerprint != fingerprint || (intent.State != "ready" && intent.State != "released") {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	if intent.State == "released" {
		return intent, nil
	}
	at = at.UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_skill_preparation_intents SET state='released', updated_at=$2 WHERE request_id=$1`, requestID, at); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("mark Skill preparation released: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit Skill preparation release: %w", err)
	}
	intent.State, intent.UpdatedAt = "released", at
	return intent, nil
}

func (repository *Repository) MarkSkillPreparationAbandoned(ctx context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin Skill preparation abandonment: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, requestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, requestID)
	if err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	if intent.RequestFingerprint != fingerprint || (intent.State != "preparing" && intent.State != "abandoned") {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	if intent.State == "abandoned" {
		return intent, nil
	}
	at = at.UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_skill_preparation_intents SET state='abandoned', updated_at=$2 WHERE request_id=$1`, requestID, at); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("mark Skill preparation abandoned: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit Skill preparation abandonment: %w", err)
	}
	intent.State, intent.UpdatedAt = "abandoned", at
	return intent, nil
}

func (repository *Repository) MarkSkillPreparationInvalidated(ctx context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin Skill preparation invalidation: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, requestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, requestID)
	if err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	if intent.RequestFingerprint != fingerprint || (intent.State != "preparing" && intent.State != "ready" && intent.State != "invalidated") {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	if intent.State == "invalidated" {
		return intent, nil
	}
	at = at.UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_skill_preparation_intents SET state='invalidated',updated_at=$2 WHERE request_id=$1`, requestID, at); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("mark Skill preparation invalidated: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit Skill preparation invalidation: %w", err)
	}
	intent.State, intent.UpdatedAt = "invalidated", at
	return intent, nil
}

func (repository *Repository) AdvanceSkillPreparationAttempt(ctx context.Context, requestID, fingerprint string, expected uint32, at time.Time) (ports.SkillPreparationIntent, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("begin next Skill preparation attempt: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, requestID); err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, requestID)
	if err != nil {
		return ports.SkillPreparationIntent{}, err
	}
	if intent.RequestFingerprint != fingerprint || intent.State != "invalidated" || intent.PreparationAttempt != expected {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	at = at.UTC().Truncate(time.Microsecond)
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agent_skill_preparation_intents SET state='preparing',preparation_attempt=preparation_attempt+1,prepared_reference_id='',updated_at=$2 WHERE request_id=$1`, requestID, at); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("advance Skill preparation attempt: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("commit next Skill preparation attempt: %w", err)
	}
	intent.State, intent.PreparedReferenceID, intent.PreparationAttempt, intent.UpdatedAt = "preparing", "", expected+1, at
	return intent, nil
}

type skillIntentQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadSkillPreparationIntent(ctx context.Context, querier skillIntentQuerier, requestID string) (ports.SkillPreparationIntent, error) {
	var intent ports.SkillPreparationIntent
	var snapshot []byte
	err := querier.QueryRow(ctx, `SELECT request_id, request_fingerprint, kind, agent_id, organization_id,
 target_spec, target_spec_digest, expected_aggregate_sequence, expected_spec_revision_id,
 expected_execution_revision_id, expected_runtime_revision, state, preparation_attempt, prepared_reference_id,
 created_at, updated_at FROM agent_controller.agent_skill_preparation_intents WHERE request_id=$1`, requestID).Scan(
		&intent.RequestID, &intent.RequestFingerprint, &intent.Kind, &intent.AgentID, &intent.OrganizationID,
		&snapshot, &intent.TargetSpecDigest, &intent.ExpectedAggregateSequence, &intent.ExpectedSpecRevisionID,
		&intent.ExpectedExecutionRevisionID, &intent.ExpectedRuntimeRevision, &intent.State, &intent.PreparationAttempt,
		&intent.PreparedReferenceID, &intent.CreatedAt, &intent.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.SkillPreparationIntent{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("load Skill preparation intent: %w", err)
	}
	if err := json.Unmarshal(snapshot, &intent.TargetSpec); err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("decode Skill preparation target: %w", err)
	}
	return intent, nil
}
