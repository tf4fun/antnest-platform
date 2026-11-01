package telemetry

import (
	"io"
	"log/slog"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

type capacityAwarePort struct {
	platform.Port
	snapshot platform.Capacity
}

func (p capacityAwarePort) Capacity() platform.Capacity { return p.snapshot }

func TestObservedPlatformForwardsCapacity(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	plain, err := ObservePlatform(&sessionPlatform{}, logger, "docker")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot := plain.Capacity(); snapshot != (platform.Capacity{}) {
		t.Fatalf("a backend without the capability reported capacity: %+v", snapshot)
	}
	aware, err := ObservePlatform(capacityAwarePort{&sessionPlatform{}, platform.Capacity{
		RuntimeCapacity: 251, RuntimeCount: 2, Known: true,
	}}, logger, "docker")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := aware.Capacity()
	if snapshot.RuntimeCapacity != 251 || snapshot.RuntimeCount != 2 || !snapshot.Known {
		t.Fatalf("the optional capacity capability was not forwarded: %+v", snapshot)
	}
}
