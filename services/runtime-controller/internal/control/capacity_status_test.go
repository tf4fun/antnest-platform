package control

import (
	"context"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

type capacityPlatform struct {
	platform.Lifecycle
	snapshot platform.Capacity
	calls    int
}

func (p *capacityPlatform) Ready(context.Context) error {
	p.calls++
	panic("status must not probe the platform")
}

func (p *capacityPlatform) Capacity() platform.Capacity { return p.snapshot }

func TestStatusExposesOnlyTheCachedCapacitySnapshot(t *testing.T) {
	store := &readinessStore{}
	adapter := &capacityPlatform{snapshot: platform.Capacity{RuntimeCapacity: 251, RuntimeCount: 2, Known: true}}
	service := &Service{repository: store, platform: adapter, observations: lifecycleObservationReadiness{}}
	status, err := service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.RuntimeCapacity != 251 || status.RuntimeCount != 2 || !status.RuntimeCapacityKnown {
		t.Fatalf("cached capacity was not exposed: %+v", status)
	}
	adapter.snapshot = platform.Capacity{RuntimeCapacity: 251, RuntimeCount: 2, Known: false}
	status, err = service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.RuntimeCapacityKnown {
		t.Fatalf("unknown snapshot claimed capacity: %+v", status)
	}
	adapter.snapshot = platform.Capacity{RuntimeCount: 9, Known: false}
	status, err = service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.RuntimeCount != 9 || status.RuntimeCapacityKnown {
		t.Fatalf("last-good numbers must not claim known capacity: %+v", status)
	}
}

func TestStatusWithoutCapacityCapabilityReportsUnknown(t *testing.T) {
	store := &readinessStore{}
	service := &Service{repository: store, platform: readinessPlatform{}, observations: lifecycleObservationReadiness{}}
	status, err := service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.RuntimeCapacityKnown || status.RuntimeCapacity != 0 || status.RuntimeCount != 0 {
		t.Fatalf("missing capacity capability produced values: %+v", status)
	}
}
