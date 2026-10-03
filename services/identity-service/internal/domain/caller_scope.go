package domain

import "context"

type callerOrganizationKey struct{}

// Only the authenticated transport sets this scope; body IDs cannot widen it.
func WithCallerOrganization(ctx context.Context, organizationID string) context.Context {
	return context.WithValue(ctx, callerOrganizationKey{}, organizationID)
}

func CheckCallerOrganization(ctx context.Context, organizationID string) error {
	if scope, present := ctx.Value(callerOrganizationKey{}).(string); present && scope != organizationID {
		return NewError("caller_context_invalid", "Caller context target scope is invalid", false)
	}
	return nil
}
