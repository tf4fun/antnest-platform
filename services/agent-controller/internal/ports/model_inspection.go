package ports

import (
	"context"
	"time"
)

const EventModelProfileRevised = "model_profile_revised"

type ModelProfileUsage struct {
	Templates int64 `json:"templates"`
	Agents    int64 `json:"agents"`
}

type EffectiveModel struct {
	ModelProfileID string `json:"model_profile_id"`
	Revision       int64  `json:"revision"`
}

type ModelProfileRevisedEvent struct {
	EventType        string    `json:"event_type"`
	RequestID        string    `json:"request_id"`
	OrganizationID   string    `json:"organization_id"`
	ModelProfileID   string    `json:"model_profile_id"`
	RevisionID       string    `json:"revision_id"`
	PreviousRevision int64     `json:"previous_revision"`
	Revision         int64     `json:"revision"`
	OccurredAt       time.Time `json:"occurred_at"`
}

type ModelProfileEventPage struct {
	Items             []ModelProfileRevisedEvent
	NextAfterRevision *int64
}

type ModelProfileInspectionStore interface {
	GetModelProfileUsage(ctx context.Context, organizationID string, modelID string) (ModelProfileUsage, error)
	ListModelProfileEvents(ctx context.Context, organizationID string, modelID string, afterRevision int64, limit int) ([]ModelProfileRevisedEvent, error)
}
