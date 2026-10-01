package postgres

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func validateTemplateModelCandidates(ctx context.Context, tx *databaseTransaction, organization string, template domain.TemplateRevisionSnapshot) error {
	ids := append([]string{template.ModelProfileID}, template.FallbackModelProfileIDs...)
	connections := make(map[string]bool, len(ids))
	for _, id := range ids {
		var connection string
		var enabled bool
		err := tx.QueryRow(ctx, `SELECT provider_connection_id, enabled FROM agent_controller.model_profiles
WHERE id=$1 AND organization_id=$2`, id, organization).Scan(&connection, &enabled)
		if err := requireEnabledCatalogDependency(enabled, err); err != nil {
			return err
		}
		if connections[connection] {
			return fmt.Errorf("%w: each Template candidate must use a distinct Provider connection", ports.ErrInvalidModelCandidates)
		}
		connections[connection] = true
	}
	return nil
}
