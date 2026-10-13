package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

type SCIMAdapter struct{ store *Store }

func (a *SCIMAdapter) GetPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return a.store.getPrincipal(ctx, a.store.pool, userID, organizationID)
}

func (a *SCIMAdapter) IssueToken(ctx context.Context, command scim.IssueTokenCommand) (scim.Token, error) {
	// Zero is the omitted value for trusted in-process callers. The public RPC
	// and service reject an explicitly supplied zero before reaching this command.
	var requested *int
	if command.ExpiresInDays != 0 {
		requested = &command.ExpiresInDays
	}
	days, err := scim.TokenLifetimeDays(requested)
	if err != nil {
		return scim.Token{}, err
	}
	var token scim.Token
	err = a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := domain.CheckCallerOrganization(ctx, command.OrganizationID); err != nil {
			return err
		}
		if command.OIDCProviderID != nil {
			if !domain.ValidID(*command.OIDCProviderID) {
				return domain.InvalidArgument("invalid Provider ID")
			}
			var providerID string
			if err := tx.QueryRow(ctx, `SELECT id FROM oidc_providers WHERE id=$1 AND organization_id=$2 FOR UPDATE`, *command.OIDCProviderID, command.OrganizationID).Scan(&providerID); err != nil {
				return err
			}
		}
		if err := a.store.authorizeSCIMTokenIssuer(ctx, tx, command, true); err != nil {
			return err
		}
		// Provider, authority and caller-session waits must not consume lifetime
		// or leave a stale response timestamp. Use the database's stored precision.
		now := a.store.now().UTC().Truncate(time.Microsecond)
		token = scim.Token{
			ID: command.TokenID, OrganizationID: command.OrganizationID, Name: command.Name,
			OIDCProviderID: command.OIDCProviderID, Scopes: command.Scopes,
			IssuedBy: &command.ActorPrincipalID,
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO scim_tokens (id, organization_id, token_hash, name, scopes, created_at, oidc_provider_id, expires_at, issued_by, issuer_review_required)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
			RETURNING created_at, expires_at`,
			command.TokenID, command.OrganizationID, command.TokenHash,
			command.Name, command.Scopes, now, command.OIDCProviderID,
			now.Add(time.Duration(days)*24*time.Hour), command.ActorPrincipalID,
		).Scan(&token.CreatedAt, &token.ExpiresAt); err != nil {
			return fmt.Errorf("insert SCIM token: %w", err)
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
			Type: "scim_token.issued", SubjectType: "scim_token", SubjectID: command.TokenID,
			RequestID: command.RequestID, CreatedAt: token.CreatedAt,
		}); err != nil {
			return err
		}
		return a.store.authorizeSCIMTokenIssuer(ctx, tx, command, false)
	})
	if err != nil {
		return scim.Token{}, err
	}
	return token, nil
}

func (a *SCIMAdapter) RevokeToken(ctx context.Context, actorUserID, tokenID string, _ time.Time) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		// Discover scope without a child lock. Issuer offboarding takes
		// User/Org/Membership before Tokens, so manual revocation must too.
		var organizationID string
		if err := tx.QueryRow(ctx, `SELECT organization_id FROM scim_tokens WHERE id=$1`, tokenID).Scan(&organizationID); err != nil {
			return err
		}
		if err := domain.CheckCallerOrganization(ctx, organizationID); err != nil {
			return err
		}
		caller, err := callercontext.OptionalCallerFromContext(ctx)
		if err != nil {
			return err
		}
		access := externalidentities.Access{Caller: caller, Scope: "organization"}
		if caller == nil {
			if err := a.store.requireOrganizationAdmin(ctx, tx, actorUserID, organizationID); err != nil {
				return err
			}
		} else {
			if caller.Claims().Subject != actorUserID || caller.Claims().Organization != organizationID {
				return callercontext.ErrInvalid
			}
			if err := lockExternalIdentityParents(ctx, tx, access, externalIdentityTarget{}); err != nil {
				return err
			}
		}
		var revokedAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT revoked_at FROM scim_tokens
			WHERE id=$1 AND organization_id=$2 FOR UPDATE`, tokenID, organizationID).Scan(&revokedAt); err != nil {
			return err
		}
		if caller != nil {
			if err := lockExternalCallerSession(ctx, tx, access); err != nil {
				return err
			}
		}
		issuer := scim.IssueTokenCommand{ActorPrincipalID: actorUserID, OrganizationID: organizationID}
		if err := a.store.authorizeSCIMTokenIssuer(ctx, tx, issuer, false); err != nil {
			return err
		}
		if revokedAt != nil {
			return nil
		}
		now := a.store.now().UTC().Truncate(time.Microsecond)
		if _, err := tx.Exec(ctx, `UPDATE scim_tokens SET revoked_at = $2 WHERE id = $1`, tokenID, now); err != nil {
			return fmt.Errorf("revoke SCIM token: %w", err)
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, ActorPrincipalID: actorUserID,
			Type: "scim_token.revoked", SubjectType: "scim_token", SubjectID: tokenID,
			CreatedAt: now,
		}); err != nil {
			return err
		}
		return a.store.authorizeSCIMTokenIssuer(ctx, tx, issuer, false)
	})
}

func (a *SCIMAdapter) ListTokens(ctx context.Context, organizationID string) ([]scim.Token, error) {
	rows, err := a.store.pool.Query(ctx, `
			SELECT id, organization_id, name, scopes, created_at, revoked_at, oidc_provider_id,
			       expires_at, issued_by, issuer_review_required
			FROM scim_tokens
			WHERE organization_id = $1
			ORDER BY created_at DESC, id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("list SCIM tokens: %w", err)
	}
	defer rows.Close()
	tokens := make([]scim.Token, 0)
	for rows.Next() {
		var token scim.Token
		if err := rows.Scan(
			&token.ID, &token.OrganizationID, &token.Name, &token.Scopes,
			&token.CreatedAt, &token.RevokedAt, &token.OIDCProviderID,
			&token.ExpiresAt, &token.IssuedBy, &token.IssuerReviewRequired,
		); err != nil {
			return nil, fmt.Errorf("scan SCIM token: %w", err)
		}
		tokens = append(tokens, token)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate SCIM tokens: %w", err)
	}
	return tokens, nil
}

func (a *SCIMAdapter) ResolveToken(
	ctx context.Context,
	digest string,
	now time.Time,
) (authorization scim.Authorization, resultErr error) {
	var expiresAt time.Time
	err := a.store.pool.QueryRow(ctx, `
		SELECT t.id, t.organization_id, t.scopes, t.oidc_provider_id, t.expires_at
		FROM scim_tokens t JOIN organizations o ON o.id = t.organization_id
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2
		  AND o.active`, digest, now,
	).Scan(&authorization.TokenID, &authorization.OrganizationID, &authorization.Scopes, &authorization.OIDCProviderID, &expiresAt)
	if err != nil {
		return scim.Authorization{}, normalizeError(err)
	}
	// Even a read can wait for a database lock. Its pre-query cutoff must not
	// admit a credential whose lifetime elapsed while that query was blocked.
	if !expiresAt.After(a.store.now().UTC()) {
		return scim.Authorization{}, domain.ErrNotFound
	}
	return authorization, nil
}

func (a *SCIMAdapter) CreateUser(ctx context.Context, command scim.CreateUserCommand) (scim.UserResource, error) {
	if command.Membership.OrganizationID != command.OrganizationID || command.Membership.UserID != command.User.ID || command.Membership.Source != domain.SourceSCIM {
		return scim.UserResource{}, domain.ErrInvalidArgument
	}
	if !sameSCIMPairing(command.ActorOIDCProviderID, command.Membership.SCIMOIDCProviderID) {
		return scim.UserResource{}, domain.ErrForbidden
	}
	if pairing := command.Membership.SCIMOIDCProviderID; pairing != nil && (!domain.ValidID(*pairing) || !oidcflow.ValidSubject(command.Membership.SCIMExternalID)) {
		return scim.UserResource{}, domain.InvalidArgument("invalid SCIM Provider pairing or opaque subject")
	}
	for attempt := 0; attempt < 5; attempt++ {
		result, err := a.createUserAttempt(ctx, command)
		if errors.Is(err, errSCIMReprovisionChanged) {
			continue
		}
		return result, err
	}
	return scim.UserResource{}, domain.ErrVersionConflict
}

var errSCIMReprovisionChanged = errors.New("SCIM reprovision lineage changed")

func (a *SCIMAdapter) createUserAttempt(ctx context.Context, command scim.CreateUserCommand) (scim.UserResource, error) {
	var result scim.UserResource
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockSCIMUserDirectory(ctx, tx, command.OrganizationID); err != nil {
			return err
		}
		lineage, err := discoverSCIMReprovision(ctx, tx, command.OrganizationID, command.Membership.SCIMExternalID)
		if err != nil {
			return err
		}
		reprovisioned := lineage.membershipID != ""
		// Do not filter discovery by Provider: a different or NULL pairing is
		// a directory collision, not permission to create/adopt another User.
		if reprovisioned && !sameSCIMPairing(lineage.providerID, command.Membership.SCIMOIDCProviderID) {
			return domain.ErrConflict
		}
		providers, err := scimReprovisionProviders(ctx, tx, lineage, command.Membership.SCIMOIDCProviderID)
		if err != nil {
			return err
		}
		if err := lockExternalProviders(ctx, tx, providers); err != nil {
			return err
		}
		if reprovisioned {
			user, err := lockSCIMReprovision(ctx, tx, command, lineage, providers)
			if err != nil {
				return err
			}
			command.User, command.Membership.UserID = user, user.ID
			// A random Membership ID is not a generation cursor. Advancing
			// beyond the confirmed predecessor also survives clock regression.
			createdAt := domain.NextUpdatedAt(command.Membership.CreatedAt, lineage.deletedAt)
			command.Membership.CreatedAt, command.Membership.UpdatedAt = createdAt, createdAt
		}
		if !reprovisioned {
			if _, err := tx.Exec(ctx, `
				INSERT INTO users (id, system_role, active, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5)`,
				command.User.ID, command.User.SystemRole, command.User.Active,
				command.User.CreatedAt, command.User.UpdatedAt,
			); err != nil {
				return fmt.Errorf("insert SCIM user: %w", err)
			}
			if err := lockSCIMOrganization(ctx, tx, command.OrganizationID); err != nil {
				return err
			}
		}
		if err := insertMembership(ctx, tx, command.Membership); err != nil {
			return err
		}
		if reprovisioned {
			if _, err := tx.Exec(ctx, `
				UPDATE external_identities
				SET membership_id = $3, updated_at = $4
				WHERE organization_id = $1 AND user_id = $2 AND membership_id = $5`,
				command.OrganizationID,
				command.User.ID,
				command.Membership.ID,
				command.Membership.CreatedAt,
				lineage.membershipID,
			); err != nil {
				return fmt.Errorf("repoint OIDC identities after SCIM reprovisioning: %w", err)
			}
		}
		// Resource locks precede the Token lock, as in other directory writes.
		// Acquire the final lock mode once: usage must not upgrade a shared lock.
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID)
		if err != nil {
			return err
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		if err := a.store.bindSCIMSubject(ctx, tx, command); err != nil {
			return err
		}
		// Return the persisted version, including PostgreSQL timestamp precision.
		// Echoing the command can expose nanoseconds that were never stored and
		// make the returned version conflict with an immediate replacement.
		result, err = scanSCIMUser(tx.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.id = $2 AND m.source = 'scim'
			  AND m.scim_deleted_at IS NULL`, command.OrganizationID, command.Membership.ID))
		if err != nil {
			return err
		}
		eventType := "scim_user.created"
		if reprovisioned {
			eventType = "scim_user.reprovisioned"
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: eventType,
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
			CreatedAt: command.Membership.CreatedAt,
		}); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
	if err != nil {
		return scim.UserResource{}, err
	}
	return result, nil
}

func (a *SCIMAdapter) GetUser(ctx context.Context, organizationID, resourceID string) (scim.UserResource, error) {
	return scanSCIMUser(a.store.pool.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.id = $2 AND m.source = 'scim'
			  AND m.scim_deleted_at IS NULL`, organizationID, resourceID))
}

func (a *SCIMAdapter) ListUsers(ctx context.Context, query scim.ListQuery) (scim.UserPage, error) {
	where, arguments, err := scimUserFilter(query)
	if err != nil {
		return scim.UserPage{}, err
	}
	var total int
	if err := a.store.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE `+where, arguments[:len(arguments)-2]...).Scan(&total); err != nil {
		return scim.UserPage{}, fmt.Errorf("count SCIM users: %w", err)
	}
	rows, err := a.store.pool.Query(ctx, scimUserSelect+`
		WHERE `+where+`
		ORDER BY m.id
		OFFSET $`+fmt.Sprint(len(arguments)-1)+` LIMIT $`+fmt.Sprint(len(arguments)), arguments...)
	if err != nil {
		return scim.UserPage{}, fmt.Errorf("list SCIM users: %w", err)
	}
	defer rows.Close()
	items := make([]scim.UserResource, 0)
	for rows.Next() {
		item, err := scanSCIMUser(rows)
		if err != nil {
			return scim.UserPage{}, fmt.Errorf("scan SCIM user: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return scim.UserPage{}, fmt.Errorf("iterate SCIM users: %w", err)
	}
	return scim.UserPage{Items: items, TotalResults: total}, nil
}

func (a *SCIMAdapter) ReplaceUser(ctx context.Context, command scim.ReplaceUserCommand) (scim.UserResource, error) {
	var result scim.UserResource
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		current, err := lockSCIMMutationUser(ctx, tx, command.OrganizationID, command.Membership.ID)
		if err != nil {
			return err
		}
		issuerTokens, err := scimUserIssuerLossTokens(ctx, tx, current, command.Membership.Active)
		if err != nil {
			return err
		}
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID, issuerTokens...)
		if err != nil {
			return err
		}
		if !command.IfMatch.Matches(current.Membership.UpdatedAt) {
			return domain.ErrPreconditionFailed
		}
		if !current.Membership.UpdatedAt.Equal(command.ExpectedUpdatedAt) {
			return domain.ErrVersionConflict
		}
		if !sameSCIMPairing(current.Membership.SCIMOIDCProviderID, command.Membership.SCIMOIDCProviderID) ||
			current.Membership.SCIMOIDCProviderID != nil && current.Membership.SCIMExternalID != command.Membership.SCIMExternalID {
			return domain.InvalidArgument("paired externalId and Membership pairing cannot be changed or cleared")
		}
		command.User = current.User
		command.Membership.ID = current.Membership.ID
		command.Membership.OrganizationID = current.Membership.OrganizationID
		command.Membership.UserID = current.User.ID
		command.Membership.CreatedAt = current.Membership.CreatedAt
		command.Membership.UpdatedAt = domain.NextUpdatedAt(command.Membership.UpdatedAt, current.Membership.UpdatedAt)
		result, err = replaceSCIMUser(ctx, tx, command.User, command.Membership)
		if err != nil {
			return err
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		if _, err := a.store.applySCIMIssuerLoss(ctx, tx, issuerTokens, a.store.scimRevokeOnIssuerLoss.Load(), "", command.ActorTokenID, ""); err != nil {
			return err
		}
		var sessionEvents []domain.SessionRevocation
		if !current.Membership.Active || !result.Membership.Active {
			reason := "membership_deactivated"
			if !current.Membership.Active {
				// Inactive rows from before persistent browser revocation must
				// not revive their old credentials when reactivated.
				reason = "session_revoked"
			}
			sessionEvents, err = revokeBrowserSessionsForLifecycle(ctx, tx, current.User.ID, command.OrganizationID, current.Membership.ID, reason, result.Membership.UpdatedAt)
			if err != nil {
				return err
			}
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_user.replaced",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
			CreatedAt: command.Membership.UpdatedAt,
		}); err != nil {
			return err
		}
		if current.Membership.Active && !result.Membership.Active {
			if err := a.store.appendPrincipalRevocation(ctx, tx, domain.PrincipalRevocation{
				UserID: current.User.ID, OrganizationID: command.OrganizationID,
				Reason: "membership_deactivated", OccurredAt: result.Membership.UpdatedAt,
			}); err != nil {
				return err
			}
		}
		if err := appendSessionRevocations(ctx, tx, sessionEvents); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
	if err != nil {
		return scim.UserResource{}, err
	}
	return result, nil
}

func (a *SCIMAdapter) DeleteUser(ctx context.Context, command scim.DeleteUserCommand) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockSCIMUserDirectory(ctx, tx, command.OrganizationID); err != nil {
			return err
		}
		current, err := lockSCIMMutationUser(ctx, tx, command.OrganizationID, command.MembershipID)
		if err != nil {
			return err
		}
		userID, updatedAt := current.User.ID, current.Membership.UpdatedAt
		groupIDs, err := lockSCIMMemberGroups(ctx, tx, command.OrganizationID, command.MembershipID)
		if err != nil {
			return err
		}
		issuerTokens, err := scimUserIssuerLossTokens(ctx, tx, current, false)
		if err != nil {
			return err
		}
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID, issuerTokens...)
		if err != nil {
			return err
		}
		if !command.IfMatch.Matches(updatedAt) {
			return domain.ErrPreconditionFailed
		}
		deletedAt := domain.NextUpdatedAt(command.DeletedAt, updatedAt)
		if _, err := tx.Exec(ctx, `
			UPDATE groups g
			SET updated_at = GREATEST($3::timestamptz, g.updated_at + interval '1 microsecond')
			WHERE g.organization_id = $1 AND g.source = 'scim' AND g.id=ANY($2::text[])`,
			command.OrganizationID, groupIDs, deletedAt,
		); err != nil {
			return fmt.Errorf("advance SCIM groups after user deletion: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM group_memberships
			WHERE organization_id = $1 AND organization_membership_id = $2 AND source = 'scim'`,
			command.OrganizationID, command.MembershipID,
		); err != nil {
			return fmt.Errorf("delete SCIM group memberships: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE organization_memberships
			SET active = FALSE, scim_deleted_at = $3, updated_at = $3
			WHERE organization_id = $1 AND id = $2`,
			command.OrganizationID, command.MembershipID, deletedAt,
		); err != nil {
			return fmt.Errorf("tombstone SCIM user: %w", err)
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		if _, err := a.store.applySCIMIssuerLoss(ctx, tx, issuerTokens, a.store.scimRevokeOnIssuerLoss.Load(), "", command.ActorTokenID, ""); err != nil {
			return err
		}
		sessionEvents, err := revokeBrowserSessionsForLifecycle(ctx, tx, userID, command.OrganizationID, command.MembershipID, "membership_deleted", deletedAt)
		if err != nil {
			return err
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_user.deleted",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.MembershipID,
			Metadata: map[string]any{"user_id": userID}, CreatedAt: deletedAt,
		}); err != nil {
			return err
		}
		if err := a.store.appendPrincipalRevocation(ctx, tx, domain.PrincipalRevocation{
			UserID: userID, OrganizationID: command.OrganizationID,
			Reason: "membership_deleted", OccurredAt: deletedAt,
		}); err != nil {
			return err
		}
		if err := appendSessionRevocations(ctx, tx, sessionEvents); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
}

func (a *SCIMAdapter) CreateGroup(ctx context.Context, command scim.CreateGroupCommand) (scim.GroupResource, error) {
	if command.Group.OrganizationID != command.OrganizationID || command.Group.Source != domain.SourceSCIM {
		return scim.GroupResource{}, domain.ErrInvalidArgument
	}
	var result scim.GroupResource
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockSCIMGroupMembers(ctx, tx, command.OrganizationID, command.MemberIDs); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO groups (
				id, organization_id, display_name, source, active, scim_external_id, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8)
			RETURNING created_at, updated_at`,
			command.Group.ID, command.Group.OrganizationID, command.Group.DisplayName,
			command.Group.Source, command.Group.Active, command.Group.SCIMExternalID,
			command.Group.CreatedAt, command.Group.UpdatedAt,
		).Scan(&command.Group.CreatedAt, &command.Group.UpdatedAt); err != nil {
			return fmt.Errorf("insert SCIM group: %w", err)
		}
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID)
		if err != nil {
			return err
		}
		if err := a.replaceSCIMGroupMemberships(ctx, tx, command.Group, command.MemberIDs); err != nil {
			return err
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		result = scim.GroupResource{Group: command.Group, MemberIDs: command.MemberIDs}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.created",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.Group.ID, CreatedAt: command.Group.CreatedAt,
		}); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
	if err != nil {
		return scim.GroupResource{}, err
	}
	return result, nil
}

func (a *SCIMAdapter) GetGroup(ctx context.Context, organizationID, resourceID string) (scim.GroupResource, error) {
	return a.getSCIMGroup(ctx, a.store.pool, organizationID, "id", resourceID)
}

func (a *SCIMAdapter) ListGroups(ctx context.Context, query scim.ListQuery) (scim.GroupPage, error) {
	where, arguments, err := scimGroupFilter(query)
	if err != nil {
		return scim.GroupPage{}, err
	}
	var total int
	if err := a.store.pool.QueryRow(ctx, `SELECT count(*) FROM groups g WHERE `+where, arguments[:len(arguments)-2]...).Scan(&total); err != nil {
		return scim.GroupPage{}, fmt.Errorf("count SCIM groups: %w", err)
	}
	rows, err := a.store.pool.Query(ctx, scimGroupSnapshotSelect+`
		WHERE `+where+`
		ORDER BY g.id
		OFFSET $`+fmt.Sprint(len(arguments)-1)+` LIMIT $`+fmt.Sprint(len(arguments)), arguments...)
	if err != nil {
		return scim.GroupPage{}, fmt.Errorf("list SCIM groups: %w", err)
	}
	defer rows.Close()
	items := make([]scim.GroupResource, 0)
	for rows.Next() {
		resource, err := scanSCIMGroupSnapshot(rows)
		if err != nil {
			return scim.GroupPage{}, fmt.Errorf("scan SCIM group: %w", err)
		}
		items = append(items, resource)
	}
	if err := rows.Err(); err != nil {
		return scim.GroupPage{}, fmt.Errorf("iterate SCIM groups: %w", err)
	}
	return scim.GroupPage{Items: items, TotalResults: total}, nil
}

func (a *SCIMAdapter) ReplaceGroup(ctx context.Context, command scim.ReplaceGroupCommand) (scim.GroupResource, error) {
	if command.Group.OrganizationID != command.OrganizationID || command.Group.Source != domain.SourceSCIM {
		return scim.GroupResource{}, domain.ErrInvalidArgument
	}
	var result scim.GroupResource
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockSCIMGroupMembers(ctx, tx, command.OrganizationID, command.MemberIDs); err != nil {
			return err
		}
		current, err := a.getSCIMGroupForUpdate(ctx, tx, command.OrganizationID, "id", command.Group.ID)
		if err != nil {
			return err
		}
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID)
		if err != nil {
			return err
		}
		if !command.IfMatch.Matches(current.Group.UpdatedAt) {
			return domain.ErrPreconditionFailed
		}
		if !current.Group.UpdatedAt.Equal(command.ExpectedUpdatedAt) {
			return domain.ErrVersionConflict
		}
		command.Group.ID, command.Group.CreatedAt = current.Group.ID, current.Group.CreatedAt
		command.Group.UpdatedAt = domain.NextUpdatedAt(command.Group.UpdatedAt, current.Group.UpdatedAt)
		result, err = a.replaceSCIMGroup(ctx, tx, command.Group, command.MemberIDs)
		if err != nil {
			return err
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.replaced",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.Group.ID, CreatedAt: command.Group.UpdatedAt,
		}); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
	if err != nil {
		return scim.GroupResource{}, err
	}
	return result, nil
}

func (a *SCIMAdapter) DeleteGroup(ctx context.Context, command scim.DeleteGroupCommand) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockSCIMOrganization(ctx, tx, command.OrganizationID); err != nil {
			return err
		}
		var updatedAt time.Time
		if err := tx.QueryRow(ctx, `SELECT updated_at FROM groups
			WHERE organization_id = $1 AND id = $2 AND source = 'scim' FOR UPDATE`,
			command.OrganizationID, command.GroupID).Scan(&updatedAt); err != nil {
			return normalizeError(err)
		}
		admission, err := a.store.lockSCIMMutationAuthorization(ctx, tx, command.ActorTokenID, command.OrganizationID, command.ActorOIDCProviderID)
		if err != nil {
			return err
		}
		if !command.IfMatch.Matches(updatedAt) {
			return domain.ErrPreconditionFailed
		}
		result, err := tx.Exec(ctx, `
			DELETE FROM groups
			WHERE organization_id = $1 AND id = $2 AND source = 'scim'`,
			command.OrganizationID, command.GroupID,
		)
		if err != nil {
			return fmt.Errorf("delete SCIM group: %w", err)
		}
		if result.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		if err := recordSCIMTokenUse(ctx, tx, command.ActorTokenID, command.OrganizationID, a.store.now().UTC()); err != nil {
			return err
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.deleted",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.GroupID, CreatedAt: command.DeletedAt,
		}); err != nil {
			return err
		}
		return a.store.finishSCIMMutation(admission)
	})
}

func replaceSCIMUser(
	ctx context.Context,
	tx *databaseTransaction,
	user domain.User,
	membership domain.OrganizationMembership,
) (scim.UserResource, error) {
	err := tx.QueryRow(ctx, `
		UPDATE organization_memberships
		SET email = $3, display_name = $4, active = $5,
		    scim_external_id = NULLIF($6, ''), scim_user_name = $7, updated_at = $8
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'
		  AND scim_deleted_at IS NULL
		RETURNING updated_at`,
		membership.OrganizationID, membership.ID, membership.Email, membership.DisplayName,
		membership.Active, membership.SCIMExternalID, membership.SCIMUserName, membership.UpdatedAt,
	).Scan(&membership.UpdatedAt)
	if err != nil {
		return scim.UserResource{}, fmt.Errorf("replace SCIM membership: %w", normalizeError(err))
	}
	return scim.UserResource{User: user, Membership: membership}, nil
}

func (a *SCIMAdapter) replaceSCIMGroup(
	ctx context.Context,
	tx *databaseTransaction,
	group domain.Group,
	memberIDs []string,
) (scim.GroupResource, error) {
	err := tx.QueryRow(ctx, `
		UPDATE groups
		SET display_name = $3, active = $4, scim_external_id = NULLIF($5, ''), updated_at = $6
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'
		RETURNING updated_at`,
		group.OrganizationID, group.ID, group.DisplayName, group.Active,
		group.SCIMExternalID, group.UpdatedAt,
	).Scan(&group.UpdatedAt)
	if err != nil {
		return scim.GroupResource{}, fmt.Errorf("replace SCIM group: %w", normalizeError(err))
	}
	if err := a.replaceSCIMGroupMemberships(ctx, tx, group, memberIDs); err != nil {
		return scim.GroupResource{}, err
	}
	return scim.GroupResource{Group: group, MemberIDs: memberIDs}, nil
}

func (a *SCIMAdapter) replaceSCIMGroupMemberships(
	ctx context.Context,
	tx *databaseTransaction,
	group domain.Group,
	memberIDs []string,
) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM group_memberships
		WHERE organization_id = $1 AND group_id = $2 AND source = 'scim'`,
		group.OrganizationID, group.ID,
	); err != nil {
		return fmt.Errorf("replace SCIM group memberships: %w", err)
	}
	for _, memberID := range memberIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_memberships (
				id, organization_id, group_id, organization_membership_id,
				source, active, created_at, updated_at
			) VALUES ($1, $2, $3, $4, 'scim', TRUE, $5, $5)`,
			a.store.newID("groupmembership"), group.OrganizationID, group.ID, memberID, group.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert SCIM group membership: %w", err)
		}
	}
	return nil
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (a *SCIMAdapter) getSCIMGroup(
	ctx context.Context,
	queryer queryRower,
	organizationID string,
	lookup string,
	value string,
) (scim.GroupResource, error) {
	condition := "g.id = $2"
	if lookup == "external" {
		condition = "g.scim_external_id = $2"
	}
	return scanSCIMGroupSnapshot(queryer.QueryRow(ctx, scimGroupSnapshotSelect+`
		WHERE g.organization_id = $1 AND `+condition+` AND g.source = 'scim'`, organizationID, value))
}

// Ordinary reads project the row version and all members from one statement
// snapshot. Do not reuse this for a locking read: after a FOR UPDATE wait the
// locked Group can be newer than a member subquery's original snapshot.
const scimGroupSnapshotSelect = `
	SELECT g.id, g.organization_id, g.display_name, g.source, g.active,
	       COALESCE(g.scim_external_id, ''), g.created_at, g.updated_at,
	       ARRAY(SELECT gm.organization_membership_id FROM group_memberships gm
	             WHERE gm.organization_id = g.organization_id AND gm.group_id = g.id
	               AND gm.source = 'scim' AND gm.active
	             ORDER BY gm.organization_membership_id)
	FROM groups g`

func scanSCIMGroupSnapshot(row rowScanner) (scim.GroupResource, error) {
	var resource scim.GroupResource
	g := &resource.Group
	err := row.Scan(&g.ID, &g.OrganizationID, &g.DisplayName, &g.Source, &g.Active,
		&g.SCIMExternalID, &g.CreatedAt, &g.UpdatedAt, &resource.MemberIDs)
	return resource, normalizeError(err)
}

func (a *SCIMAdapter) getSCIMGroupForUpdate(
	ctx context.Context,
	tx *databaseTransaction,
	organizationID string,
	lookup string,
	value string,
) (scim.GroupResource, error) {
	return a.loadSCIMGroup(ctx, tx, organizationID, lookup, value, " FOR UPDATE OF g")
}

func (a *SCIMAdapter) loadSCIMGroup(
	ctx context.Context,
	queryer queryRower,
	organizationID string,
	lookup string,
	value string,
	lockClause string,
) (scim.GroupResource, error) {
	condition := "g.id = $2"
	if lookup == "external" {
		condition = "g.scim_external_id = $2"
	}
	var group domain.Group
	err := scanGroup(queryer.QueryRow(ctx, `
		SELECT g.id, g.organization_id, g.display_name, g.source, g.active,
		       COALESCE(g.scim_external_id, ''), g.created_at, g.updated_at
		FROM groups g
		WHERE g.organization_id = $1 AND `+condition+` AND g.source = 'scim'`+lockClause,
		organizationID, value,
	), &group)
	if err != nil {
		return scim.GroupResource{}, normalizeError(err)
	}
	members, err := a.groupMemberIDs(ctx, queryer, organizationID, group.ID)
	if err != nil {
		return scim.GroupResource{}, err
	}
	return scim.GroupResource{Group: group, MemberIDs: members}, nil
}

func (a *SCIMAdapter) groupMemberIDs(
	ctx context.Context,
	queryer interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	},
	organizationID string,
	groupID string,
) ([]string, error) {
	rows, err := queryer.Query(ctx, `
		SELECT organization_membership_id
		FROM group_memberships
		WHERE organization_id = $1 AND group_id = $2 AND source = 'scim' AND active
		ORDER BY organization_membership_id`, organizationID, groupID)
	if err != nil {
		return nil, fmt.Errorf("list SCIM group members: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan SCIM group member: %w", err)
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate SCIM group members: %w", err)
	}
	return result, nil
}

func scimUserFilter(query scim.ListQuery) (string, []any, error) {
	where := "m.organization_id = $1 AND m.source = 'scim' AND m.scim_deleted_at IS NULL"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		expression := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "username":
			expression = "m.scim_user_name = lower($2)"
		case "externalid":
			expression = "m.scim_external_id = $2"
		case "emails.value":
			expression = "m.email = lower($2)"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM User filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + expression
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

func scimGroupFilter(query scim.ListQuery) (string, []any, error) {
	where := "g.organization_id = $1 AND g.source = 'scim'"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		expression := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "displayname":
			expression = "lower(g.display_name) = lower($2)"
		case "externalid":
			expression = "g.scim_external_id = $2"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM Group filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + expression
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

const scimUserSelect = `
	SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at,
	       m.id, m.organization_id, m.user_id, m.email, m.display_name, m.role, m.source, m.active,
	       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.scim_deleted_at, m.scim_oidc_provider_id,
	       m.created_at, m.updated_at
	FROM organization_memberships m
	JOIN users u ON u.id = m.user_id`

func scanSCIMUser(row rowScanner) (scim.UserResource, error) {
	var member struct {
		User       domain.User
		Membership domain.OrganizationMembership
	}
	err := row.Scan(
		&member.User.ID, &member.User.SystemRole, &member.User.Active,
		&member.User.CreatedAt, &member.User.UpdatedAt,
		&member.Membership.ID, &member.Membership.OrganizationID, &member.Membership.UserID,
		&member.Membership.Email, &member.Membership.DisplayName,
		&member.Membership.Role, &member.Membership.Source, &member.Membership.Active,
		&member.Membership.SCIMExternalID, &member.Membership.SCIMUserName,
		&member.Membership.SCIMDeletedAt, &member.Membership.SCIMOIDCProviderID,
		&member.Membership.CreatedAt, &member.Membership.UpdatedAt,
	)
	if err != nil {
		return scim.UserResource{}, normalizeError(err)
	}
	return scim.UserResource{User: member.User, Membership: member.Membership}, nil
}
