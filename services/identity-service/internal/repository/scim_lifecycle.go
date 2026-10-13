package repository

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type SCIMLifecycleSummary struct {
	Tokens, Expired, UnknownIssuers, Revoked, Flagged int
}

// InitializeSCIMTokens admits the configured issuer-loss policy before traffic.
func (s *Store) InitializeSCIMTokens(ctx context.Context, revoke bool) (SCIMLifecycleSummary, error) {
	s.scimInitialization.Lock()
	defer s.scimInitialization.Unlock()
	if s.scimPolicyInitialized && s.scimRevokeOnIssuerLoss.Load() != revoke {
		return SCIMLifecycleSummary{}, fmt.Errorf("SCIM issuer-loss policy is already initialized")
	}
	var summary SCIMLifecycleSummary
	err := s.inTransaction(ctx, func(tx *databaseTransaction) error {
		// Discover immutable ownership without taking child locks. New service
		// issuances are already authorized; reconcile the preexisting population.
		rows, err := tx.Query(ctx, `SELECT id,organization_id,issued_by FROM scim_tokens
			WHERE revoked_at IS NULL AND issued_by IS NOT NULL ORDER BY id`)
		if err != nil {
			return err
		}
		tokens, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (scimIssuerToken, error) {
			var token scimIssuerToken
			err := row.Scan(&token.id, &token.organizationID, &token.issuerID)
			return token, err
		})
		if err != nil {
			return err
		}
		var users, organizations, ids []string
		for _, token := range tokens {
			users, organizations, ids = append(users, token.issuerID), append(organizations, token.organizationID), append(ids, token.id)
		}
		users, organizations = sortedIdentityIDs(users...), sortedIdentityIDs(organizations...)
		for _, table := range []struct {
			name string
			ids  []string
		}{{"users", users}, {"organizations", organizations}} {
			if err := lockSCIMLifecycleParents(ctx, tx, table.name, table.ids); err != nil {
				return err
			}
		}
		rows, err = tx.Query(ctx, `SELECT id FROM organization_memberships WHERE user_id=ANY($1::text[])
			AND organization_id=ANY($2::text[]) AND scim_deleted_at IS NULL ORDER BY id FOR SHARE`, users, organizations)
		if err != nil {
			return err
		}
		if _, err := pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		// Freeze all candidate Tokens only after their authority parents. Every
		// later mutation uses this set; there are no new business locks after it.
		rows, err = tx.Query(ctx, `SELECT id FROM scim_tokens WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
		if err != nil {
			return err
		}
		if _, err := pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		var lost []string
		for _, token := range tokens {
			principal, err := s.getPrincipal(ctx, tx, token.issuerID, token.organizationID)
			// Both User and Organization are locked and known to exist. A missing
			// non-SystemAdmin Membership is lost authority, not a database failure.
			if errors.Is(err, domain.ErrNotFound) || err == nil && !principal.CanAdminister(token.organizationID) {
				lost = append(lost, token.id)
			} else if err != nil {
				return err
			}
		}
		changed, err := s.applySCIMIssuerLoss(ctx, tx, lost, revoke, "", "", "")
		if err != nil {
			return err
		}
		if revoke {
			summary.Revoked = changed
		} else {
			summary.Flagged = changed
		}
		return tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= $1),
			count(*) FILTER (WHERE revoked_at IS NULL AND issued_by IS NULL) FROM scim_tokens`, s.now().UTC()).
			Scan(&summary.Tokens, &summary.Expired, &summary.UnknownIssuers)
	})
	if err != nil {
		return SCIMLifecycleSummary{}, fmt.Errorf("initialize SCIM issuer-loss policy: %w", err)
	}
	// Publish only after reconciliation commits. A failed startup must neither
	// expose traffic nor change the policy used by an already constructed Store.
	s.scimRevokeOnIssuerLoss.Store(revoke)
	s.scimPolicyInitialized = true
	return summary, nil
}

type scimIssuerToken struct{ id, organizationID, issuerID string }

func lockSCIMLifecycleParents(ctx context.Context, tx *databaseTransaction, table string, ids []string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM `+table+` WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, ids)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if !slices.Equal(found, ids) {
		return domain.ErrNotFound
	}
	return nil
}

// Directory mutations discover the target before taking an ordered union of
// actor and target User locks. Acquire each final mode once, before Org locks.
func lockDirectoryLifecycleUsers(ctx context.Context, tx *databaseTransaction, actorID, targetID string, updateTarget bool) error {
	for _, id := range sortedIdentityIDs(actorID, targetID) {
		mode := "FOR SHARE"
		if updateTarget && id == targetID {
			mode = "FOR UPDATE"
		}
		var found string
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 `+mode, id).Scan(&found); err != nil {
			return err
		}
	}
	return nil
}

func lockSCIMIssuerTokens(ctx context.Context, tx *databaseTransaction, issuerID, organizationID string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM scim_tokens WHERE issued_by=$1
		AND ($2='' OR organization_id=$2) AND revoked_at IS NULL ORDER BY id FOR UPDATE`, issuerID, organizationID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// All IDs are already locked in order. Keep policy changes and their audit in
// the same transaction as offboarding; restoration never clears either field.
func (s *Store) applySCIMIssuerLoss(ctx context.Context, tx *databaseTransaction, ids []string, revoke bool, actorID, actorTokenID, requestID string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	rows, err := tx.Query(ctx, `UPDATE scim_tokens SET
		revoked_at=CASE WHEN $2 THEN $3 ELSE revoked_at END,
		issuer_review_required=CASE WHEN $2 THEN issuer_review_required ELSE TRUE END
		WHERE id=ANY($1::text[]) AND revoked_at IS NULL AND ($2 OR NOT issuer_review_required)
		RETURNING id,organization_id,issued_by`, ids, revoke, now)
	if err != nil {
		return 0, err
	}
	changed, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (scimIssuerToken, error) {
		var token scimIssuerToken
		err := row.Scan(&token.id, &token.organizationID, &token.issuerID)
		return token, err
	})
	if err != nil {
		return 0, err
	}
	typeName := "scim_token.issuer_review_required"
	if revoke {
		typeName = "scim_token.revoked"
	}
	for _, token := range changed {
		if err := s.appendEvent(ctx, tx, event{OrganizationID: token.organizationID, ActorPrincipalID: actorID, ActorSCIMTokenID: actorTokenID,
			Type: typeName, SubjectType: "scim_token", SubjectID: token.id, RequestID: requestID, CreatedAt: now,
			Metadata: map[string]any{"reason": "issuer_authority_lost", "issued_by": token.issuerID}}); err != nil {
			return 0, err
		}
	}
	return len(changed), nil
}
