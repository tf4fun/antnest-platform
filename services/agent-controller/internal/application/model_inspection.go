package application

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const (
	defaultModelProfileEventPageSize = 50
	maximumModelProfileEventPageSize = 100
)

func (service *CatalogService) inspectionStore() (ports.ModelProfileInspectionStore, error) {
	store, ok := service.store.(ports.ModelProfileInspectionStore)
	if !ok {
		return nil, fmt.Errorf("%w: ModelProfile inspection is unsupported", ErrQueryContract)
	}
	return store, nil
}

func (service *CatalogService) GetModelProfileUsage(
	ctx context.Context, organizationID string, modelProfileID string,
) (ports.ModelProfileUsage, error) {
	if !validIdentifier(organizationID) || !validIdentifier(modelProfileID) {
		return ports.ModelProfileUsage{}, fmt.Errorf("%w: ModelProfile scope", ErrInvalidInput)
	}
	store, err := service.inspectionStore()
	if err != nil {
		return ports.ModelProfileUsage{}, err
	}
	usage, err := store.GetModelProfileUsage(ctx, organizationID, modelProfileID)
	if err != nil {
		return ports.ModelProfileUsage{}, fmt.Errorf("load ModelProfile usage: %w", err)
	}
	if usage.Templates < 0 || usage.Templates > domain.MaximumSafeInteger ||
		usage.Agents < 0 || usage.Agents > domain.MaximumSafeInteger {
		return ports.ModelProfileUsage{}, fmt.Errorf("%w: invalid ModelProfile usage counts", ErrQueryContract)
	}
	return usage, nil
}

func (service *CatalogService) ListModelProfileEvents(
	ctx context.Context, organizationID string, modelProfileID string, afterRevision int64, limit int,
) (ports.ModelProfileEventPage, error) {
	if !validIdentifier(organizationID) || !validIdentifier(modelProfileID) {
		return ports.ModelProfileEventPage{}, fmt.Errorf("%w: ModelProfile scope", ErrInvalidInput)
	}
	if afterRevision < 0 || afterRevision > domain.MaximumSafeInteger {
		return ports.ModelProfileEventPage{}, fmt.Errorf("%w: ModelProfile event cursor", ErrInvalidInput)
	}
	if limit == 0 {
		limit = defaultModelProfileEventPageSize
	}
	if limit < 1 || limit > maximumModelProfileEventPageSize {
		return ports.ModelProfileEventPage{}, fmt.Errorf("%w: ModelProfile event limit", ErrInvalidInput)
	}
	store, err := service.inspectionStore()
	if err != nil {
		return ports.ModelProfileEventPage{}, err
	}
	events, err := store.ListModelProfileEvents(ctx, organizationID, modelProfileID, afterRevision, limit)
	if err != nil {
		return ports.ModelProfileEventPage{}, fmt.Errorf("list ModelProfile events: %w", err)
	}
	page := ports.ModelProfileEventPage{Items: make([]ports.ModelProfileRevisedEvent, 0, min(len(events), limit))}
	truncated := len(events) > limit
	if truncated {
		events = events[:limit]
	}
	previous := afterRevision
	for _, event := range events {
		if err := validateModelProfileEvent(event, organizationID, modelProfileID, previous); err != nil {
			return ports.ModelProfileEventPage{}, err
		}
		previous = event.Revision
		page.Items = append(page.Items, event)
	}
	if truncated && len(page.Items) > 0 {
		next := page.Items[len(page.Items)-1].Revision
		page.NextAfterRevision = &next
	}
	return page, nil
}

func validateModelProfileEvent(
	event ports.ModelProfileRevisedEvent, organizationID string, modelProfileID string, floor int64,
) error {
	if event.EventType != ports.EventModelProfileRevised ||
		event.OrganizationID != organizationID || event.ModelProfileID != modelProfileID ||
		!validIdentifier(event.RequestID) || !validIdentifier(event.RevisionID) ||
		event.PreviousRevision < 1 || event.Revision != event.PreviousRevision+1 ||
		event.Revision > domain.MaximumSafeInteger || event.Revision <= floor ||
		event.OccurredAt.IsZero() {
		return fmt.Errorf("%w: invalid ModelProfile event", ErrQueryContract)
	}
	return nil
}

func effectiveModels(record ports.AgentConfigurationRecord) ([]ports.EffectiveModel, error) {
	if record.EffectiveModels == nil {
		return nil, nil
	}
	if len(record.EffectiveModels) == 0 {
		return nil, fmt.Errorf("%w: empty effective model projection", ErrQueryContract)
	}
	seen := make(map[string]bool, len(record.EffectiveModels))
	models := make([]ports.EffectiveModel, 0, len(record.EffectiveModels))
	for _, model := range record.EffectiveModels {
		if !validIdentifier(model.ModelProfileID) || model.Revision < 1 ||
			model.Revision > domain.MaximumSafeInteger {
			return nil, fmt.Errorf("%w: invalid effective model entry", ErrQueryContract)
		}
		if seen[model.ModelProfileID] {
			continue
		}
		seen[model.ModelProfileID] = true
		models = append(models, model)
	}
	return models, nil
}
