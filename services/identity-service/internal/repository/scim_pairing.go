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
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func (s *Store) authorizeSCIMTokenIssuer(ctx context.Context, tx *databaseTransaction, command scim.IssueTokenCommand, lock bool) error {
	caller, err := callercontext.OptionalCallerFromContext(ctx)
	if err != nil {
		return err
	}
	if caller == nil {
		return s.requireOrganizationAdmin(ctx, tx, command.ActorPrincipalID, command.OrganizationID)
	}
	claims := caller.Claims()
	if claims.Subject != command.ActorPrincipalID || claims.Organization != command.OrganizationID {
		return callercontext.ErrInvalid
	}
	access := externalidentities.Access{Caller: caller, Scope: "organization"}
	if lock {
		if err := lockExternalIdentityParents(ctx, tx, access, externalIdentityTarget{}); err != nil {
			return err
		}
		if err := lockExternalCallerSession(ctx, tx, access); err != nil {
			return err
		}
	}
	_, err = s.authorizeExternalAccess(ctx, tx, access)
	return err
}

func sameSCIMPairing(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

// Serialize publication of SCIM Membership lineage before taking any row
// locks. A Provider lock alone cannot protect a missing deleted candidate, or
// prevent another credential from deleting the newest Membership after its
// predecessor was selected. The two-key namespace is separate from migration
// locks; an organization hash collision only adds serialization.
func lockSCIMUserDirectory(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('antnest.identity.scim-user'),hashtext($1))`, organizationID)
	return err
}

type scimReprovisionLineage struct {
	userID, membershipID string
	providerID           *string
	deletedAt            time.Time
}

func discoverSCIMReprovision(ctx context.Context, tx *databaseTransaction, organizationID, externalID string) (scimReprovisionLineage, error) {
	var lineage scimReprovisionLineage
	if externalID == "" {
		return lineage, nil
	}
	rows, err := tx.Query(ctx, `SELECT user_id,id,scim_oidc_provider_id,scim_deleted_at FROM organization_memberships
		WHERE organization_id=$1 AND source='scim' AND scim_external_id=$2 AND scim_deleted_at IS NOT NULL
		ORDER BY scim_deleted_at DESC,id DESC LIMIT 2`, organizationID, externalID)
	if err != nil {
		return lineage, err
	}
	candidates, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (scimReprovisionLineage, error) {
		var candidate scimReprovisionLineage
		err := row.Scan(&candidate.userID, &candidate.membershipID, &candidate.providerID, &candidate.deletedAt)
		return candidate, err
	})
	if err != nil || len(candidates) == 0 {
		return lineage, err
	}
	// Older rows may have equal deletion timestamps. Random resource IDs do
	// not establish which Membership is the latest generation; refuse to guess.
	if len(candidates) == 2 && candidates[0].deletedAt.Equal(candidates[1].deletedAt) {
		return lineage, domain.ErrConflict
	}
	return candidates[0], nil
}

func scimReprovisionProviders(ctx context.Context, tx *databaseTransaction, lineage scimReprovisionLineage, pairing *string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT provider_id FROM external_identities WHERE membership_id=$1`, lineage.membershipID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if pairing != nil {
		ids = append(ids, *pairing)
	}
	if lineage.providerID != nil {
		ids = append(ids, *lineage.providerID)
	}
	return sortedIdentityIDs(ids...), nil
}

func lockSCIMOrganization(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	var active bool
	if err := tx.QueryRow(ctx, `SELECT active FROM organizations WHERE id=$1 FOR SHARE`, organizationID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return domain.ErrForbidden
	}
	return nil
}

func lockSCIMReprovision(ctx context.Context, tx *databaseTransaction, command scim.CreateUserCommand, lineage scimReprovisionLineage, providers []string) (domain.User, error) {
	var user domain.User
	if err := tx.QueryRow(ctx, `SELECT id,system_role,active,created_at,updated_at FROM users WHERE id=$1 FOR UPDATE`, lineage.userID).
		Scan(&user.ID, &user.SystemRole, &user.Active, &user.CreatedAt, &user.UpdatedAt); err != nil {
		return user, err
	}
	if err := lockSCIMOrganization(ctx, tx, command.OrganizationID); err != nil {
		return user, err
	}
	var paired *string
	var deletedAt time.Time
	err := tx.QueryRow(ctx, `SELECT scim_oidc_provider_id,scim_deleted_at FROM organization_memberships WHERE id=$1 AND user_id=$2 AND organization_id=$3
		AND source='scim' AND scim_external_id=$4 AND scim_deleted_at IS NOT NULL FOR UPDATE`, lineage.membershipID, lineage.userID, command.OrganizationID, command.Membership.SCIMExternalID).Scan(&paired, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return user, errSCIMReprovisionChanged
	}
	if err != nil {
		return user, err
	}
	latest, err := discoverSCIMReprovision(ctx, tx, command.OrganizationID, command.Membership.SCIMExternalID)
	if err != nil {
		return user, err
	}
	if latest.membershipID != lineage.membershipID || latest.userID != lineage.userID || !sameSCIMPairing(paired, lineage.providerID) || !deletedAt.Equal(lineage.deletedAt) {
		return user, errSCIMReprovisionChanged
	}
	if !sameSCIMPairing(paired, command.Membership.SCIMOIDCProviderID) {
		return user, domain.ErrConflict
	}
	currentProviders, err := scimReprovisionProviders(ctx, tx, lineage, command.Membership.SCIMOIDCProviderID)
	if err != nil {
		return user, err
	}
	if !slices.Equal(providers, currentProviders) {
		return user, errSCIMReprovisionChanged
	}
	return user, nil
}

func (s *Store) bindSCIMSubject(ctx context.Context, tx *databaseTransaction, command scim.CreateUserCommand) error {
	pairing := command.Membership.SCIMOIDCProviderID
	if pairing == nil {
		return nil
	}
	if !oidcflow.ValidSubject(command.Membership.SCIMExternalID) {
		return domain.InvalidArgument("paired externalId must be a valid nonempty opaque subject")
	}
	var id, userID, memberID string
	err := tx.QueryRow(ctx, `SELECT id,user_id,membership_id FROM external_identities WHERE provider_id=$1 AND subject=$2`, *pairing, command.Membership.SCIMExternalID).Scan(&id, &userID, &memberID)
	if err == nil {
		if userID != command.User.ID || memberID != command.Membership.ID {
			return domain.ErrConflict
		}
		// A confirmed same-owner reprovision only moved the Membership pointer.
		// Its activation method/time and any explicit revocation stay untouched.
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	id = s.newID("externalidentity")
	if _, err := tx.Exec(ctx, `INSERT INTO external_identities(id,organization_id,provider_id,user_id,membership_id,subject,method,created_at,bound_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,'scim',$7,$7,$7)`, id, command.OrganizationID, *pairing, command.User.ID, command.Membership.ID, command.Membership.SCIMExternalID, command.Membership.CreatedAt); err != nil {
		return err
	}
	return s.recordExternalIdentityBound(ctx, tx, id, command.User.ID, "", command.ActorTokenID, "", command.Membership.CreatedAt)
}
