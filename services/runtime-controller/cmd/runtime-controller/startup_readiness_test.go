package main

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

func TestStartupSurvivesMonitorDropAfterFirstReady(t *testing.T) {
	health := &observation.Health{}
	health.MarkMonitor(true) // The first ready callback has allowed HTTP startup.
	service := &flappingStartupReadiness{health: health}
	if err := checkStartupReadiness(context.Background(), service); err != nil {
		t.Fatalf("monitor flap brought back the fatal startup readiness path: %v", err)
	}
	if health.MonitorReady() {
		t.Fatal("startup test did not drop monitor readiness")
	}
}

func TestStartupStillRequiresLocalDependencies(t *testing.T) {
	storeFailure := errors.New("operation store unavailable")
	for _, test := range []struct {
		name   string
		status control.Readiness
		err    error
	}{
		{"database", control.Readiness{PlatformReady: true, ObservationReady: true, MonitorReady: true}, nil},
		{"adapter", control.Readiness{DatabaseReady: true, ObservationReady: true, MonitorReady: true}, nil},
		{"journal and notifications", control.Readiness{DatabaseReady: true, PlatformReady: true, MonitorReady: true}, nil},
		{"store error", control.Readiness{}, storeFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := checkStartupReadiness(context.Background(), staticStartupReadiness{test.status, test.err})
			if err == nil || (test.err != nil && !errors.Is(err, test.err)) {
				t.Fatalf("local startup failure was hidden: %v", err)
			}
		})
	}
}

type staticStartupReadiness struct {
	status control.Readiness
	err    error
}

func (s staticStartupReadiness) Status(context.Context) (control.Readiness, error) {
	return s.status, s.err
}

type flappingStartupReadiness struct{ health *observation.Health }

func (s *flappingStartupReadiness) Status(context.Context) (control.Readiness, error) {
	s.health.MarkMonitor(false) // Drop between the first callback and its recheck.
	return control.Readiness{DatabaseReady: true, PlatformReady: true, ObservationReady: true,
		MonitorReady: s.health.MonitorReady()}, nil
}

func (s *flappingStartupReadiness) Ready(ctx context.Context) error {
	status, err := s.Status(ctx)
	if err != nil {
		return err
	}
	if !status.Ready() {
		return errors.New("platform observation monitor is not ready")
	}
	return nil
}
