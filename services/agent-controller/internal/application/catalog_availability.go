package application

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type SetCatalogAvailabilityInput struct {
	Kind            ports.CatalogResourceKind
	ResourceID      string
	OrganizationID  string
	RequestID       string
	ExpectedEnabled bool
	Enabled         bool
}

func (service *CatalogService) SetCatalogAvailability(ctx context.Context, input SetCatalogAvailabilityInput) (ports.CatalogAvailability, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) || !validIdentifier(input.ResourceID) {
		return ports.CatalogAvailability{}, fmt.Errorf("%w: catalog availability identity", ErrInvalidInput)
	}
	switch input.Kind {
	case ports.CatalogProvider, ports.CatalogModel, ports.CatalogTemplate:
	default:
		return ports.CatalogAvailability{}, fmt.Errorf("%w: catalog resource kind", ErrInvalidInput)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ports.CatalogAvailability{}, err
	}
	return service.store.SetCatalogAvailability(ctx, ports.CatalogAvailabilityChange{
		Kind: input.Kind, ResourceID: input.ResourceID, OrganizationID: input.OrganizationID,
		RequestID: input.RequestID, Fingerprint: fingerprint, ExpectedEnabled: input.ExpectedEnabled,
		Enabled: input.Enabled, Now: service.clock.Now(),
	})
}
