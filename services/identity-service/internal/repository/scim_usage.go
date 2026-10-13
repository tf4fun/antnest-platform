package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func (a *SCIMAdapter) RecordTokenUse(ctx context.Context, authorization scim.Authorization, now time.Time) error {
	return recordSCIMTokenUse(ctx, a.store.pool, authorization.TokenID, authorization.OrganizationID, now)
}

// Mutation callers use their transaction, before taking session/feed locks.
// A failed condition or audit then leaves even the token row version unchanged.
func recordSCIMTokenUse(ctx context.Context, executor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, tokenID, organizationID string, now time.Time) error {
	if tokenID == "" {
		// Trusted in-process directory operations have no Bearer token.
		return nil
	}
	_, err := executor.Exec(ctx, `UPDATE scim_tokens
		SET last_used_at=$3
		WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
		  AND (last_used_at IS NULL OR last_used_at < $3::timestamptz - interval '5 minutes')`,
		tokenID, organizationID, now)
	if err != nil {
		return fmt.Errorf("record SCIM token usage: %w", err)
	}
	return nil
}
