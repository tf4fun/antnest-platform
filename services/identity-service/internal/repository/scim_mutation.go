package repository

import (
	"context"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

type scimMutationAdmission struct {
	tokenID   string
	expiresAt time.Time
}

// Resource and authority parents must already be locked. Take the acting and
// affected Token union in order, in its final mode, before usage or session rows.
func (s *Store) lockSCIMMutationAuthorization(ctx context.Context, tx *databaseTransaction, tokenID, organizationID string, expectedProvider *string, affectedTokenIDs ...string) (scimMutationAdmission, error) {
	var admission scimMutationAdmission
	// Trusted in-process directory operations cannot invent a Provider grant,
	// but still need to lock every Token affected by issuer offboarding.
	if tokenID == "" && expectedProvider != nil {
		return admission, domain.ErrForbidden
	}
	ids := sortedIdentityIDs(append([]string{tokenID}, affectedTokenIDs...)...)
	rows, err := tx.Query(ctx, `SELECT id,organization_id,oidc_provider_id,scopes,revoked_at,expires_at FROM scim_tokens
		WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return admission, err
	}
	type lockedToken struct {
		id, organizationID string
		providerID         *string
		scopes             []string
		revokedAt          *time.Time
		expiresAt          time.Time
	}
	tokens, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (lockedToken, error) {
		var token lockedToken
		err := row.Scan(&token.id, &token.organizationID, &token.providerID, &token.scopes, &token.revokedAt, &token.expiresAt)
		return token, err
	})
	if err != nil {
		return admission, err
	}
	if tokenID == "" {
		return admission, nil
	}
	// Collect all rows before checking time: a later affected Token can have
	// blocked after the acting Token was read and exhausted its deadline.
	for _, token := range tokens {
		if token.id != tokenID {
			continue
		}
		if token.organizationID != organizationID || token.revokedAt != nil {
			return admission, domain.ErrUnauthenticated
		}
		admission = scimMutationAdmission{tokenID: tokenID, expiresAt: token.expiresAt}
		if err := s.finishSCIMMutation(admission); err != nil {
			return scimMutationAdmission{}, err
		}
		if !slices.Contains(token.scopes, domain.SCIMScopeWrite) || !sameSCIMPairing(token.providerID, expectedProvider) {
			return scimMutationAdmission{}, domain.ErrForbidden
		}
		return admission, nil
	}
	return admission, domain.ErrUnauthenticated
}

// A historical SCIM-managed administrator can lose authority through User
// replacement or deletion. Its User/Org/Membership parents are already locked,
// preventing a concurrent issuance from extending this discovered Token set.
// An active SystemAdmin keeps authority independently of this Membership.
func scimUserIssuerLossTokens(ctx context.Context, tx *databaseTransaction, current scim.UserResource, nextActive bool) ([]string, error) {
	if nextActive || !current.User.Active || current.User.SystemRole == domain.SystemRoleAdmin ||
		!current.Membership.Active || current.Membership.Role != domain.OrganizationRoleAdmin {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM scim_tokens WHERE issued_by=$1
		AND organization_id=$2 AND revoked_at IS NULL ORDER BY id`, current.User.ID, current.Membership.OrganizationID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// The locked Token and Organization cannot change underneath the transaction.
// Time can still pass while audit and feed writers wait. Preserve the admitted
// deadline even when this same transaction intentionally revokes its own Token.
func (s *Store) finishSCIMMutation(admission scimMutationAdmission) error {
	if admission.tokenID != "" && !admission.expiresAt.After(s.now().UTC()) {
		return domain.ErrUnauthenticated
	}
	return nil
}

func lockSCIMMutationUser(ctx context.Context, tx *databaseTransaction, organizationID, membershipID string) (scim.UserResource, error) {
	var userID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM organization_memberships
		WHERE organization_id=$1 AND id=$2 AND source='scim' AND scim_deleted_at IS NULL`, organizationID, membershipID).Scan(&userID); err != nil {
		return scim.UserResource{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&userID); err != nil {
		return scim.UserResource{}, err
	}
	if err := lockSCIMOrganization(ctx, tx, organizationID); err != nil {
		return scim.UserResource{}, err
	}
	return scanSCIMUser(tx.QueryRow(ctx, scimUserSelect+`
		WHERE m.organization_id=$1 AND m.id=$2 AND m.source='scim'
		  AND m.scim_deleted_at IS NULL AND u.id=$3 FOR UPDATE OF m`, organizationID, membershipID, userID))
}

// Group writes take incoming User and Membership parents before their Group.
// User deletion takes the same order, then locks affected Groups. Holding the
// parents through insertion prevents references to a concurrently tombstoned
// Membership and avoids a Group -> Membership / Membership -> Group cycle.
func lockSCIMGroupMembers(ctx context.Context, tx *databaseTransaction, organizationID string, memberIDs []string) error {
	type memberParent struct{ id, userID string }
	read := func(lock bool) ([]memberParent, error) {
		query := `SELECT id,user_id FROM organization_memberships WHERE organization_id=$1
			AND source='scim' AND scim_deleted_at IS NULL AND id=ANY($2::text[]) ORDER BY id`
		if lock {
			query += " FOR SHARE"
		}
		rows, err := tx.Query(ctx, query, organizationID, memberIDs)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(row pgx.CollectableRow) (memberParent, error) {
			var member memberParent
			err := row.Scan(&member.id, &member.userID)
			return member, err
		})
	}
	discovered, err := read(false)
	if err != nil {
		return err
	}
	if len(discovered) != len(memberIDs) {
		return domain.ErrInvalidReference
	}
	var userIDs []string
	for _, member := range discovered {
		userIDs = append(userIDs, member.userID)
	}
	if err := lockSCIMLifecycleParents(ctx, tx, "users", sortedIdentityIDs(userIDs...)); err != nil {
		return err
	}
	if err := lockSCIMOrganization(ctx, tx, organizationID); err != nil {
		return err
	}
	current, err := read(true)
	if err != nil {
		return err
	}
	if !slices.Equal(discovered, current) {
		return domain.ErrInvalidReference
	}
	return nil
}

func lockSCIMMemberGroups(ctx context.Context, tx *databaseTransaction, organizationID, membershipID string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT g.id FROM groups g WHERE g.organization_id=$1 AND g.source='scim'
		AND EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.organization_id=$1 AND gm.group_id=g.id
		AND gm.organization_membership_id=$2 AND gm.source='scim') ORDER BY g.id FOR UPDATE OF g`, organizationID, membershipID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
