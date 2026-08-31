package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type catalogQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type catalogRowScanner interface {
	Scan(...any) error
}

type catalogRequest struct {
	kind        ports.CatalogRequestKind
	resourceID  string
	revisionID  string
	revision    int64
	fingerprint string
}

func lockCatalogRequest(ctx context.Context, transaction pgx.Tx, requestID string) error {
	if _, err := transaction.Exec(
		ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", catalogRequestLockNamespace, requestID,
	); err != nil {
		return fmt.Errorf("lock Catalog request: %w", err)
	}
	return nil
}

func loadCatalogRequest(
	ctx context.Context,
	queryer catalogQueryer,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
) (catalogRequest, bool, error) {
	var request catalogRequest
	err := queryer.QueryRow(ctx, `
SELECT request_kind, request_fingerprint, resource_id, revision_id, revision
FROM agent_controller.catalog_requests
WHERE request_id = $1`, requestID).Scan(
		&request.kind, &request.fingerprint, &request.resourceID, &request.revisionID, &request.revision,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return catalogRequest{}, false, nil
	}
	if err != nil {
		return catalogRequest{}, false, fmt.Errorf("query Catalog request: %w", err)
	}
	if request.kind != kind || request.fingerprint != fingerprint {
		return catalogRequest{}, false, ports.ErrRequestConflict
	}
	return request, true, nil
}

func loadModelProfileRequest(
	ctx context.Context,
	queryer catalogQueryer,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
) (ports.ModelProfileRecord, bool, error) {
	request, found, err := loadCatalogRequest(ctx, queryer, kind, requestID, fingerprint)
	if err != nil || !found {
		return ports.ModelProfileRecord{}, found, err
	}
	record, err := loadModelProfileRecord(
		ctx, queryer, request.resourceID, request.revisionID, request.revision,
	)
	return record, true, err
}

func loadModelProfileRecord(
	ctx context.Context,
	queryer catalogQueryer,
	profileID string,
	revisionID string,
	revisionNumber int64,
) (ports.ModelProfileRecord, error) {
	row := queryer.QueryRow(ctx, `
SELECT p.id, p.organization_id, p.profile_key, p.display_name,
       p.enabled, p.created_at, p.updated_at,
       r.id, r.revision, r.model, r.credential_ref, r.credential_version
FROM agent_controller.model_profiles p
JOIN agent_controller.model_profile_revisions r
  ON r.model_profile_id = p.id
 AND r.organization_id = p.organization_id
 AND r.id = $2
 AND r.revision = $3
JOIN agent_controller.provider_credentials c
  ON c.credential_ref = r.credential_ref
 AND c.organization_id = r.organization_id
 AND c.credential_version = r.credential_version
WHERE p.id = $1`, profileID, revisionID, revisionNumber)
	return scanModelProfileRecord(row)
}

func scanModelProfileRecord(scanner catalogRowScanner) (ports.ModelProfileRecord, error) {
	var record ports.ModelProfileRecord
	var snapshot domain.ModelProfileRevisionSnapshot
	var modelPayload []byte
	if err := scanner.Scan(
		&record.ModelProfileID, &record.OrganizationID, &record.ProfileKey, &record.DisplayName,
		&record.Enabled, &record.CreatedAt, &record.UpdatedAt,
		&snapshot.ID, &snapshot.Revision, &modelPayload,
		&snapshot.CredentialRef, &snapshot.CredentialVersion,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.ModelProfileRecord{}, ports.ErrNotFound
		}
		return ports.ModelProfileRecord{}, fmt.Errorf("scan ModelProfile: %w", err)
	}
	if err := json.Unmarshal(modelPayload, &snapshot.Model); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("decode ModelProfile model: %w", err)
	}
	snapshot.ModelProfileID = record.ModelProfileID
	snapshot.OrganizationID = record.OrganizationID
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("restore ModelProfile revision: %w", err)
	}
	record.Revision = revision
	record.CredentialRef = snapshot.CredentialRef
	record.CredentialVersion = snapshot.CredentialVersion
	return record, nil
}

func insertProviderCredential(
	ctx context.Context, transaction pgx.Tx, record ports.ModelProfileRecord,
) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.provider_credentials (
    credential_ref, organization_id, credential_version, secret_type,
    ciphertext, nonce, key_version, created_at
) VALUES ($1, $2, $3, 'bearer', $4, $5, $6, $7)`,
		record.CredentialRef, record.OrganizationID, record.CredentialVersion,
		record.SealedCredential.Ciphertext, record.SealedCredential.Nonce,
		record.SealedCredential.KeyVersion, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert Provider credential: %w", err)
	}
	return nil
}

func insertModelProfileRevision(
	ctx context.Context, transaction pgx.Tx, record ports.ModelProfileRecord,
) error {
	modelPayload, err := json.Marshal(record.Revision.Snapshot().Model)
	if err != nil {
		return fmt.Errorf("encode ModelProfile model: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profile_revisions (
    id, model_profile_id, organization_id, revision, model,
    credential_ref, credential_version, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		record.Revision.ID(), record.ModelProfileID, record.OrganizationID,
		record.Revision.Revision(), modelPayload, record.CredentialRef,
		record.CredentialVersion, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert ModelProfile revision: %w", err)
	}
	return nil
}

func insertModelProfile(ctx context.Context, transaction pgx.Tx, record ports.ModelProfileRecord) error {
	if err := insertProviderCredential(ctx, transaction, record); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profiles (
    id, organization_id, profile_key, display_name, current_revision_id,
    current_revision, enabled, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		record.ModelProfileID, record.OrganizationID, record.ProfileKey,
		record.DisplayName, record.Revision.ID(), record.Revision.Revision(),
		record.Enabled, record.CreatedAt, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert ModelProfile: %w", err)
	}
	return insertModelProfileRevision(ctx, transaction, record)
}

func reviseModelProfile(
	ctx context.Context,
	transaction pgx.Tx,
	expectedRevision int64,
	record ports.ModelProfileRecord,
) error {
	if err := lockModelProfileHead(ctx, transaction, expectedRevision, record); err != nil {
		return err
	}
	if err := insertProviderCredential(ctx, transaction, record); err != nil {
		return err
	}
	if err := insertModelProfileRevision(ctx, transaction, record); err != nil {
		return err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.model_profiles
SET display_name = $2,
    current_revision_id = $3,
    current_revision = $4,
    updated_at = $5
WHERE id = $1
  AND organization_id = $6
  AND current_revision = $7`,
		record.ModelProfileID, record.DisplayName, record.Revision.ID(),
		record.Revision.Revision(), record.UpdatedAt, record.OrganizationID, expectedRevision,
	)
	if err != nil {
		return fmt.Errorf("advance ModelProfile head: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func lockModelProfileHead(
	ctx context.Context,
	transaction pgx.Tx,
	expectedRevision int64,
	record ports.ModelProfileRecord,
) error {
	var currentRevision int64
	err := transaction.QueryRow(ctx, `
SELECT current_revision
FROM agent_controller.model_profiles
WHERE id = $1 AND organization_id = $2
FOR UPDATE`, record.ModelProfileID, record.OrganizationID).Scan(&currentRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock ModelProfile head: %w", err)
	}
	if currentRevision != expectedRevision || record.Revision.Revision() != expectedRevision+1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func loadTemplateRequest(
	ctx context.Context,
	queryer catalogQueryer,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
) (ports.TemplateRecord, bool, error) {
	request, found, err := loadCatalogRequest(ctx, queryer, kind, requestID, fingerprint)
	if err != nil || !found {
		return ports.TemplateRecord{}, found, err
	}
	record, err := loadTemplateRecord(ctx, queryer, request.resourceID, request.revision)
	return record, true, err
}

func loadTemplateRecord(
	ctx context.Context, queryer catalogQueryer, templateID string, revisionNumber int64,
) (ports.TemplateRecord, error) {
	row := queryer.QueryRow(ctx, `
SELECT t.id, t.organization_id, t.template_key, t.name,
       t.enabled, t.created_at, t.updated_at,
       r.revision, r.model_profile_revision_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input
FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r
  ON r.template_id = t.id
 AND r.organization_id = t.organization_id
 AND r.revision = $2
WHERE t.id = $1`, templateID, revisionNumber)
	return scanTemplateRecord(row)
}

func scanTemplateRecord(scanner catalogRowScanner) (ports.TemplateRecord, error) {
	var record ports.TemplateRecord
	var snapshot domain.TemplateRevisionSnapshot
	var runtimePayload []byte
	if err := scanner.Scan(
		&record.TemplateID, &record.OrganizationID, &record.TemplateKey, &record.Name,
		&record.Enabled, &record.CreatedAt, &record.UpdatedAt,
		&snapshot.Revision, &snapshot.ModelProfileRevisionID, &snapshot.SystemPrompt,
		&snapshot.MaxModelRequests, &snapshot.ContextPolicyVersion, &runtimePayload,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.TemplateRecord{}, ports.ErrNotFound
		}
		return ports.TemplateRecord{}, fmt.Errorf("scan Template: %w", err)
	}
	if err := json.Unmarshal(runtimePayload, &snapshot.Runtime); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("decode Template Runtime input: %w", err)
	}
	snapshot.TemplateID = record.TemplateID
	snapshot.OrganizationID = record.OrganizationID
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("restore Template revision: %w", err)
	}
	record.Revision = revision
	return record, nil
}

func insertTemplateRevision(
	ctx context.Context, transaction pgx.Tx, record ports.TemplateRecord,
) error {
	snapshot := record.Revision.Snapshot()
	runtimePayload, err := json.Marshal(snapshot.Runtime)
	if err != nil {
		return fmt.Errorf("encode Template Runtime input: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_template_revisions (
    template_id, organization_id, revision, model_profile_revision_id,
    system_prompt, max_model_requests, context_policy_version, runtime_input, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		record.TemplateID, record.OrganizationID, snapshot.Revision,
		snapshot.ModelProfileRevisionID, snapshot.SystemPrompt, snapshot.MaxModelRequests,
		snapshot.ContextPolicyVersion, runtimePayload, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert Template revision: %w", err)
	}
	return nil
}

func insertTemplate(ctx context.Context, transaction pgx.Tx, record ports.TemplateRecord) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_templates (
    id, organization_id, template_key, name, current_revision,
    enabled, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		record.TemplateID, record.OrganizationID, record.TemplateKey, record.Name,
		record.Revision.Revision(), record.Enabled, record.CreatedAt, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert Template: %w", err)
	}
	return insertTemplateRevision(ctx, transaction, record)
}

func reviseTemplate(
	ctx context.Context,
	transaction pgx.Tx,
	expectedRevision int64,
	record ports.TemplateRecord,
) error {
	if err := lockTemplateHead(ctx, transaction, expectedRevision, record); err != nil {
		return err
	}
	if err := insertTemplateRevision(ctx, transaction, record); err != nil {
		return err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_templates
SET name = $2,
    current_revision = $3,
    updated_at = $4
WHERE id = $1
  AND organization_id = $5
  AND current_revision = $6`,
		record.TemplateID, record.Name, record.Revision.Revision(),
		record.UpdatedAt, record.OrganizationID, expectedRevision,
	)
	if err != nil {
		return fmt.Errorf("advance Template head: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func lockTemplateHead(
	ctx context.Context,
	transaction pgx.Tx,
	expectedRevision int64,
	record ports.TemplateRecord,
) error {
	var currentRevision int64
	err := transaction.QueryRow(ctx, `
SELECT current_revision
FROM agent_controller.agent_templates
WHERE id = $1 AND organization_id = $2
FOR UPDATE`, record.TemplateID, record.OrganizationID).Scan(&currentRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock Template head: %w", err)
	}
	if currentRevision != expectedRevision || record.Revision.Revision() != expectedRevision+1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func insertCatalogRequest(
	ctx context.Context,
	transaction pgx.Tx,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
	resourceID string,
	revisionID string,
	revision int64,
	createdAt time.Time,
) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.catalog_requests (
    request_id, request_kind, request_fingerprint, resource_id,
    revision_id, revision, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		requestID, kind, fingerprint, resourceID, revisionID, revision, createdAt,
	); err != nil {
		return fmt.Errorf("insert Catalog request ledger: %w", err)
	}
	return nil
}
