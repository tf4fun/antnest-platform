package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func insertMCPSecrets(ctx context.Context, tx *databaseTransaction, record ports.TemplateRecord) error {
	for _, secret := range record.MCPSecrets {
		location := secret.Location
		if location.OrganizationID != record.OrganizationID || location.TemplateID != record.TemplateID || location.Revision != record.Revision.Revision() {
			return errors.New("managed MCP secret location differs from Template")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_controller.managed_mcp_secrets
(organization_id, template_id, revision, server_id, name, fingerprint, ciphertext, nonce, key_version, wrapped_data_key)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, location.OrganizationID, location.TemplateID, location.Revision, location.ServerID, location.Name, secret.Fingerprint, secret.Sealed.Ciphertext, secret.Sealed.Nonce, secret.Sealed.KeyVersion, secret.Sealed.WrappedDataKey); err != nil {
			return fmt.Errorf("insert managed MCP secret: %w", err)
		}
	}
	return nil
}

func (repository *Repository) GetMCPSecret(ctx context.Context, location ports.MCPSecretLocation) (ports.MCPSecretRecord, error) {
	record := ports.MCPSecretRecord{Location: location}
	err := repository.pool.QueryRow(ctx, `SELECT fingerprint, ciphertext, nonce, key_version, wrapped_data_key FROM agent_controller.managed_mcp_secrets
WHERE organization_id=$1 AND template_id=$2 AND revision=$3 AND server_id=$4 AND name=$5`, location.OrganizationID, location.TemplateID, location.Revision, location.ServerID, location.Name).Scan(&record.Fingerprint, &record.Sealed.Ciphertext, &record.Sealed.Nonce, &record.Sealed.KeyVersion, &record.Sealed.WrappedDataKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.MCPSecretRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.MCPSecretRecord{}, errors.New("read managed MCP secret failed")
	}
	return record, nil
}
