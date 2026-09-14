package application

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type availabilityStoreStub struct {
	ports.CatalogStore
	changes []ports.CatalogAvailabilityChange
	err     error
}

func (store *availabilityStoreStub) SetCatalogAvailability(_ context.Context, input ports.CatalogAvailabilityChange) (ports.CatalogAvailability, error) {
	store.changes = append(store.changes, input)
	return ports.CatalogAvailability{ResourceID: input.ResourceID, Enabled: input.Enabled, UpdatedAt: input.Now}, store.err
}

func TestCatalogAvailabilityFingerprintsTheEntireIntent(t *testing.T) {
	store := &availabilityStoreStub{}
	service := NewCatalogService(store, nil, fixedClock{now: time.Unix(1, 0)})
	input := SetCatalogAvailabilityInput{Kind: ports.CatalogProvider, ResourceID: "provider", OrganizationID: "org", RequestID: "request", ExpectedEnabled: true, Enabled: false}
	_, err := service.SetCatalogAvailability(t.Context(), input)
	require.NoError(t, err)
	service.clock = fixedClock{now: time.Unix(2, 0)}
	_, err = service.SetCatalogAvailability(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, store.changes[0].Fingerprint, store.changes[1].Fingerprint, "retries must not fingerprint the clock")
	for _, change := range []func(*SetCatalogAvailabilityInput){
		func(value *SetCatalogAvailabilityInput) { value.Kind = ports.CatalogModel },
		func(value *SetCatalogAvailabilityInput) { value.ResourceID = "other" },
		func(value *SetCatalogAvailabilityInput) { value.OrganizationID = "other" },
		func(value *SetCatalogAvailabilityInput) { value.ExpectedEnabled = false },
		func(value *SetCatalogAvailabilityInput) { value.Enabled = true },
	} {
		next := input
		change(&next)
		_, err = service.SetCatalogAvailability(t.Context(), next)
		require.NoError(t, err)
		require.NotEqual(t, store.changes[0].Fingerprint, store.changes[len(store.changes)-1].Fingerprint)
	}
}

func TestCatalogAvailabilityValidatesAndPreservesReferenceErrors(t *testing.T) {
	store := &availabilityStoreStub{err: &ports.CatalogReferenceConflict{References: []ports.CatalogReference{{Kind: "agent", ResourceID: "agent"}}}}
	service := NewCatalogService(store, nil, fixedClock{now: time.Unix(1, 0)})
	input := SetCatalogAvailabilityInput{Kind: ports.CatalogTemplate, ResourceID: "template", OrganizationID: "org", RequestID: "request"}
	for _, change := range []func(*SetCatalogAvailabilityInput){
		func(value *SetCatalogAvailabilityInput) { value.Kind = "unknown" },
		func(value *SetCatalogAvailabilityInput) { value.ResourceID = "" },
		func(value *SetCatalogAvailabilityInput) { value.OrganizationID = "bad/org" },
		func(value *SetCatalogAvailabilityInput) { value.RequestID = "" },
	} {
		next := input
		change(&next)
		_, err := service.SetCatalogAvailability(t.Context(), next)
		require.ErrorIs(t, err, ErrInvalidInput)
	}
	require.Empty(t, store.changes)
	_, err := service.SetCatalogAvailability(t.Context(), input)
	var conflict *ports.CatalogReferenceConflict
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, store.err, conflict)
}
