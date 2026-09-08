package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/propagation"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func (a *DirectoryAdapter) ResolveOwnerAuthorization(ctx context.Context, userID, organizationID string) (domain.OwnerAuthorization, error) {
	return observeRepositoryValue(ctx, "resolve_owner_authorization", func(ctx context.Context) (domain.OwnerAuthorization, error) {
		var state domain.OwnerAuthorization
		err := a.store.pool.QueryRow(ctx, `
			SELECT u.id, o.id, m.id, u.active AND m.active AND o.active,
			       COALESCE((SELECT max(sequence) FROM principal_revocations r
			                 WHERE r.user_id = u.id AND (r.organization_id IS NULL OR r.organization_id = o.id)), 0)
			FROM users u
			JOIN organization_memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.scim_deleted_at IS NULL
			JOIN organizations o ON o.id = m.organization_id
			WHERE u.id = $1`, userID, organizationID).Scan(
			&state.UserID, &state.OrganizationID, &state.MembershipID, &state.Active, &state.LastRevocationSequence)
		if err != nil {
			return domain.OwnerAuthorization{}, normalizeError(err)
		}
		return state, nil
	})
}

func (s *Store) appendPrincipalRevocation(ctx context.Context, tx pgx.Tx, value domain.PrincipalRevocation) error {
	// Allocate only after the writer lock; otherwise an uncommitted lower sequence can be skipped by consumers.
	if _, err := tx.Exec(ctx, "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE"); err != nil {
		return fmt.Errorf("lock principal revocation stream: %w", err)
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	_, err := tx.Exec(ctx, `INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent)
		VALUES ($1, NULLIF($2, ''), $3, $4, $5)`,
		value.UserID, value.OrganizationID, value.Reason, value.OccurredAt, carrier.Get("traceparent"))
	if err != nil {
		return fmt.Errorf("append principal revocation: %w", err)
	}
	return nil
}

func (a *DirectoryAdapter) ListPrincipalRevocations(ctx context.Context, query directory.RevocationQuery) (domain.PrincipalRevocationPage, error) {
	return observeRepositoryValue(ctx, "list_principal_revocations", func(ctx context.Context) (domain.PrincipalRevocationPage, error) {
		page := domain.PrincipalRevocationPage{Events: []domain.PrincipalRevocation{}, NextSequence: query.AfterSequence}
		rows, err := a.store.pool.Query(ctx, `SELECT sequence, user_id, COALESCE(organization_id, ''), reason, occurred_at, traceparent
			FROM principal_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2`, query.AfterSequence, query.Limit)
		if err != nil {
			return page, fmt.Errorf("list principal revocations: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var value domain.PrincipalRevocation
			if err := rows.Scan(&value.Sequence, &value.UserID, &value.OrganizationID, &value.Reason, &value.OccurredAt, &value.TraceParent); err != nil {
				return domain.PrincipalRevocationPage{}, fmt.Errorf("scan principal revocation: %w", err)
			}
			page.Events = append(page.Events, value)
			page.NextSequence = value.Sequence
		}
		if err := rows.Err(); err != nil {
			return domain.PrincipalRevocationPage{}, fmt.Errorf("iterate principal revocations: %w", err)
		}
		return page, nil
	})
}
