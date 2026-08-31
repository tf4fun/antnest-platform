package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func loadModelProfileRequest(
	ctx context.Context, transaction pgx.Tx, requestID string, fingerprint string,
) (ports.ModelProfileRecord, bool, error) {
	var storedFingerprint, resourceID, revisionID string
	var revision int64
	err := transaction.QueryRow(ctx, `
SELECT request_fingerprint, resource_id, revision_id, revision
FROM agent_controller.catalog_requests
WHERE request_id = $1 AND request_kind = 'create_model_profile'
FOR UPDATE`, requestID).Scan(&storedFingerprint, &resourceID, &revisionID, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ModelProfileRecord{}, false, nil
	}
	if err != nil {
		return ports.ModelProfileRecord{}, false, fmt.Errorf("query ModelProfile request: %w", err)
	}
	if storedFingerprint != fingerprint {
		return ports.ModelProfileRecord{}, false, ports.ErrRequestConflict
	}
	record, err := loadModelProfileRecord(ctx, transaction, resourceID, revisionID, revision)
	return record, true, err
}

func loadModelProfileRecord(
	ctx context.Context, transaction pgx.Tx, profileID string, revisionID string, revisionNumber int64,
) (ports.ModelProfileRecord, error) {
	var record ports.ModelProfileRecord
	var modelPayload []byte
	var model domain.ModelSpec
	err := transaction.QueryRow(ctx, `
SELECT p.organization_id, p.profile_key, p.display_name,
       r.model, r.credential_ref, r.credential_version,
       c.ciphertext, c.nonce, p.created_at
FROM agent_controller.model_profiles p
JOIN agent_controller.model_profile_revisions r ON r.id = $2
JOIN agent_controller.provider_credentials c ON c.credential_ref = r.credential_ref
WHERE p.id = $1`, profileID, revisionID).Scan(
		&record.OrganizationID, &record.ProfileKey, &record.DisplayName,
		&modelPayload, &record.CredentialRef, &record.CredentialVersion,
		&record.SealedCredential.Ciphertext, &record.SealedCredential.Nonce, &record.CreatedAt,
	)
	if err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("load replayed ModelProfile: %w", err)
	}
	if err := json.Unmarshal(modelPayload, &model); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("decode replayed ModelProfile: %w", err)
	}
	record.ModelProfileID = profileID
	var revisionErr error
	record.Revision, revisionErr = domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: revisionID, ModelProfileID: profileID, OrganizationID: record.OrganizationID,
		Revision: revisionNumber, Model: model, CredentialRef: record.CredentialRef,
		CredentialVersion: record.CredentialVersion,
	})
	return record, revisionErr
}

func insertModelProfile(ctx context.Context, transaction pgx.Tx, record ports.ModelProfileRecord) error {
	modelPayload, err := json.Marshal(record.Revision.Snapshot().Model)
	if err != nil {
		return fmt.Errorf("encode ModelProfile model: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.provider_credentials (
    credential_ref, organization_id, credential_version, secret_type,
    ciphertext, nonce, created_at
) VALUES ($1, $2, $3, 'bearer', $4, $5, $6)`,
		record.CredentialRef, record.OrganizationID, record.CredentialVersion,
		record.SealedCredential.Ciphertext, record.SealedCredential.Nonce, record.CreatedAt,
	); err != nil {
		return fmt.Errorf("insert Provider credential: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profiles (
    id, organization_id, profile_key, display_name, current_revision_id,
    current_revision, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
		record.ModelProfileID, record.OrganizationID, record.ProfileKey,
		record.DisplayName, record.Revision.ID(), record.CreatedAt,
	); err != nil {
		return fmt.Errorf("insert ModelProfile: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profile_revisions (
    id, model_profile_id, organization_id, revision, model,
    credential_ref, credential_version, created_at
) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
		record.Revision.ID(), record.ModelProfileID, record.OrganizationID,
		modelPayload, record.CredentialRef, record.CredentialVersion, record.CreatedAt,
	); err != nil {
		return fmt.Errorf("insert ModelProfile revision: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.catalog_requests (
    request_id, request_kind, request_fingerprint, resource_id,
    revision_id, revision, created_at
) VALUES ($1, 'create_model_profile', $2, $3, $4, 1, $5)`,
		record.RequestID, record.RequestFingerprint, record.ModelProfileID,
		record.Revision.ID(), record.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert ModelProfile request ledger: %w", err)
	}
	return nil
}

func loadTemplateRequest(
	ctx context.Context, transaction pgx.Tx, requestID string, fingerprint string,
) (ports.TemplateRecord, bool, error) {
	var storedFingerprint, resourceID string
	var revision int64
	err := transaction.QueryRow(ctx, `
SELECT request_fingerprint, resource_id, revision
FROM agent_controller.catalog_requests
WHERE request_id = $1 AND request_kind = 'create_template'
FOR UPDATE`, requestID).Scan(&storedFingerprint, &resourceID, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.TemplateRecord{}, false, nil
	}
	if err != nil {
		return ports.TemplateRecord{}, false, fmt.Errorf("query Template request: %w", err)
	}
	if storedFingerprint != fingerprint {
		return ports.TemplateRecord{}, false, ports.ErrRequestConflict
	}
	record, err := loadTemplateRecord(ctx, transaction, resourceID, revision)
	return record, true, err
}

func loadTemplateRecord(
	ctx context.Context, transaction pgx.Tx, templateID string, revisionNumber int64,
) (ports.TemplateRecord, error) {
	var record ports.TemplateRecord
	var snapshot domain.TemplateRevisionSnapshot
	var runtimePayload []byte
	err := transaction.QueryRow(ctx, `
SELECT t.organization_id, t.template_key, t.name, t.created_at,
       r.model_profile_revision_id, r.system_prompt, r.max_model_requests,
       r.context_policy_version, r.runtime_input
FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r
  ON r.template_id = t.id AND r.revision = $2
WHERE t.id = $1`, templateID, revisionNumber).Scan(
		&record.OrganizationID, &record.TemplateKey, &record.Name, &record.CreatedAt,
		&snapshot.ModelProfileRevisionID, &snapshot.SystemPrompt, &snapshot.MaxModelRequests,
		&snapshot.ContextPolicyVersion, &runtimePayload,
	)
	if err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("load replayed Template: %w", err)
	}
	if err := json.Unmarshal(runtimePayload, &snapshot.Runtime); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("decode replayed Template: %w", err)
	}
	snapshot.TemplateID = templateID
	snapshot.OrganizationID = record.OrganizationID
	snapshot.Revision = revisionNumber
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		return ports.TemplateRecord{}, err
	}
	record.TemplateID = templateID
	record.Revision = revision
	return record, nil
}

func insertTemplate(ctx context.Context, transaction pgx.Tx, record ports.TemplateRecord) error {
	snapshot := record.Revision.Snapshot()
	runtimePayload, err := json.Marshal(snapshot.Runtime)
	if err != nil {
		return fmt.Errorf("encode Template Runtime input: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_templates (
    id, organization_id, template_key, name, current_revision, created_at, updated_at
) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
		record.TemplateID, record.OrganizationID, record.TemplateKey, record.Name, record.CreatedAt,
	); err != nil {
		return fmt.Errorf("insert Template: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_template_revisions (
    template_id, organization_id, revision, model_profile_revision_id,
    system_prompt, max_model_requests, context_policy_version, runtime_input, created_at
) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)`,
		record.TemplateID, record.OrganizationID, snapshot.ModelProfileRevisionID,
		snapshot.SystemPrompt, snapshot.MaxModelRequests, snapshot.ContextPolicyVersion,
		runtimePayload, record.CreatedAt,
	); err != nil {
		return fmt.Errorf("insert Template revision: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.catalog_requests (
    request_id, request_kind, request_fingerprint, resource_id, revision, created_at
) VALUES ($1, 'create_template', $2, $3, 1, $4)`,
		record.RequestID, record.RequestFingerprint, record.TemplateID, record.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert Template request ledger: %w", err)
	}
	return nil
}
