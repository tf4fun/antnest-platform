package telemetry

import (
	"io"
	"log/slog"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

type quotaAwarePort struct {
	platform.Port
	enforced bool
}

func (p quotaAwarePort) DiskQuotaEnforced() bool { return p.enforced }

func TestObservedPlatformForwardsDiskQuotaEnforced(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	unbounded, err := ObservePlatform(&sessionPlatform{}, logger, "docker")
	if err != nil {
		t.Fatal(err)
	}
	if unbounded.DiskQuotaEnforced() {
		t.Fatal("a backend without the quota capability must report false")
	}
	enforced, err := ObservePlatform(quotaAwarePort{&sessionPlatform{}, true}, logger, "docker")
	if err != nil {
		t.Fatal(err)
	}
	if !enforced.DiskQuotaEnforced() {
		t.Fatal("the optional quota capability must be forwarded")
	}
}
