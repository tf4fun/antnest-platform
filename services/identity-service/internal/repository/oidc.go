package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

type OIDCAdapter struct{ store *Store }

func (a *OIDCAdapter) GetPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return a.store.getPrincipal(ctx, a.store.pool, userID, organizationID)
}

func (a *OIDCAdapter) FindProvider(
	ctx context.Context,
	organizationID string,
	name string,
) (oidcflow.ProviderWithSecret, error) {
	return scanProviderRow(a.store.pool.QueryRow(ctx, providerSelect+`
			WHERE p.organization_id = $1 AND p.name = $2`, organizationID, name))
}

func (a *OIDCAdapter) FindLoginProvider(
	ctx context.Context,
	organizationSlug string,
	name string,
) (oidcflow.ProviderWithSecret, error) {
	return scanProviderRow(a.store.pool.QueryRow(ctx, providerSelect+`
			JOIN organizations o ON o.id = p.organization_id
			WHERE o.slug = $1 AND o.active AND p.name = $2`, organizationSlug, name))
}

func (a *OIDCAdapter) GetProvider(ctx context.Context, providerID string) (oidcflow.ProviderWithSecret, error) {
	return scanProviderRow(a.store.pool.QueryRow(ctx, providerSelect+` WHERE p.id = $1`, providerID))
}

func (a *OIDCAdapter) HasSubjectRecord(ctx context.Context, providerID, subject string) (bool, error) {
	var exists bool
	err := a.store.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM external_identities WHERE provider_id=$1 AND subject=$2)`, providerID, subject).Scan(&exists)
	return exists, err
}

func (a *OIDCAdapter) UpsertProvider(
	ctx context.Context,
	command oidcflow.UpsertProviderCommand,
) (oidcflow.Provider, error) {
	provider := command.Provider.Provider
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := a.lockProviderConfiguration(ctx, tx, provider); err != nil {
			return err
		}
		if err := a.store.requireSystemAdmin(ctx, tx, command.ActorPrincipalID); err != nil {
			return err
		}
		if err := a.store.revalidateDirectoryCaller(ctx, tx, command.ActorPrincipalID, provider.OrganizationID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO oidc_providers (
				id, organization_id, name, display_name, issuer, client_id,
				client_secret_ciphertext, client_secret_nonce, scopes, enabled, revision,
				authorization_endpoint, token_endpoint, token_endpoint_auth_method,
				id_token_signing_algs, userinfo_endpoint, jwks_uri, created_at, updated_at,
				client_secret_key_id, client_secret_wrapped_data_key,
				link_policy, link_domains, authoritative, link_policy_review_required
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
			)
			ON CONFLICT (organization_id, name) DO UPDATE SET
				display_name = EXCLUDED.display_name,
				issuer = EXCLUDED.issuer,
				client_id = EXCLUDED.client_id,
				client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
				client_secret_nonce = EXCLUDED.client_secret_nonce,
				client_secret_key_id = EXCLUDED.client_secret_key_id,
				client_secret_wrapped_data_key = EXCLUDED.client_secret_wrapped_data_key,
				scopes = EXCLUDED.scopes,
				enabled = EXCLUDED.enabled,
				link_policy = EXCLUDED.link_policy,
				link_domains = EXCLUDED.link_domains,
				authoritative = EXCLUDED.authoritative,
				link_policy_review_required = EXCLUDED.link_policy_review_required,
				revision = oidc_providers.revision + 1,
				authorization_endpoint = EXCLUDED.authorization_endpoint,
				token_endpoint = EXCLUDED.token_endpoint,
				token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
				id_token_signing_algs = EXCLUDED.id_token_signing_algs,
				userinfo_endpoint = EXCLUDED.userinfo_endpoint,
				jwks_uri = EXCLUDED.jwks_uri,
				updated_at = EXCLUDED.updated_at
			WHERE oidc_providers.issuer = EXCLUDED.issuer
			  AND oidc_providers.client_id = EXCLUDED.client_id
			  AND oidc_providers.revision = EXCLUDED.revision - 1
			RETURNING id, created_at, revision`,
			provider.ID, provider.OrganizationID, provider.Name, provider.DisplayName,
			provider.Issuer, provider.ClientID, provider.ClientSecret.Ciphertext,
			provider.ClientSecret.Nonce, provider.Scopes, provider.Enabled, provider.Revision,
			provider.AuthorizationEndpoint, provider.TokenEndpoint, provider.TokenEndpointAuthMethod,
			provider.IDTokenSigningAlgs, provider.UserInfoEndpoint, provider.JWKSURI,
			provider.CreatedAt, provider.UpdatedAt, provider.ClientSecret.KeyID, provider.ClientSecret.WrappedDataKey,
			provider.LinkPolicy, provider.LinkDomains, provider.Authoritative, provider.LinkPolicyReviewRequired,
		).Scan(&provider.ID, &provider.CreatedAt, &provider.Revision); err != nil {
			if err == pgx.ErrNoRows {
				var current oidcflow.Provider
				if lookupErr := tx.QueryRow(ctx, `
					SELECT issuer, client_id
					FROM oidc_providers
					WHERE organization_id = $1 AND name = $2
					FOR UPDATE`, provider.OrganizationID, provider.Name,
				).Scan(&current.Issuer, &current.ClientID); lookupErr != nil {
					return lookupErr
				}
				if err := current.ValidateRegistration(provider.Issuer, provider.ClientID); err != nil {
					return err
				}
				return domain.ErrVersionConflict
			}
			return fmt.Errorf("upsert OIDC provider: %w", err)
		}
		if err := a.store.revalidateDirectoryCaller(ctx, tx, command.ActorPrincipalID, provider.OrganizationID); err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: provider.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
			Type: "oidc_provider.upserted", SubjectType: "oidc_provider", SubjectID: provider.ID,
			RequestID: command.RequestID, CreatedAt: provider.UpdatedAt,
		})
	})
	return provider, err
}

func (a *OIDCAdapter) SetProviderEnabled(
	ctx context.Context,
	command oidcflow.SetProviderEnabledCommand,
) (oidcflow.Provider, error) {
	var provider oidcflow.Provider
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		stored, err := scanProviderRow(tx.QueryRow(ctx, providerSelect+`
			WHERE p.organization_id = $1 AND p.name = $2
			FOR UPDATE`, command.OrganizationID, command.Name))
		if err != nil {
			return err
		}
		provider = stored.Provider
		if err := a.store.requireSystemAdmin(ctx, tx, command.ActorPrincipalID); err != nil {
			return err
		}
		if err := a.store.revalidateDirectoryCaller(ctx, tx, command.ActorPrincipalID, command.OrganizationID); err != nil {
			return err
		}
		if provider.Enabled == command.Enabled {
			return nil
		}
		if _, err := tx.Exec(ctx, `
			UPDATE oidc_providers
			SET enabled = $3, revision = revision + 1, updated_at = $4
			WHERE organization_id = $1 AND name = $2`,
			command.OrganizationID, command.Name, command.Enabled, command.UpdatedAt,
		); err != nil {
			return fmt.Errorf("set OIDC provider enabled state: %w", err)
		}
		provider.Enabled = command.Enabled
		provider.Revision++
		provider.UpdatedAt = command.UpdatedAt
		eventType := "oidc_provider.disabled"
		if command.Enabled {
			eventType = "oidc_provider.enabled"
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: provider.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
			Type: eventType, SubjectType: "oidc_provider", SubjectID: provider.ID,
			RequestID: command.RequestID, CreatedAt: command.UpdatedAt,
		})
	})
	return provider, err
}

func (a *OIDCAdapter) lockProviderConfiguration(ctx context.Context, tx *databaseTransaction, provider oidcflow.Provider) error {
	// Serialize new registrations per organization before taking actor locks.
	// A missing row cannot be locked; this also prevents a concurrent name or
	// issuer conflict from acquiring a Provider lock after its User parent.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('identity-oidc-provider:' || $1, 0))`, provider.OrganizationID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM oidc_providers
		WHERE organization_id=$1 AND (name=$2 OR issuer=$3) ORDER BY id FOR UPDATE`, provider.OrganizationID, provider.Name, provider.Issuer)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (a *OIDCAdapter) ListProviders(ctx context.Context, organizationID string) ([]oidcflow.Provider, error) {
	rows, err := a.store.pool.Query(ctx, providerMetadataSelect+`
			WHERE p.organization_id = $1
			ORDER BY p.display_name, p.name`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("list OIDC Providers: %w", err)
	}
	defer rows.Close()
	providers := make([]oidcflow.Provider, 0)
	for rows.Next() {
		provider, err := scanProviderMetadata(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate OIDC Providers: %w", err)
	}
	return providers, nil
}

func (a *OIDCAdapter) ListLoginMethods(ctx context.Context, organizationSlug string) ([]oidcflow.LoginMethod, error) {
	rows, err := a.store.pool.Query(ctx, `
			SELECT p.name, p.display_name
			FROM oidc_providers p
			JOIN organizations o ON o.id = p.organization_id
			WHERE o.slug = $1 AND o.active AND p.enabled
			ORDER BY p.display_name, p.name`, organizationSlug)
	if err != nil {
		return nil, fmt.Errorf("list OIDC login methods: %w", err)
	}
	defer rows.Close()
	methods := make([]oidcflow.LoginMethod, 0)
	for rows.Next() {
		var method oidcflow.LoginMethod
		if err := rows.Scan(&method.Name, &method.DisplayName); err != nil {
			return nil, fmt.Errorf("scan OIDC login method: %w", err)
		}
		methods = append(methods, method)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate OIDC login methods: %w", err)
	}
	return methods, nil
}

func (a *OIDCAdapter) CreateSession(ctx context.Context, command oidcflow.CreateSessionCommand) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		session := command.Session
		if _, err := tx.Exec(ctx, `
			INSERT INTO oidc_auth_sessions (
				id, provider_id, organization_id, provider_revision, state_hash, request_id, status,
				secret_ciphertext, secret_nonce, expires_at, created_at, updated_at, secret_key_id, secret_wrapped_data_key, user_agent_hint
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14)`,
			session.ID, session.ProviderID, session.OrganizationID, session.ProviderRevision,
			command.StateHash, command.RequestID, session.Status,
			session.Secrets.Ciphertext, session.Secrets.Nonce, session.ExpiresAt, session.CreatedAt, session.Secrets.KeyID, session.Secrets.WrappedDataKey, session.UserAgentHint,
		); err != nil {
			return fmt.Errorf("insert OIDC session: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: session.OrganizationID, Type: "oidc_login.started",
			SubjectType: "oidc_auth_session", SubjectID: session.ID,
			RequestID: command.RequestID, CreatedAt: session.CreatedAt,
		})
	})
}

func (a *OIDCAdapter) ClaimSession(
	ctx context.Context,
	stateHash string,
	claimID string,
	now time.Time,
) (oidcflow.SessionClaim, error) {
	var result oidcflow.SessionClaim
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		session, completed, err := a.sessionByState(ctx, tx, stateHash, now)
		if err != nil {
			return err
		}
		now = a.store.browserAdmissionTime(now)
		switch session.Status {
		case oidcflow.SessionStatusCompleted:
			result = oidcflow.SessionClaim{Disposition: oidcflow.ClaimCompleted, Session: session, Completed: completed}
			return nil
		case oidcflow.SessionStatusFailed:
			return domain.NewError("oidc_session_failed", "OIDC login failed and must be restarted", false)
		case oidcflow.SessionStatusExchanging:
			if !session.ExpiresAt.After(now) {
				return a.expireOIDCSession(ctx, tx, session, now, &result)
			}
			return domain.NewError("oidc_exchange_in_progress", "OIDC login callback is already being processed", false)
		case oidcflow.SessionStatusPending:
			if !session.ExpiresAt.After(now) {
				return a.expireOIDCSession(ctx, tx, session, now, &result)
			}
		default:
			return fmt.Errorf("unknown OIDC session status %q", session.Status)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE oidc_auth_sessions
			SET status = 'exchanging', claim_id = $2, claimed_at = $3, updated_at = $3
			WHERE id = $1`, session.ID, claimID, now); err != nil {
			return fmt.Errorf("claim OIDC session: %w", err)
		}
		session.Status = oidcflow.SessionStatusExchanging
		result = oidcflow.SessionClaim{Disposition: oidcflow.ClaimAcquired, Session: session}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: session.OrganizationID, Type: "oidc_login.claimed",
			SubjectType: "oidc_auth_session", SubjectID: session.ID,
			RequestID: session.RequestID, CreatedAt: now,
		})
	})
	return result, err
}

func (a *OIDCAdapter) expireOIDCSession(
	ctx context.Context,
	tx *databaseTransaction,
	session oidcflow.AuthSession,
	now time.Time,
	result *oidcflow.SessionClaim,
) error {
	if _, err := tx.Exec(ctx, `
		UPDATE oidc_auth_sessions
		SET status = 'failed', failure_stage = 'expired', failure_reason = 'session expired',
		    failed_at = $2, updated_at = $2
		WHERE id = $1`, session.ID, now); err != nil {
		return fmt.Errorf("expire OIDC session: %w", err)
	}
	if err := a.store.appendEvent(ctx, tx, event{
		OrganizationID: session.OrganizationID, Type: "oidc_login.expired",
		SubjectType: "oidc_auth_session", SubjectID: session.ID,
		RequestID: session.RequestID, CreatedAt: now,
	}); err != nil {
		return err
	}
	*result = oidcflow.SessionClaim{Disposition: oidcflow.ClaimExpired, Session: session}
	return nil
}

func (a *OIDCAdapter) CompleteLogin(
	ctx context.Context,
	command oidcflow.CompleteLoginCommand,
) (oidcflow.CompletedLogin, error) {
	idleTTL := a.store.browserIdlePolicy()
	idle := command.IssuedAt.Add(idleTTL)
	if command.ExpiresAt.Before(idle) {
		idle = command.ExpiresAt
	}
	var result oidcflow.CompletedLogin
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var status oidcflow.SessionStatus
		var providerID, organizationID, claimID, requestID string
		var sessionProviderRevision int64
		var sessionExpiresAt time.Time
		var userAgentHint string
		if err := tx.QueryRow(ctx, `
			SELECT s.status, s.provider_id, s.organization_id, COALESCE(s.claim_id, ''), s.request_id,
			       s.provider_revision, s.expires_at, s.user_agent_hint
			FROM oidc_auth_sessions s
			WHERE s.id = $1
			FOR UPDATE OF s`, command.SessionID,
		).Scan(
			&status, &providerID, &organizationID, &claimID, &requestID,
			&sessionProviderRevision, &sessionExpiresAt, &userAgentHint,
		); err != nil {
			return err
		}
		if status != oidcflow.SessionStatusExchanging || claimID != command.ClaimID ||
			providerID != command.ProviderID || organizationID != command.OrganizationID {
			return domain.NewError("oidc_exchange_claim_invalid", "OIDC callback claim is invalid", false)
		}
		provider, err := scanProviderMetadata(tx.QueryRow(ctx, providerMetadataSelect+`
			WHERE p.id=$1 AND p.organization_id=$2 FOR UPDATE`, providerID, organizationID))
		if err != nil {
			return err
		}
		if sessionProviderRevision != provider.Revision {
			return domain.NewError("oidc_provider_changed", "OIDC Provider changed; restart login", false)
		}
		if !provider.Enabled || command.Identity.Issuer != provider.Issuer || !oidcflow.ValidSubject(command.Identity.Subject) {
			return domain.ErrForbidden
		}
		command.Identity.Email, _ = domain.NormalizeEmail(command.Identity.Email)

		principal, externalIdentityID, err := a.resolveOIDCIdentity(ctx, tx, command, provider)
		if err != nil {
			return err
		}
		// Both the Provider/session and identity rows can wait on other writers.
		// Sample the clock after those waits, not the caller's admission timestamp.
		now := a.store.browserAdmissionTime(command.IssuedAt)
		if !sessionExpiresAt.After(now) {
			return domain.NewError("oidc_session_expired", "OIDC login session expired", false)
		}
		if !command.ExpiresAt.After(now) || !idle.After(now) {
			return domain.ErrUnauthenticated
		}
		result = oidcflow.CompletedLogin{
			SessionID: command.SessionID, TokenID: command.AccessTokenID,
			Principal: principal, ActivityIntervalMS: browserActivityInterval(idleTTL),
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO api_tokens (
				id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at,
				public_session_id, idle_expires_at, last_used_at, user_agent_hint
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $10)
			RETURNING expires_at, idle_expires_at`,
			command.AccessTokenID, command.AccessTokenHash, principal.UserID,
			principal.OrganizationID, principal.MembershipID, command.IssuedAt, command.ExpiresAt,
			a.store.newID("browsersession"), idle, userAgentHint,
		).Scan(&result.ExpiresAt, &result.IdleExpiresAt); err != nil {
			return fmt.Errorf("insert OIDC access token: %w", err)
		}
		now = a.store.browserAdmissionTime(now)
		if !sessionExpiresAt.After(now) {
			return domain.NewError("oidc_session_expired", "OIDC login session expired", false)
		}
		if !result.ExpiresAt.After(now) || !result.IdleExpiresAt.After(now) {
			return domain.ErrUnauthenticated
		}
		if _, err := tx.Exec(ctx, `
			UPDATE oidc_auth_sessions
			SET status = 'completed', completed_user_id = $2, completed_membership_id = $3,
			    completed_access_token_id = $4, completed_at = $5, updated_at = $5
			WHERE id = $1`, command.SessionID, principal.UserID, principal.MembershipID,
			command.AccessTokenID, command.IssuedAt,
		); err != nil {
			return fmt.Errorf("complete OIDC session: %w", err)
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, ActorPrincipalID: principal.UserID,
			Type: "oidc_login.completed", SubjectType: "oidc_auth_session", SubjectID: command.SessionID,
			RequestID: requestID, CreatedAt: command.IssuedAt,
			Metadata: map[string]any{"external_identity_id": externalIdentityID, "token_id": command.AccessTokenID},
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return oidcflow.CompletedLogin{}, err
	}
	result.ExpiresAt = result.ExpiresAt.UTC()
	result.IdleExpiresAt = result.IdleExpiresAt.UTC()
	return result, nil
}

func (a *OIDCAdapter) FailSession(ctx context.Context, command oidcflow.FailSessionCommand) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var organizationID, requestID string
		result, err := tx.Exec(ctx, `
			UPDATE oidc_auth_sessions
			SET status = 'failed', failure_stage = $3, failure_reason = $4,
			    failed_at = $5, updated_at = $5
			WHERE id = $1 AND status = 'exchanging' AND claim_id = $2`,
			command.SessionID, command.ClaimID, command.Stage, command.Reason, command.FailedAt,
		)
		if err != nil {
			return fmt.Errorf("fail OIDC session: %w", err)
		}
		if result.RowsAffected() != 1 {
			return domain.NewError("oidc_exchange_claim_invalid", "OIDC callback claim is invalid", false)
		}
		if err := tx.QueryRow(ctx, `
			SELECT organization_id, request_id FROM oidc_auth_sessions WHERE id = $1`,
			command.SessionID,
		).Scan(&organizationID, &requestID); err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, Type: "oidc_login.failed",
			SubjectType: "oidc_auth_session", SubjectID: command.SessionID,
			RequestID: requestID, Metadata: map[string]any{"stage": command.Stage}, CreatedAt: command.FailedAt,
		})
	})
}

func (a *OIDCAdapter) resolveOIDCIdentity(
	ctx context.Context,
	tx *databaseTransaction,
	command oidcflow.CompleteLoginCommand,
	provider oidcflow.Provider,
) (domain.Principal, string, error) {
	var externalID, userID, membershipID string
	err := tx.QueryRow(ctx, `
		SELECT id, user_id, membership_id
		FROM external_identities
		WHERE provider_id = $1 AND subject = $2`, command.ProviderID, command.Identity.Subject,
	).Scan(&externalID, &userID, &membershipID)
	if err == nil {
		principal, principalErr := a.ensureOIDCMembership(
			ctx,
			tx,
			userID,
			command.OrganizationID,
			membershipID,
			"",
		)
		if principalErr != nil {
			return domain.Principal{}, "", principalErr
		}
		// Reprovisioning locks parents before updating external identities. Do
		// not hold a mapping lock while waiting for those same parent rows.
		var currentExternalID, currentUserID, currentMembershipID string
		err := tx.QueryRow(ctx, `
			SELECT id, user_id, membership_id FROM external_identities
			WHERE provider_id = $1 AND subject = $2 FOR UPDATE`, command.ProviderID, command.Identity.Subject).
			Scan(&currentExternalID, &currentUserID, &currentMembershipID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, "", err
		}
		if err != nil || currentExternalID != externalID || currentUserID != userID || currentMembershipID != membershipID {
			return domain.Principal{}, "", oidcMembershipRequired()
		}
		return principal, externalID, nil
	}
	if err != pgx.ErrNoRows {
		return domain.Principal{}, "", fmt.Errorf("find external identity: %w", err)
	}
	if !provider.AllowsAutomaticLink(command.Identity, domain.OrganizationRoleMember) {
		return domain.Principal{}, "", oidcMembershipRequired()
	}

	userID, membershipID, err = a.findOIDCUser(ctx, tx, command)
	if err != nil {
		return domain.Principal{}, "", err
	}
	principal, err := a.ensureOIDCMembership(ctx, tx, userID, command.OrganizationID, membershipID, command.Identity.Email)
	if err != nil {
		return domain.Principal{}, "", err
	}
	if !provider.AllowsAutomaticLink(command.Identity, principal.OrganizationRole) {
		return domain.Principal{}, "", oidcMembershipRequired()
	}
	externalID = a.store.newID("externalidentity")
	if _, err := tx.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
		externalID, command.OrganizationID, command.ProviderID, userID,
		principal.MembershipID, command.Identity.Subject, command.IssuedAt,
	); err != nil {
		return domain.Principal{}, "", fmt.Errorf("insert external identity: %w", err)
	}
	return principal, externalID, nil
}

func (a *OIDCAdapter) findOIDCUser(
	ctx context.Context,
	tx *databaseTransaction,
	command oidcflow.CompleteLoginCommand,
) (string, string, error) {
	var userID, membershipID string
	// Discover identifiers without locking a Membership before its parents.
	// The original email and both identifiers are revalidated under ordered locks.
	err := tx.QueryRow(ctx, `
		SELECT m.user_id, m.id
		FROM organization_memberships m
		WHERE m.organization_id = $1 AND m.email = $2 AND m.scim_deleted_at IS NULL`,
		command.OrganizationID, command.Identity.Email,
	).Scan(&userID, &membershipID)
	if err == nil {
		return userID, membershipID, nil
	}
	if err != pgx.ErrNoRows {
		return "", "", fmt.Errorf("find user for external identity: %w", err)
	}
	return "", "", oidcMembershipRequired()
}

func (a *OIDCAdapter) ensureOIDCMembership(
	ctx context.Context,
	tx *databaseTransaction,
	userID string,
	organizationID string,
	expectedMembershipID string,
	expectedEmail string,
) (domain.Principal, error) {
	var principal domain.Principal
	var userActive, membershipActive, organizationActive bool
	// Explicit statements make User -> Organization -> Membership independent
	// of PostgreSQL's join/row-mark order and protect issuance through commit.
	if err := tx.QueryRow(ctx, `SELECT id, system_role, active FROM users WHERE id = $1 FOR UPDATE`, userID).
		Scan(&principal.UserID, &principal.SystemRole, &userActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, oidcMembershipRequired()
		}
		return domain.Principal{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT id, active, slug, name FROM organizations WHERE id = $1 FOR UPDATE`, organizationID).
		Scan(&principal.OrganizationID, &organizationActive, &principal.OrganizationSlug, &principal.OrganizationName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, oidcMembershipRequired()
		}
		return domain.Principal{}, err
	}
	if err := tx.QueryRow(ctx, `
		SELECT id, role, active FROM organization_memberships
		WHERE user_id = $1 AND organization_id = $2 AND id = $3 AND scim_deleted_at IS NULL
		  AND ($4 = '' OR email = $4)
		FOR UPDATE`, userID, organizationID, expectedMembershipID, expectedEmail).
		Scan(&principal.MembershipID, &principal.OrganizationRole, &membershipActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, oidcMembershipRequired()
		}
		return domain.Principal{}, err
	}
	principal.Active = userActive && membershipActive && organizationActive
	if !principal.Active || principal.SystemRole != domain.SystemRoleUser {
		return domain.Principal{}, domain.ErrForbidden
	}
	return principal, nil
}

func oidcMembershipRequired() error {
	return domain.NewError(
		"oidc_membership_required",
		"OIDC identity must match an existing active Organization Membership",
		false,
	)
}

func (a *OIDCAdapter) sessionByState(
	ctx context.Context,
	tx *databaseTransaction,
	stateHash string,
	now time.Time,
) (oidcflow.AuthSession, oidcflow.CompletedLogin, error) {
	var session oidcflow.AuthSession
	var completed oidcflow.CompletedLogin
	var userID, membershipID, tokenID string
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.request_id, s.provider_id, s.organization_id, s.provider_revision, s.status,
		       s.secret_ciphertext, s.secret_nonce, s.expires_at,
		       COALESCE(s.completed_user_id, ''), COALESCE(s.completed_membership_id, ''),
		       COALESCE(s.completed_access_token_id, ''),
		       s.secret_key_id, s.secret_wrapped_data_key, s.user_agent_hint
		FROM oidc_auth_sessions s
		WHERE s.state_hash = $1
		FOR UPDATE OF s`, stateHash,
	).Scan(
		&session.ID, &session.RequestID, &session.ProviderID, &session.OrganizationID,
		&session.ProviderRevision, &session.Status,
		&session.Secrets.Ciphertext, &session.Secrets.Nonce, &session.ExpiresAt,
		&userID, &membershipID, &tokenID,
		&session.Secrets.KeyID, &session.Secrets.WrappedDataKey, &session.UserAgentHint,
	)
	if err != nil {
		return oidcflow.AuthSession{}, oidcflow.CompletedLogin{}, err
	}
	if session.Status == oidcflow.SessionStatusCompleted {
		// A joined query can retain pre-wait authority for rows it did not lock.
		// Resolve the original SID in a new statement after acquiring the state
		// row, without recording activity or taking parent locks in reverse order.
		live, err := a.store.resolveBrowserSession(ctx, tx, "id", tokenID, now)
		if err != nil && !errors.Is(err, domain.ErrNotFound) {
			return oidcflow.AuthSession{}, oidcflow.CompletedLogin{}, err
		}
		if err != nil || !live.Principal.Active || live.Principal.UserID != userID ||
			live.Principal.OrganizationID != session.OrganizationID || live.Principal.MembershipID != membershipID {
			return oidcflow.AuthSession{}, oidcflow.CompletedLogin{}, domain.NewError(
				"oidc_completed_token_unavailable",
				"The completed OIDC login token is no longer available",
				false,
			)
		}
		completed = oidcflow.CompletedLogin{
			SessionID: session.ID, TokenID: tokenID,
			Principal: live.Principal, ExpiresAt: live.ExpiresAt,
			IdleExpiresAt: live.IdleExpiresAt, ActivityIntervalMS: live.ActivityIntervalMS,
		}
	}
	return session, completed, nil
}

const providerSelect = `
	SELECT p.id, p.organization_id, p.name, p.display_name, p.issuer, p.client_id,
	       p.client_secret_ciphertext, p.client_secret_nonce, p.scopes,
	       p.enabled, p.revision, p.authorization_endpoint, p.token_endpoint,
	       p.token_endpoint_auth_method, p.id_token_signing_algs, p.userinfo_endpoint,
	       p.jwks_uri, p.created_at, p.updated_at, p.client_secret_key_id, p.client_secret_wrapped_data_key,
	       p.link_policy, p.link_domains, p.authoritative, p.link_policy_review_required
	FROM oidc_providers p`

const providerMetadataSelect = `
	SELECT p.id, p.organization_id, p.name, p.display_name, p.issuer, p.client_id,
	       p.scopes, p.enabled, p.revision, p.authorization_endpoint, p.token_endpoint,
	       p.token_endpoint_auth_method, p.id_token_signing_algs, p.userinfo_endpoint,
	       p.jwks_uri, p.created_at, p.updated_at,
	       p.link_policy, p.link_domains, p.authoritative, p.link_policy_review_required
	FROM oidc_providers p`

func scanProviderRow(row rowScanner) (oidcflow.ProviderWithSecret, error) {
	var provider oidcflow.ProviderWithSecret
	err := row.Scan(
		&provider.ID, &provider.OrganizationID, &provider.Name, &provider.DisplayName,
		&provider.Issuer, &provider.ClientID, &provider.ClientSecret.Ciphertext,
		&provider.ClientSecret.Nonce, &provider.Scopes, &provider.Enabled, &provider.Revision,
		&provider.AuthorizationEndpoint, &provider.TokenEndpoint, &provider.TokenEndpointAuthMethod,
		&provider.IDTokenSigningAlgs, &provider.UserInfoEndpoint,
		&provider.JWKSURI, &provider.CreatedAt, &provider.UpdatedAt, &provider.ClientSecret.KeyID, &provider.ClientSecret.WrappedDataKey,
		&provider.LinkPolicy, &provider.LinkDomains, &provider.Authoritative, &provider.LinkPolicyReviewRequired,
	)
	if err != nil {
		return oidcflow.ProviderWithSecret{}, normalizeError(err)
	}
	return provider, nil
}

func scanProviderMetadata(row rowScanner) (oidcflow.Provider, error) {
	var provider oidcflow.Provider
	err := row.Scan(
		&provider.ID, &provider.OrganizationID, &provider.Name, &provider.DisplayName,
		&provider.Issuer, &provider.ClientID, &provider.Scopes, &provider.Enabled,
		&provider.Revision, &provider.AuthorizationEndpoint, &provider.TokenEndpoint,
		&provider.TokenEndpointAuthMethod, &provider.IDTokenSigningAlgs,
		&provider.UserInfoEndpoint, &provider.JWKSURI, &provider.CreatedAt, &provider.UpdatedAt,
		&provider.LinkPolicy, &provider.LinkDomains, &provider.Authoritative, &provider.LinkPolicyReviewRequired,
	)
	if err != nil {
		return oidcflow.Provider{}, normalizeError(err)
	}
	return provider, nil
}
