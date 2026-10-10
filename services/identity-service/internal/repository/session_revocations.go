package repository

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"go.opentelemetry.io/otel/propagation"
)

// Lifecycle callers already hold the affected User or Membership lock. Acquire
// every token lock before either feed writer lock, and retain the changed rows
// until the principal feed (when applicable) has been published first.
func revokeBrowserSessionsForLifecycle(ctx context.Context, tx *databaseTransaction, userID, organizationID, membershipID, reason string, now time.Time) ([]domain.SessionRevocation, error) {
	ids, err := lockBrowserSessionIDs(ctx, tx, userID)
	if err != nil {
		return nil, fmt.Errorf("lock lifecycle browser sessions: %w", err)
	}
	return revokeLockedBrowserSessions(ctx, tx, ids, organizationID, membershipID, "", reason, now)
}

// The caller owns every row in ids in ascending order. Restrict UPDATE to that
// set; a later concurrent issuance must never become an unlocked target.
func revokeLockedBrowserSessions(ctx context.Context, tx *databaseTransaction, ids []string, organizationID, membershipID, exceptID, reason string, now time.Time) ([]domain.SessionRevocation, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `UPDATE api_tokens SET revoked_at = $2
		WHERE id = ANY($1::text[]) AND kind = 'browser' AND revoked_at IS NULL
		AND ($3 = '' OR organization_id = $3) AND ($4 = '' OR membership_id = $4) AND id <> $5
		RETURNING id, user_id, organization_id`, ids, now, organizationID, membershipID, exceptID)
	if err != nil {
		return nil, fmt.Errorf("revoke locked browser sessions: %w", err)
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.SessionRevocation, error) {
		value := domain.SessionRevocation{Reason: reason, OccurredAt: now}
		err := row.Scan(&value.TokenID, &value.UserID, &value.OrganizationID)
		return value, err
	})
	slices.SortFunc(events, func(a, b domain.SessionRevocation) int { return strings.Compare(a.TokenID, b.TokenID) })
	return events, err
}

func appendSessionRevocations(ctx context.Context, tx *databaseTransaction, events []domain.SessionRevocation) error {
	if len(events) == 0 {
		return nil
	}
	// Acquire after all business locks and any principal feed publication, but
	// before allocating a sequence. Committed cursors cannot skip a late commit.
	if _, err := tx.Exec(ctx, "LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE"); err != nil {
		return fmt.Errorf("lock session revocation stream: %w", err)
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	for _, event := range events {
		if _, err := tx.Exec(ctx, `INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at, traceparent)
			VALUES ($1, $2, $3, $4, $5, $6)`, event.TokenID, event.UserID, event.OrganizationID, event.Reason, event.OccurredAt, carrier.Get("traceparent")); err != nil {
			return fmt.Errorf("append session revocation: %w", err)
		}
	}
	return nil
}

func (a *BrowserSessionsAdapter) ListRevocations(ctx context.Context, query browsersessions.RevocationQuery) (domain.SessionRevocationPage, error) {
	page := domain.SessionRevocationPage{Events: []domain.SessionRevocation{}, NextSequence: query.AfterSequence}
	rows, err := a.store.pool.Query(ctx, `SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations
		WHERE sequence > $1 ORDER BY sequence LIMIT $2`, query.AfterSequence, query.Limit)
	if err != nil {
		return domain.SessionRevocationPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var value domain.SessionRevocation
		if err := rows.Scan(&value.Sequence, &value.TokenID, &value.UserID, &value.OrganizationID, &value.Reason, &value.OccurredAt, &value.TraceParent); err != nil {
			return domain.SessionRevocationPage{}, err
		}
		value.OccurredAt = value.OccurredAt.UTC()
		page.Events = append(page.Events, value)
		page.NextSequence = value.Sequence
	}
	if err := rows.Err(); err != nil {
		return domain.SessionRevocationPage{}, err
	}
	return page, nil
}
