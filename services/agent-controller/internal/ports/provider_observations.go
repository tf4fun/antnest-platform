package ports

import "context"

// ProviderObservationStore replaces one saved Provider connection's durable
// discovery set inside the same serial transaction as other catalog writes.
type ProviderObservationStore interface {
	ReplaceProviderObservations(ctx context.Context, original ProviderConnectionRecord, models []DiscoveredModel) (int64, error)
}
