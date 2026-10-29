package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var _ ports.ProviderObservationStore = (*Repository)(nil)

const providerObservationColumns = `connection_id, organization_id, source_revision, provider_key, request_protocol, base_url, credential_revision, models`

func whitelistObservedModels(models []ports.DiscoveredModel) ([]byte, error) {
	observed := make([]domain.ProviderObservedModel, 0, len(models))
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		// Only all-whitespace/oversized IDs are rejected; the stored id is the
		// provider's exact API string so " model" and "model" stay distinct.
		id := model.ModelID
		if strings.TrimSpace(id) == "" || len(id) > 200 {
			return nil, ports.ErrInvalidExecutionConfiguration
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		entry := domain.ProviderObservedModel{Model: id, SupportsTools: model.SupportsTools}
		if model.ContextWindow != nil {
			value := int64(*model.ContextWindow)
			if value < 1 || value > domain.MaximumSafeInteger {
				return nil, ports.ErrInvalidExecutionConfiguration
			}
			entry.ContextTokens = &value
		}
		if model.MaxOutputTokens != nil {
			value := int64(*model.MaxOutputTokens)
			if value < 1 || value > domain.MaximumSafeInteger {
				return nil, ports.ErrInvalidExecutionConfiguration
			}
			entry.MaxOutputTokens = &value
		}
		observed = append(observed, entry)
	}
	return json.Marshal(observed)
}

// ReplaceProviderObservations durably replaces the saved discovery set bound
// to the current authoritative connection, inside the same serial order as
// credential/catalog writes: advisory organization lock first, then a FOR
// UPDATE read of the exact provider row. Any drift (disabled, rotated
// credential, edited URL, concurrent mutation) rejects the whole transaction
// without touching the observation set or the execution revision.
func (repository *Repository) ReplaceProviderObservations(ctx context.Context, original ports.ProviderConnectionRecord, models []ports.DiscoveredModel) (int64, error) {
	if original.OrganizationID == "" || original.ConnectionID == "" {
		return 0, ports.ErrInvalidExecutionConfiguration
	}
	support, ok := domain.SupportedProvider(original.ProviderKey)
	if !ok || original.CredentialMethod != support.CredentialMethod {
		return 0, ports.ErrInvalidExecutionConfiguration
	}
	canonical, err := domain.CanonicalProviderBaseURL(original.BaseURL)
	if err != nil {
		return 0, ports.ErrInvalidExecutionConfiguration
	}
	payload, err := whitelistObservedModels(models)
	if err != nil {
		return 0, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin Provider observation transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockExecutionOrganization(ctx, tx, original.OrganizationID); err != nil {
		return 0, err
	}
	current, err := scanProvider(tx.QueryRow(ctx, `SELECT `+providerColumns+`
FROM agent_controller.provider_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
		original.OrganizationID, original.ConnectionID))
	if errors.Is(err, ports.ErrNotFound) {
		return 0, ports.ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("lock Provider connection for observations: %w", err)
	}
	if !current.Enabled {
		return 0, ports.ErrDisabledReference
	}
	currentCanonical, canonErr := domain.CanonicalProviderBaseURL(current.BaseURL)
	if canonErr != nil || current.ProviderKey != original.ProviderKey ||
		current.CredentialMethod != original.CredentialMethod ||
		current.CredentialRevision != original.CredentialRevision ||
		current.CredentialVersion != original.CredentialVersion ||
		currentCanonical != canonical {
		return 0, ports.ErrConcurrentChange
	}
	var revision int64
	err = tx.QueryRow(ctx, `INSERT INTO agent_controller.provider_observations AS observed (`+providerObservationColumns+`)
VALUES ($1,$2,1,$3,$4,$5,$6,$7)
ON CONFLICT (connection_id) DO UPDATE
SET source_revision=observed.source_revision+1, provider_key=EXCLUDED.provider_key,
    request_protocol=EXCLUDED.request_protocol, base_url=EXCLUDED.base_url,
    credential_revision=EXCLUDED.credential_revision, models=EXCLUDED.models
WHERE observed.organization_id=EXCLUDED.organization_id
  AND observed.source_revision < 9007199254740991
RETURNING source_revision`,
		original.ConnectionID, original.OrganizationID, original.ProviderKey, support.RequestProtocol, canonical,
		original.CredentialVersion, payload).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ports.ErrConcurrentChange
	}
	if err != nil {
		return 0, fmt.Errorf("replace Provider observations: %w", err)
	}
	if err := repository.advanceExecutionRevision(ctx, tx, original.OrganizationID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit Provider observations: %w", err)
	}
	return revision, nil
}

func readProviderObservations(ctx context.Context, tx *databaseTransaction, organizationID string) ([]domain.ProviderObservationSet, error) {
	rows, err := tx.Query(ctx, `SELECT `+providerObservationColumns+`
FROM agent_controller.provider_observations WHERE organization_id=$1 ORDER BY connection_id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("read Provider observations: %w", err)
	}
	defer rows.Close()
	sets := []domain.ProviderObservationSet{}
	for rows.Next() {
		var set domain.ProviderObservationSet
		var payload []byte
		if err := rows.Scan(&set.Binding.ConnectionID, &set.Binding.OrganizationID, &set.SourceRevision,
			&set.Binding.ProviderKey, &set.Binding.RequestProtocol, &set.Binding.BaseURL,
			&set.Binding.CredentialRevision, &payload); err != nil {
			return nil, fmt.Errorf("scan Provider observations: %w", err)
		}
		models, decodeErr := domain.DecodeObservationModels(payload)
		if decodeErr != nil {
			return nil, ports.ErrInvalidExecutionConfiguration
		}
		set.Models = models
		if !set.ValidObservationSet() {
			return nil, ports.ErrInvalidExecutionConfiguration
		}
		sets = append(sets, set)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Provider observations: %w", err)
	}
	return sets, nil
}
