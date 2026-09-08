package ports

import (
	"context"
	"time"
)

type IdentityPrincipal struct {
	UserID                 string
	OrganizationID         string
	MembershipID           string
	Active                 bool
	LastRevocationSequence int64
}

type OwnerAuthorizationSource interface {
	ResolveOwnerAuthorization(context.Context, string, string) (IdentityPrincipal, error)
}

type PrincipalRevocation struct {
	Sequence       int64     `json:"sequence"`
	UserID         string    `json:"user_id"`
	OrganizationID string    `json:"organization_id,omitempty"`
	Reason         string    `json:"reason"`
	OccurredAt     time.Time `json:"occurred_at"`
	TraceParent    string    `json:"traceparent,omitempty"`
}

type PrincipalRevocationPage struct {
	Events       []PrincipalRevocation
	NextSequence int64
}

type IdentityRevocationSource interface {
	ListPrincipalRevocations(context.Context, int64, int) (PrincipalRevocationPage, error)
}

type PendingOwnerRevocation struct {
	AgentID           string
	Sequence          int64
	AggregateSequence int64
	TraceParent       string
}

type IdentityRevocationStore interface {
	GetIdentityRevocationCursor(context.Context) (int64, error)
	ApplyIdentityRevocation(context.Context, int64, PrincipalRevocation, string) error
	ListPendingOwnerRevocations(context.Context, string, int) ([]PendingOwnerRevocation, error)
}

type IdentityDirectory interface {
	ResolvePrincipal(context.Context, string, string) (IdentityPrincipal, error)
}
