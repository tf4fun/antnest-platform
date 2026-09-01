package ports

import "context"

type IdentityPrincipal struct {
	UserID         string
	OrganizationID string
	MembershipID   string
	Active         bool
}

type IdentityDirectory interface {
	ResolvePrincipal(context.Context, string, string) (IdentityPrincipal, error)
}
