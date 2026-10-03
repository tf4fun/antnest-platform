package postgres

import (
	"context"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Existing catalog/lifecycle fixtures avoid real DNS; outbound conformance and
// isolated Controller Docker tests separately exercise production admission.
type fixtureProviderValidator struct{}

func (fixtureProviderValidator) ValidateEndpoint(context.Context, string) error { return nil }
func fixtureCatalogService(store ports.CatalogStore, sealer ports.CredentialSealer, clock ports.Clock, options ...application.CatalogOption) *application.CatalogService {
	return application.NewCatalogService(store, sealer, clock, append([]application.CatalogOption{application.WithProviderDiscovery(fixtureProviderValidator{}, nil)}, options...)...)
}
