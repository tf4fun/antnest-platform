package domain

import "time"

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
