package repository

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

type ExternalIdentitiesAdapter struct{ store *Store }
type externalIdentityTarget struct{ userID, organizationID, membershipID, providerID string }

var errExternalProviderSetChanged = errors.New("external identity Provider set changed")

func (s *Store) authorizeExternalAccess(ctx context.Context, tx *databaseTransaction, access externalidentities.Access) (callercontext.Session, error) {
	live, err := s.revalidateBrowserCaller(ctx, tx, access.Caller)
	if err != nil {
		return callercontext.Session{}, err
	}
	if err := access.Authorize(live.Principal); err != nil {
		return callercontext.Session{}, err
	}
	return live, nil
}

func sortedIdentityIDs(ids ...string) []string {
	values := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != "" {
			values = append(values, id)
		}
	}
	slices.Sort(values)
	return slices.Compact(values)
}

// Share locks protect authority without conflicting with the legacy directory
// actor's share locks. Target Membership and Provider locks serialize binding
// changes. Acquiring actor Users FOR UPDATE would invert SetUserActive's
// actor-share -> target-update order during an administrator's prebinding.
func lockExternalIdentityParents(ctx context.Context, tx *databaseTransaction, access externalidentities.Access, target externalIdentityTarget) error {
	claims := access.Caller.Claims()
	for _, table := range []struct {
		name string
		ids  []string
	}{
		{"users", sortedIdentityIDs(claims.Subject, target.userID)},
		{"organizations", sortedIdentityIDs(claims.Organization, target.organizationID)},
	} {
		rows, err := tx.Query(ctx, `SELECT id FROM `+table.name+` WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, table.ids)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if !slices.Equal(ids, table.ids) {
			return domain.ErrNotFound
		}
	}
	for _, id := range sortedIdentityIDs(claims.Membership, target.membershipID) {
		lock := "FOR SHARE"
		if id == target.membershipID {
			lock = "FOR UPDATE"
		}
		var found string
		if err := tx.QueryRow(ctx, `SELECT id FROM organization_memberships WHERE id=$1 `+lock, id).Scan(&found); err != nil {
			return err
		}
	}
	if target.membershipID == "" {
		return nil
	}
	var userID, organizationID string
	if err := tx.QueryRow(ctx, `SELECT user_id,organization_id FROM organization_memberships WHERE id=$1`, target.membershipID).Scan(&userID, &organizationID); err != nil {
		return err
	}
	if userID != target.userID || organizationID != target.organizationID {
		return domain.ErrNotFound
	}
	return nil
}

func lockExternalProviders(ctx context.Context, tx *databaseTransaction, ids []string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM oidc_providers WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, ids)
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

func externalMethodProviders(ctx context.Context, tx *databaseTransaction, target externalIdentityTarget) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT provider_id FROM external_identities WHERE membership_id=$1 AND revoked_at IS NULL`, target.membershipID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	return sortedIdentityIDs(append(ids, target.providerID)...), nil
}

func lockExternalCallerSession(ctx context.Context, tx *databaseTransaction, access externalidentities.Access) error {
	var id string
	if err := tx.QueryRow(ctx, `SELECT id FROM api_tokens WHERE id=$1 AND kind='browser' FOR SHARE`, access.Caller.Claims().Session).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return callercontext.ErrInvalid
		}
		return err
	}
	return nil
}

func lockExternalRevocationSessions(ctx context.Context, tx *databaseTransaction, access externalidentities.Access, target externalIdentityTarget) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM api_tokens WHERE kind='browser'
		AND ((user_id=$1 AND revoked_at IS NULL) OR id=$2) ORDER BY id FOR UPDATE`, target.userID, access.Caller.Claims().Session)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func ensureExternalTargetActive(ctx context.Context, tx *databaseTransaction, target externalIdentityTarget) error {
	var active bool
	if err := tx.QueryRow(ctx, `SELECT u.active AND o.active AND m.active AND m.scim_deleted_at IS NULL AND u.system_role='user'
		FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id
		WHERE m.id=$1 AND u.id=$2 AND o.id=$3`, target.membershipID, target.userID, target.organizationID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return domain.ErrForbidden
	}
	return nil
}

func usableExternalAlternative(ctx context.Context, tx *databaseTransaction, target externalIdentityTarget, bindingID string) (bool, error) {
	var usable bool
	err := tx.QueryRow(ctx, `SELECT u.active AND o.active AND m.active AND m.scim_deleted_at IS NULL AND (
		EXISTS (SELECT 1 FROM local_credentials c WHERE c.user_id=u.id AND c.password_hash<>'') OR
		EXISTS (SELECT 1 FROM external_identities e JOIN oidc_providers p ON p.id=e.provider_id
			WHERE e.membership_id=m.id AND e.user_id=u.id AND e.id<>$4 AND e.revoked_at IS NULL AND p.enabled))
		FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id
		WHERE m.id=$1 AND u.id=$2 AND o.id=$3`, target.membershipID, target.userID, target.organizationID, bindingID).Scan(&usable)
	return usable, err
}

// After an intentional self revocation, verify the signed authority and both
// original deadlines without treating our own successful revocation as a new
// authorization. All actor parents and the original token remain locked.
func (s *Store) finishExternalRevocation(ctx context.Context, tx *databaseTransaction, access externalidentities.Access, live callercontext.Session, currentRevoked bool) error {
	if !currentRevoked {
		_, err := s.authorizeExternalAccess(ctx, tx, access)
		return err
	}
	_, err := access.Caller.Revalidate(ctx, func(context.Context, string, time.Time) (callercontext.Session, error) { return live, nil })
	return err
}
