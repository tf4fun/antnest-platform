package callercontext

import (
	"context"
	"slices"
	"time"
)

// SessionResolver lets a mutation revalidate using its own transaction after
// acquiring business locks, without borrowing a second pool connection.
type SessionResolver func(context.Context, string, time.Time) (Session, error)

// Caller retains the original signed authority. Claims are routing/audit facts;
// a mutation must call Revalidate after locks and before effects.
type Caller struct {
	authority *Authority
	token     string
	claims    Claims
}

func (a *Authority) AuthenticateSession(ctx context.Context, token string) (*Caller, error) {
	_, claims, err := a.verifySession(ctx, token, a.repository.ResolveSession)
	if err != nil {
		return nil, err
	}
	return &Caller{authority: a, token: token, claims: claims}, nil
}

func (c *Caller) Claims() Claims {
	if c == nil {
		return Claims{}
	}
	claims := c.claims
	claims.Audience = slices.Clone(claims.Audience)
	if claims.Agent != nil {
		agent := *claims.Agent
		claims.Agent = &agent
	}
	return claims
}

func (c *Caller) Revalidate(ctx context.Context, resolve SessionResolver) (Session, error) {
	if c == nil || c.authority == nil || c.token == "" || resolve == nil {
		return Session{}, ErrInvalid
	}
	session, _, err := c.authority.verifySession(ctx, c.token, resolve)
	return session, err
}

type authenticatedCallerKey struct{}

func WithCaller(ctx context.Context, caller *Caller) context.Context {
	return context.WithValue(ctx, authenticatedCallerKey{}, caller)
}

func CallerFromContext(ctx context.Context) (*Caller, error) {
	caller, err := OptionalCallerFromContext(ctx)
	if err != nil || caller == nil {
		return nil, ErrInvalid
	}
	return caller, nil
}

// OptionalCallerFromContext permits trusted internal operations without a
// browser context. A present but invalid value is never treated as absence.
// Public RPC admission must still require a verified browser context.
func OptionalCallerFromContext(ctx context.Context) (*Caller, error) {
	value := ctx.Value(authenticatedCallerKey{})
	if value == nil {
		return nil, nil
	}
	caller, ok := value.(*Caller)
	if !ok || caller == nil || caller.authority == nil || caller.token == "" {
		return nil, ErrInvalid
	}
	return caller, nil
}
