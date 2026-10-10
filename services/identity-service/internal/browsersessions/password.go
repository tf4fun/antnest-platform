package browsersessions

import (
	"context"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
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

type PasswordCommand struct {
	Caller               *callercontext.Caller
	RequestID            string
	ExpectedPasswordHash string
	PasswordHash         string
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
	credential, err := s.repository.GetLocalCredential(ctx, access.UserID)
	if errors.Is(err, domain.ErrNotFound) {
		return PasswordResult{}, domain.InvalidArgument("Local password is not available for this account")
	}
	if err != nil {
		return PasswordResult{}, fmt.Errorf("load browser password credential: %w", err)
	}
	if credential.UserID != access.UserID {
		return PasswordResult{}, fmt.Errorf("password credential has inconsistent User binding")
	}
	valid, err := credentials.VerifyPassword(credential.PasswordHash, input.CurrentPassword)
	if err != nil {
		return PasswordResult{}, fmt.Errorf("verify current browser password: %w", err)
	}
	if !valid {
		return PasswordResult{}, domain.ErrInvalidCurrentPassword
	}
	hash, err := credentials.HashPassword(input.NewPassword)
	if err != nil {
		return PasswordResult{}, domain.InvalidArgument(err.Error())
	}
	return s.repository.ChangePassword(ctx, PasswordCommand{Caller: access.Caller, RequestID: input.RequestID, ExpectedPasswordHash: credential.PasswordHash, PasswordHash: hash})
}
