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
