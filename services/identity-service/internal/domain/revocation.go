package domain

import "time"

type OwnerAuthorization struct {
	UserID                 string `json:"user_id"`
	OrganizationID         string `json:"organization_id"`
	MembershipID           string `json:"membership_id"`
	Active                 bool   `json:"active"`
	LastRevocationSequence int64  `json:"last_revocation_sequence"`
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
	Events       []PrincipalRevocation `json:"events"`
	NextSequence int64                 `json:"next_sequence"`
}

// Session revocations are private Gateway notifications, separate from owner
// offboarding. A session-only event must never disable an owned Agent.
type SessionRevocation struct {
	Sequence       int64     `json:"sequence"`
	TokenID        string    `json:"token_id"`
	UserID         string    `json:"user_id"`
	OrganizationID string    `json:"organization_id"`
	Reason         string    `json:"reason"`
	OccurredAt     time.Time `json:"occurred_at"`
	TraceParent    string    `json:"traceparent,omitempty"`
}

type SessionRevocationPage struct {
	Events       []SessionRevocation `json:"events"`
	NextSequence int64               `json:"next_sequence"`
}
