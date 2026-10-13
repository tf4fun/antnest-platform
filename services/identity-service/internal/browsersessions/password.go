package browsersessions

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type PasswordInput struct {
	RequestID        string
	ActorPrincipalID string
	UserID           string
	CurrentPassword  string
	NewPassword      string
}

type PasswordAttempt struct {
	Caller    *callercontext.Caller
	RequestID string
}

type PasswordPreparation struct {
	Matched              bool
	ExpectedPasswordHash string
	PasswordHash         string
}

// PreparePassword runs with the request context while storage owns the locked
// credential. Recheck authority after verification, before hashing a replacement.
type PreparePassword func(context.Context, domain.LocalCredential, func() error) (PasswordPreparation, error)

type PasswordOutcome struct {
	Changed bool
	Result  PasswordResult
}

type PasswordResult struct {
	Status string `json:"status"`
	localauth.LoginResult
}

func (s *Service) ChangePassword(ctx context.Context, input PasswordInput) (PasswordResult, error) {
	access, err := accessFor(ctx, input.ActorPrincipalID, input.UserID, "self")
	if err != nil {
		return PasswordResult{}, err
	}
	if !domain.ValidID(input.RequestID) || input.CurrentPassword == "" {
		return PasswordResult{}, domain.InvalidArgument("request ID and current password are required")
	}
	outcome, err := s.repository.ChangePassword(ctx, PasswordAttempt{Caller: access.Caller, RequestID: input.RequestID},
		func(original context.Context, credential domain.LocalCredential, recheckCaller func() error) (PasswordPreparation, error) {
			if credential.UserID != access.UserID {
				return PasswordPreparation{}, fmt.Errorf("password credential has inconsistent User binding")
			}
			valid, err := s.passwords.VerifyPassword(original, credential.PasswordHash, input.CurrentPassword)
			if err != nil {
				return PasswordPreparation{}, fmt.Errorf("verify current browser password: %w", err)
			}
			if err := recheckCaller(); err != nil {
				return PasswordPreparation{}, err
			}
			if !valid {
				return PasswordPreparation{}, nil
			}
			hash, err := s.passwords.HashPassword(original, input.NewPassword)
			if err != nil {
				return PasswordPreparation{}, fmt.Errorf("hash new browser password: %w", err)
			}
			return PasswordPreparation{Matched: true, ExpectedPasswordHash: credential.PasswordHash, PasswordHash: hash}, nil
		})
	if err != nil {
		return PasswordResult{}, err
	}
	if !outcome.Changed {
		return PasswordResult{}, domain.ErrInvalidCurrentPassword
	}
	return outcome.Result, nil
}
