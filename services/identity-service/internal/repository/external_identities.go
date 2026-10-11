package repository

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

func externalConflict() *domain.Error {
	return domain.NewError("external_identity_conflict", "The external identity conflicts with an existing binding", false)
}

func (a *ExternalIdentitiesAdapter) Bind(ctx context.Context, access externalidentities.Access, input externalidentities.BindInput) (externalidentities.Binding, error) {
	var result externalidentities.Binding
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if _, err := a.store.authorizeExternalAccess(ctx, tx, access); err != nil {
			return err
		}
		target := externalIdentityTarget{membershipID: input.MembershipID, providerID: input.ProviderID}
		if err := tx.QueryRow(ctx, `SELECT user_id,organization_id FROM organization_memberships WHERE id=$1 AND organization_id=$2`, input.MembershipID, access.Caller.Claims().Organization).Scan(&target.userID, &target.organizationID); err != nil {
			return err
		}
		var providerID string
		if err := tx.QueryRow(ctx, `SELECT id FROM oidc_providers WHERE id=$1 AND organization_id=$2 FOR UPDATE`, input.ProviderID, target.organizationID).Scan(&providerID); err != nil {
			return err
		}
		if err := lockExternalIdentityParents(ctx, tx, access, target); err != nil {
			return err
		}
		if err := ensureExternalTargetActive(ctx, tx, target); err != nil {
			return err
		}
		// Provider locking serializes owner/subject changes. Refuse foreign
		// ownership before taking any foreign mapping or Membership lock.
		var existingID, existingUser, existingMembership string
		var revokedAt *time.Time
		err := tx.QueryRow(ctx, `SELECT id,user_id,membership_id,revoked_at FROM external_identities WHERE provider_id=$1 AND subject=$2`, input.ProviderID, input.Subject).Scan(&existingID, &existingUser, &existingMembership, &revokedAt)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			if existingUser != target.userID || existingMembership != target.membershipID {
				return externalConflict()
			}
			if _, err := scanBinding(tx.QueryRow(ctx, bindingSelect+` WHERE e.id=$1 FOR UPDATE OF e`, existingID)); err != nil {
				return err
			}
		}
		if err := lockExternalCallerSession(ctx, tx, access); err != nil {
			return err
		}
		if _, err := a.store.authorizeExternalAccess(ctx, tx, access); err != nil {
			return err
		}
		if existingID != "" && revokedAt == nil {
			result, err = scanBinding(tx.QueryRow(ctx, bindingSelect+` WHERE e.id=$1`, existingID))
			if err != nil {
				return err
			}
			_, err = a.store.authorizeExternalAccess(ctx, tx, access)
			return err
		}
		if existingID != "" && !input.RestoreRevoked {
			return domain.NewError("external_identity_restore_required", "Explicit restoration is required for a revoked external identity", false)
		}
		var conflict bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_identities WHERE provider_id=$1 AND user_id=$2 AND revoked_at IS NULL)`, input.ProviderID, target.userID).Scan(&conflict); err != nil {
			return err
		}
		if conflict {
			return externalConflict()
		}
		now := a.store.browserAdmissionTime(time.Time{})
		if existingID == "" {
			existingID = a.store.newID("externalidentity")
			_, err = tx.Exec(ctx, `INSERT INTO external_identities (id,organization_id,provider_id,user_id,membership_id,subject,method,created_at,bound_at,updated_at)
				VALUES ($1,$2,$3,$4,$5,$6,'admin',$7,$7,$7)`, existingID, target.organizationID, input.ProviderID, target.userID, target.membershipID, input.Subject, now)
		} else {
			_, err = tx.Exec(ctx, `UPDATE external_identities SET revoked_at=NULL,method='admin',bound_at=$2,updated_at=$2 WHERE id=$1`, existingID, now)
		}
		if err != nil {
			return err
		}
		if err := a.store.recordExternalIdentityBound(ctx, tx, existingID, target.userID, input.ActorPrincipalID, "", input.RequestID, now); err != nil {
			return err
		}
		result, err = scanBinding(tx.QueryRow(ctx, bindingSelect+` WHERE e.id=$1`, existingID))
		if err != nil {
			return err
		}
		_, err = a.store.authorizeExternalAccess(ctx, tx, access)
		return err
	})
	if err != nil {
		if errors.Is(err, domain.ErrConflict) {
			err = domain.WithCause(externalConflict(), err)
		}
		return externalidentities.Binding{}, err
	}
	return result, nil
}

func (a *ExternalIdentitiesAdapter) Unbind(ctx context.Context, access externalidentities.Access, input externalidentities.UnbindInput) (externalidentities.UnbindResult, error) {
	for attempt := 0; attempt < 5; attempt++ {
		var result externalidentities.UnbindResult
		err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
			if _, err := a.store.authorizeExternalAccess(ctx, tx, access); err != nil {
				return err
			}
			var target externalIdentityTarget
			if err := tx.QueryRow(ctx, `SELECT user_id,organization_id,membership_id,provider_id FROM external_identities
				WHERE id=$1 AND (($2='self' AND user_id=$3) OR ($2='organization' AND organization_id=$4 AND membership_id=$5))`, input.BindingID, access.Scope, access.Caller.Claims().Subject, access.Caller.Claims().Organization, input.MembershipID).Scan(&target.userID, &target.organizationID, &target.membershipID, &target.providerID); err != nil {
				return err
			}
			providers, err := externalMethodProviders(ctx, tx, target)
			if err != nil {
				return err
			}
			if err := lockExternalProviders(ctx, tx, providers); err != nil {
				return err
			}
			if err := lockExternalIdentityParents(ctx, tx, access, target); err != nil {
				return err
			}
			currentProviders, err := externalMethodProviders(ctx, tx, target)
			if err != nil {
				return err
			}
			if !slices.Equal(providers, currentProviders) {
				return errExternalProviderSetChanged
			}
			binding, err := scanBinding(tx.QueryRow(ctx, bindingSelect+` WHERE e.id=$1 AND e.user_id=$2 AND e.membership_id=$3 FOR UPDATE OF e`, input.BindingID, target.userID, target.membershipID))
			if err != nil {
				return err
			}
			ids, err := lockExternalRevocationSessions(ctx, tx, access, target)
			if err != nil {
				return err
			}
			live, err := a.store.authorizeExternalAccess(ctx, tx, access)
			if err != nil {
				return err
			}
			if binding.RevokedAt != nil {
				return nil
			}
			if !input.AllowLockout {
				usable, err := usableExternalAlternative(ctx, tx, target, binding.ID)
				if err != nil {
					return err
				}
				if !usable {
					return domain.NewError("external_identity_last_method", "Removing this binding would leave the Membership without a usable sign-in method", false)
				}
			}
			// Availability checks may wait too; the admitted caller must still
			// be live at the first effect, not only before the check.
			live, err = a.store.authorizeExternalAccess(ctx, tx, access)
			if err != nil {
				return err
			}
			now := a.store.browserAdmissionTime(time.Time{})
			if _, err := tx.Exec(ctx, `UPDATE external_identities SET revoked_at=$2,updated_at=$2 WHERE id=$1`, binding.ID, now); err != nil {
				return err
			}
			events, err := revokeLockedBrowserSessions(ctx, tx, ids, target.organizationID, target.membershipID, "", "session_revoked", now)
			if err != nil {
				return err
			}
			result.RevokedCount = len(events)
			for _, event := range events {
				result.CurrentRevoked = result.CurrentRevoked || event.TokenID == live.ID
			}
			if err := a.store.appendEvent(ctx, tx, event{OrganizationID: target.organizationID, ActorPrincipalID: live.Principal.UserID, Type: "external_identity.unbound", SubjectType: "external_identity", SubjectID: binding.ID, RequestID: input.RequestID, CreatedAt: now, Metadata: map[string]any{"provider_id": target.providerID, "membership_id": target.membershipID, "scope": access.Scope, "allow_lockout": input.AllowLockout, "revoked_count": result.RevokedCount}}); err != nil {
				return err
			}
			if err := appendSessionRevocations(ctx, tx, events); err != nil {
				return err
			}
			return a.store.finishExternalRevocation(ctx, tx, access, live, result.CurrentRevoked)
		})
		if errors.Is(err, errExternalProviderSetChanged) {
			continue
		}
		if err != nil {
			return externalidentities.UnbindResult{}, err
		}
		return result, nil
	}
	return externalidentities.UnbindResult{}, domain.ErrVersionConflict
}

func (a *ExternalIdentitiesAdapter) Acknowledge(ctx context.Context, access externalidentities.Access, input externalidentities.AcknowledgeInput) (externalidentities.AcknowledgeResult, error) {
	var result externalidentities.AcknowledgeResult
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if _, err := a.store.authorizeExternalAccess(ctx, tx, access); err != nil {
			return err
		}
		if err := lockExternalIdentityParents(ctx, tx, access, externalIdentityTarget{}); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id FROM external_identity_notices WHERE user_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`, access.Caller.Claims().Subject, input.NoticeIDs)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if len(ids) != len(input.NoticeIDs) {
			return domain.ErrNotFound
		}
		if err := lockExternalCallerSession(ctx, tx, access); err != nil {
			return err
		}
		if _, err := a.store.authorizeExternalAccess(ctx, tx, access); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE external_identity_notices SET acknowledged_at=$2 WHERE id=ANY($1::text[]) AND acknowledged_at IS NULL`, ids, a.store.browserAdmissionTime(time.Time{}))
		if err != nil {
			return err
		}
		result.AcknowledgedCount = int(tag.RowsAffected())
		_, err = a.store.authorizeExternalAccess(ctx, tx, access)
		return err
	})
	if err != nil {
		return externalidentities.AcknowledgeResult{}, err
	}
	return result, nil
}
