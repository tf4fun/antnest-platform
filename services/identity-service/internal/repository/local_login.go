package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func (a *LocalAuthAdapter) Login(ctx context.Context, attempt localauth.LoginAttempt, prepare localauth.PrepareLogin) (localauth.LoginOutcome, error) {
	if prepare == nil {
		return localauth.LoginOutcome{}, fmt.Errorf("local login requires credential preparation")
	}
	var outcome localauth.LoginOutcome
	err := a.store.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		// Freeze the namespace once. A rename or subsequent slug reuse cannot
		// retarget the attempt after it has selected its admission buckets.
		var organizationID string
		err := wait.wait(ctx, func(bounded context.Context) error {
			return tx.QueryRow(bounded, `SELECT id FROM organizations WHERE slug=$1`, attempt.OrganizationSlug).Scan(&organizationID)
		})
		if err != nil && (!errors.Is(err, pgx.ErrNoRows) || errors.Is(err, domain.ErrCredentialBusy)) {
			return fmt.Errorf("discover login organization: %w", err)
		}
		keys, err := loginAttemptKeys(organizationID, attempt.OrganizationSlug, attempt.Email)
		if err != nil {
			return err
		}
		admission, err := lockCredentialAttempts(ctx, tx, wait, keys)
		if err != nil {
			return err
		}
		credential, err := lockLocalLoginCredential(ctx, tx, wait, organizationID, attempt.Email)
		if err != nil {
			return err
		}
		prepared, err := prepare(ctx, credential)
		if err != nil {
			return err
		}
		if !prepared.Matched {
			// Return nil only after recording the outcome. Authentication denial
			// belongs to the service after the transaction has committed.
			return admission.recordFailure(ctx, tx, wait)
		}
		command := prepared.IssueToken
		if !credential.Principal.Active || credential.PasswordHash == "" ||
			command.Principal != credential.Principal || command.ExpectedPasswordHash != credential.PasswordHash {
			return domain.ErrUnauthenticated
		}
		if prepared.ReplacementPasswordHash != "" {
			if err := wait.wait(ctx, func(bounded context.Context) error {
				updated, err := tx.Exec(bounded, `UPDATE local_credentials SET password_hash=$3,updated_at=clock_timestamp()
					WHERE user_id=$1 AND password_hash=$2`, credential.Principal.UserID, credential.PasswordHash, prepared.ReplacementPasswordHash)
				if err != nil {
					return err
				}
				if updated.RowsAffected() != 1 {
					return domain.ErrConflict
				}
				return nil
			}); err != nil {
				return fmt.Errorf("replace verified local password: %w", err)
			}
		}
		token, err := a.store.issueLocalLoginToken(ctx, tx, wait, command)
		if err != nil {
			return err
		}
		if err := admission.resetAccount(ctx, tx, wait); err != nil {
			return err
		}
		if !localLoginTokenLive(token, a.store.browserAdmissionTime(command.IssuedAt)) {
			return domain.ErrUnauthenticated
		}
		outcome = localauth.LoginOutcome{Authenticated: true, Principal: credential.Principal, Token: token}
		return nil
	})
	if err != nil {
		// A lost commit acknowledgement may have durable effects. Never return
		// credentials or retry/compensate this outcome on an operation error.
		return localauth.LoginOutcome{}, err
	}
	if outcome.Authenticated && !localLoginTokenLive(outcome.Token, a.store.browserAdmissionTime(time.Time{})) {
		return localauth.LoginOutcome{}, domain.ErrUnauthenticated
	}
	return outcome, nil
}

func lockLocalLoginCredential(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, organizationID, email string) (localauth.LocalCredential, error) {
	if organizationID == "" {
		return localauth.LocalCredential{}, nil
	}
	var credential localauth.LocalCredential
	principal := &credential.Principal
	err := wait.wait(ctx, func(bounded context.Context) error {
		return tx.QueryRow(bounded, `SELECT user_id,id FROM organization_memberships
			WHERE organization_id=$1 AND email=$2 AND scim_deleted_at IS NULL`, organizationID, email).
			Scan(&principal.UserID, &principal.MembershipID)
	})
	if errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, domain.ErrCredentialBusy) {
		return localauth.LocalCredential{}, nil
	}
	if err != nil {
		return localauth.LocalCredential{}, fmt.Errorf("discover local login membership: %w", err)
	}
	principal.OrganizationID = organizationID
	var userActive, organizationActive, membershipActive bool
	// Preserve User -> Organization -> Membership -> credential order. Credential
	// update intent starts at its first locking read, including when two
	// Organizations authenticate the same User and both may need to rehash.
	queries := []struct {
		sql  string
		args []any
		dest []any
	}{
		{`SELECT system_role,active FROM users WHERE id=$1 FOR SHARE`, []any{principal.UserID}, []any{&principal.SystemRole, &userActive}},
		{`SELECT slug,name,active FROM organizations WHERE id=$1 FOR SHARE`, []any{organizationID}, []any{&principal.OrganizationSlug, &principal.OrganizationName, &organizationActive}},
		{`SELECT role,active FROM organization_memberships WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND email=$4 AND scim_deleted_at IS NULL FOR SHARE`, []any{principal.MembershipID, organizationID, principal.UserID, email}, []any{&principal.OrganizationRole, &membershipActive}},
		{`SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE`, []any{principal.UserID}, []any{&credential.PasswordHash}},
	}
	for _, query := range queries {
		if err := wait.wait(ctx, func(bounded context.Context) error {
			return tx.QueryRow(bounded, query.sql, query.args...).Scan(query.dest...)
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, domain.ErrCredentialBusy) {
				return localauth.LocalCredential{}, nil
			}
			return localauth.LocalCredential{}, fmt.Errorf("lock local login credential: %w", err)
		}
	}
	principal.Active = userActive && organizationActive && membershipActive
	return credential, nil
}

func (s *Store) issueLocalLoginToken(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, command localauth.IssueTokenCommand) (localauth.Token, error) {
	idleTTL := s.browserIdlePolicy()
	idle := command.IssuedAt.Add(idleTTL)
	if command.ExpiresAt.Before(idle) {
		idle = command.ExpiresAt
	}
	result := localauth.Token{ID: command.TokenID, ExpiresAt: command.ExpiresAt, IdleExpiresAt: idle, ActivityIntervalMS: browserActivityInterval(idleTTL)}
	if !localLoginTokenLive(result, s.browserAdmissionTime(command.IssuedAt)) {
		return localauth.Token{}, domain.ErrUnauthenticated
	}
	if err := wait.wait(ctx, func(bounded context.Context) error {
		return tx.QueryRow(bounded, `INSERT INTO api_tokens (
			id,token_hash,user_id,organization_id,membership_id,issued_at,expires_at,
			public_session_id,idle_expires_at,last_used_at,user_agent_hint
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10) RETURNING expires_at,idle_expires_at`,
			command.TokenID, command.TokenHash, command.Principal.UserID, command.Principal.OrganizationID,
			command.Principal.MembershipID, command.IssuedAt, command.ExpiresAt,
			s.newID("browsersession"), idle, command.UserAgentHint).Scan(&result.ExpiresAt, &result.IdleExpiresAt)
	}); err != nil {
		return localauth.Token{}, fmt.Errorf("insert API token: %w", err)
	}
	// Admit stored microsecond precision and time spent inserting. The caller
	// checks again after the event/counter writes and commit acknowledgement.
	if !localLoginTokenLive(result, s.browserAdmissionTime(command.IssuedAt)) {
		return localauth.Token{}, domain.ErrUnauthenticated
	}
	if err := wait.wait(ctx, func(bounded context.Context) error {
		return s.appendEvent(bounded, tx, event{
			OrganizationID: command.Principal.OrganizationID, ActorPrincipalID: command.Principal.UserID,
			Type: "access_token.issued", SubjectType: "access_token", SubjectID: command.TokenID,
			RequestID: command.RequestID, CreatedAt: command.IssuedAt,
		})
	}); err != nil {
		return localauth.Token{}, err
	}
	result.ExpiresAt, result.IdleExpiresAt = result.ExpiresAt.UTC(), result.IdleExpiresAt.UTC()
	return result, nil
}

func localLoginTokenLive(token localauth.Token, now time.Time) bool {
	return token.ExpiresAt.After(now) && token.IdleExpiresAt.After(now)
}
