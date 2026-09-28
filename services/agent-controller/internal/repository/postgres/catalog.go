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
	createdAt   time.Time
	response    []byte
}

func lockCatalogRequest(ctx context.Context, transaction *databaseTransaction, requestID string) error {
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
SELECT request_kind, request_fingerprint, resource_id, revision_id, revision, created_at, response_snapshot
FROM agent_controller.catalog_requests
WHERE request_id = $1`, requestID).Scan(
		&request.kind, &request.fingerprint, &request.resourceID, &request.revisionID, &request.revision,
		&request.createdAt, &request.response,
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
	record, err := decodeModelReceipt(request.response)
	return record, true, err
}

func loadModelProfileRecord(
	ctx context.Context,
	queryer catalogQueryer,
	profileID string,
) (ports.ModelProfileRecord, error) {
	row := queryer.QueryRow(ctx, `SELECT `+modelProfileColumns+modelProfileFrom+` WHERE p.id=$1`, profileID)
	return scanModelProfileRecord(row)
}

const modelProfileColumns = `p.id, p.organization_id, p.profile_key, p.display_name,
 p.enabled, p.created_at, p.updated_at, p.configuration_id, p.version,
 p.model || jsonb_build_object('base_url', c.base_url), p.provider_connection_id`

const modelProfileFrom = ` FROM agent_controller.model_profiles p
 JOIN agent_controller.provider_connections c ON c.id=p.provider_connection_id AND c.organization_id=p.organization_id`

func scanModelProfileRecord(scanner catalogRowScanner) (ports.ModelProfileRecord, error) {
	var record ports.ModelProfileRecord
	var snapshot domain.ModelProfileRevisionSnapshot
	var modelPayload []byte
	if err := scanner.Scan(
		&record.ModelProfileID, &record.OrganizationID, &record.ProfileKey, &record.DisplayName,
		&record.Enabled, &record.CreatedAt, &record.UpdatedAt,
		&snapshot.ID, &snapshot.Revision, &modelPayload,
		&record.ProviderConnectionID,
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
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return record, nil
}

func insertModelProfile(ctx context.Context, transaction *databaseTransaction, record ports.ModelProfileRecord) error {
	if err := lockModelProvider(ctx, transaction, record); err != nil {
		return err
	}
	modelPayload, err := json.Marshal(record.Revision.Snapshot().Model.Parameters())
	if err != nil {
		return fmt.Errorf("encode ModelProfile model: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profiles (
    id, organization_id, profile_key, display_name, configuration_id,
    version, enabled, created_at, updated_at, provider_connection_id, api_model_id, model
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		record.ModelProfileID, record.OrganizationID, record.ProfileKey,
		record.DisplayName, record.Revision.ID(), record.Revision.Revision(),
		record.Enabled, record.CreatedAt, record.UpdatedAt, record.ProviderConnectionID, record.Revision.Snapshot().Model.Model, modelPayload,
	); err != nil {
		return fmt.Errorf("insert ModelProfile: %w", err)
	}
	return nil
}

func lockModelProvider(ctx context.Context, tx *databaseTransaction, record ports.ModelProfileRecord) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT enabled FROM agent_controller.provider_connections
WHERE id=$1 AND organization_id=$2 FOR SHARE`, record.ProviderConnectionID, record.OrganizationID).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock model Provider: %w", err)
	}
	if !enabled {
		return ports.ErrDisabledReference
	}
	return nil
}

func reviseModelProfile(
	ctx context.Context,
	transaction *databaseTransaction,
	expectedRevision int64,
	record *ports.ModelProfileRecord,
) (bool, error) {
	modelPayload, err := json.Marshal(record.Revision.Snapshot().Model.Parameters())
	if err != nil {
		return false, fmt.Errorf("encode ModelProfile model: %w", err)
	}
	changed, err := lockModelProfileHead(ctx, transaction, expectedRevision, record, modelPayload)
	if err != nil {
		return false, err
	}
	if err := lockModelProvider(ctx, transaction, *record); err != nil {
		return false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.model_profiles
SET display_name = $2,
    configuration_id = $3,
    version = $4,
    updated_at = $5,
    model = $8
WHERE id = $1
  AND organization_id = $6
  AND version = $7`,
		record.ModelProfileID, record.DisplayName, record.Revision.ID(),
		record.Revision.Revision(), record.UpdatedAt, record.OrganizationID, expectedRevision, modelPayload,
	)
	if err != nil {
		return false, fmt.Errorf("advance ModelProfile head: %w", err)
	}
	if result.RowsAffected() != 1 {
		return false, ports.ErrConcurrentChange
	}
	return changed, nil
}

func lockModelProfileHead(
	ctx context.Context,
	transaction *databaseTransaction,
	expectedRevision int64,
	record *ports.ModelProfileRecord,
	modelPayload []byte,
) (bool, error) {
	var currentRevision int64
	var changed bool
	err := transaction.QueryRow(ctx, `
SELECT version, display_name IS DISTINCT FROM $3 OR model IS DISTINCT FROM $4::jsonb, enabled
FROM agent_controller.model_profiles
WHERE id = $1 AND organization_id = $2
FOR UPDATE`, record.ModelProfileID, record.OrganizationID, record.DisplayName, modelPayload).Scan(&currentRevision, &changed, &record.Enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ports.ErrNotFound
	}
	if err != nil {
		return false, fmt.Errorf("lock ModelProfile head: %w", err)
	}
	if currentRevision != expectedRevision || record.Revision.Revision() != expectedRevision+1 {
		return false, ports.ErrConcurrentChange
	}
	return changed, nil
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
       r.revision, r.model_profile_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input, r.fallback_model_profile_ids, r.skill_refs
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
	var skillPayload []byte
	if err := scanner.Scan(
		&record.TemplateID, &record.OrganizationID, &record.TemplateKey, &record.Name,
		&record.Enabled, &record.CreatedAt, &record.UpdatedAt,
		&snapshot.Revision, &snapshot.ModelProfileID, &snapshot.SystemPrompt,
		&snapshot.MaxModelRequests, &snapshot.ContextPolicyVersion, &runtimePayload, &snapshot.FallbackModelProfileIDs, &skillPayload,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.TemplateRecord{}, ports.ErrNotFound
		}
		return ports.TemplateRecord{}, fmt.Errorf("scan Template: %w", err)
	}
	if err := json.Unmarshal(runtimePayload, &snapshot.Runtime); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("decode Template Runtime input: %w", err)
	}
	if err := json.Unmarshal(skillPayload, &snapshot.SkillRefs); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("decode Template Skill refs: %w", err)
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
	ctx context.Context, transaction *databaseTransaction, record ports.TemplateRecord,
) error {
	snapshot := record.Revision.Snapshot()
	runtimePayload, err := json.Marshal(snapshot.Runtime)
	if err != nil {
		return fmt.Errorf("encode Template Runtime input: %w", err)
	}
	skillPayload, err := json.Marshal(append([]domain.FrozenSkill{}, snapshot.SkillRefs...))
	if err != nil {
		return fmt.Errorf("encode Template Skill refs: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_template_revisions (
    template_id, organization_id, revision, model_profile_id,
    system_prompt, max_model_requests, context_policy_version, runtime_input, created_at, fallback_model_profile_ids, skill_refs
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		record.TemplateID, record.OrganizationID, snapshot.Revision,
		snapshot.ModelProfileID, snapshot.SystemPrompt, snapshot.MaxModelRequests,
		snapshot.ContextPolicyVersion, runtimePayload, record.UpdatedAt, append([]string{}, snapshot.FallbackModelProfileIDs...), skillPayload,
	); err != nil {
		return fmt.Errorf("insert Template revision: %w", err)
	}
	return nil
}

func insertTemplate(ctx context.Context, transaction *databaseTransaction, record ports.TemplateRecord) error {
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
	transaction *databaseTransaction,
	expectedRevision int64,
	record *ports.TemplateRecord,
) error {
	if err := lockTemplateHead(ctx, transaction, expectedRevision, record); err != nil {
		return err
	}
	if err := insertTemplateRevision(ctx, transaction, *record); err != nil {
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
	transaction *databaseTransaction,
	expectedRevision int64,
	record *ports.TemplateRecord,
) error {
	var currentRevision int64
	err := transaction.QueryRow(ctx, `
SELECT current_revision, enabled
FROM agent_controller.agent_templates
WHERE id = $1 AND organization_id = $2
FOR UPDATE`, record.TemplateID, record.OrganizationID).Scan(&currentRevision, &record.Enabled)
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
	transaction *databaseTransaction,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
	resourceID string,
	revisionID string,
	revision int64,
	createdAt time.Time,
	response []byte,
) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.catalog_requests (
    request_id, request_kind, request_fingerprint, resource_id,
    revision_id, revision, created_at, response_snapshot
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		requestID, kind, fingerprint, resourceID, revisionID, revision, createdAt, response,
	); err != nil {
		return fmt.Errorf("insert Catalog request ledger: %w", err)
	}
	return nil
}
