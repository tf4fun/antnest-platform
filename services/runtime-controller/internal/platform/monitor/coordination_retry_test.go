package monitor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestCoordinatedLeaderRetriesInitialReconciliationBeforeReady(t *testing.T) {
	health := &fakeHealth{healthy: true}
	source := &recoveringSource{listErrors: []error{
		errors.New("Docker socket unavailable"), errors.New("Docker socket still unavailable"),
	}}
	coordinator := &recoveringCoordinator{}
	source.beforeList = func() {
		if health.healthy {
			t.Error("failed reconciliation advertised monitor readiness")
		}
	}
	coordinator.beforeAcquire = func() {
		for _, lease := range coordinator.leases {
			if lease.releases.Load() != 1 {
				t.Error("re-election started before the previous lease was released")
			}
		}
	}
	runner := newRecoveryTestRunner(t, source, health)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	readyCalls := 0
	err := runner.RunCoordinated(ctx, coordinator, func() { readyCalls++; cancel() })
	if err != nil || readyCalls != 1 || source.listCalls != 3 {
		t.Fatalf("initial reconciliation did not recover: ready=%d lists=%d err=%v", readyCalls, source.listCalls, err)
	}
	if len(coordinator.leases) != 3 {
		t.Fatalf("leadership attempts = %d, want 3", len(coordinator.leases))
	}
	for _, lease := range coordinator.leases {
		if lease.releases.Load() != 1 {
			t.Fatalf("leadership released %d times, want 1", lease.releases.Load())
		}
	}
}

func TestCoordinatedLeaderRetriesLeadershipQuery(t *testing.T) {
	health := &fakeHealth{healthy: true}
	source := &recoveringSource{}
	coordinator := &recoveringCoordinator{acquireErrors: []error{errors.New("PostgreSQL connection unavailable")}}
	coordinator.beforeAcquire = func() {
		if coordinator.acquireCalls > 0 && health.healthy {
			t.Error("leadership query failure left the monitor ready")
		}
	}
	runner := newRecoveryTestRunner(t, source, health)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	readyCalls := 0
	err := runner.RunCoordinated(ctx, coordinator, func() { readyCalls++; cancel() })
	if err != nil || readyCalls != 1 || coordinator.acquireCalls != 2 {
		t.Fatalf("leadership query did not recover: ready=%d attempts=%d err=%v", readyCalls, coordinator.acquireCalls, err)
	}
}

func TestCoordinatedFollowerRetriesReadinessQuery(t *testing.T) {
	health := &fakeHealth{healthy: true}
	source := &recoveringSource{}
	coordinator := &recoveringCoordinator{follower: true, readinessErrors: []error{errors.New("PostgreSQL probe unavailable")}}
	coordinator.beforeAcquire = func() {
		if coordinator.acquireCalls > 0 && health.healthy {
			t.Error("readiness probe failure left the follower ready")
		}
	}
	runner := newRecoveryTestRunner(t, source, health)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	readyCalls := 0
	err := runner.RunCoordinated(ctx, coordinator, func() { readyCalls++; cancel() })
	if err != nil || readyCalls != 1 || coordinator.readinessCalls != 2 || source.listCalls != 0 {
		t.Fatalf("follower readiness did not recover: ready=%d probes=%d lists=%d err=%v", readyCalls, coordinator.readinessCalls, source.listCalls, err)
	}
}

func TestCoordinatedPermanentFailuresReleaseLeadershipAndReturn(t *testing.T) {
	permanent := fmt.Errorf("wrapped: %w", &PermanentError{Err: errors.New("unsupported observation schema")})
	for _, stage := range []string{"leadership", "readiness", "reconciliation", "watch"} {
		t.Run(stage, func(t *testing.T) {
			health := &fakeHealth{healthy: true}
			source := &recoveringSource{}
			coordinator := &recoveringCoordinator{}
			switch stage {
			case "leadership":
				coordinator.acquireErrors = []error{permanent}
			case "readiness":
				coordinator.follower = true
				coordinator.readinessErrors = []error{permanent}
			case "reconciliation":
				source.listErrors = []error{permanent}
			case "watch":
				source.watchError = permanent
			}
			runner := newRecoveryTestRunner(t, source, health)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			readyCalls := 0
			err := runner.RunCoordinated(ctx, coordinator, func() { readyCalls++ })
			if !errors.Is(err, permanent) || coordinator.acquireCalls != 1 || readyCalls != 0 || health.healthy {
				t.Fatalf("permanent failure was retried or hidden: attempts=%d ready=%d healthy=%t err=%v", coordinator.acquireCalls, readyCalls, health.healthy, err)
			}
			for _, lease := range coordinator.leases {
				if lease.releases.Load() != 1 {
					t.Fatal("permanent failure leaked leadership")
				}
			}
		})
	}
}

func TestCoordinatedBackoffCapsAndResetsOnlyAfterReady(t *testing.T) {
	failure := errors.New("readiness probe unavailable")
	health := &fakeHealth{}
	coordinator := &recoveringCoordinator{follower: true, readinessErrors: []error{
		failure, failure, failure, failure, failure, nil, failure,
	}}
	runner := newRecoveryTestRunner(t, &recoveringSource{}, health)
	runner.maxRetryDelay = 4 * time.Millisecond
	var delays []time.Duration
	runner.wait = func(ctx context.Context, delay time.Duration) bool {
		if ctx.Err() != nil {
			return false
		}
		if coordinator.readinessCalls != 6 && health.healthy {
			t.Error("monitor was ready while backing off a dependency error")
		}
		delays = append(delays, delay)
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	readyCalls := 0
	if err := runner.RunCoordinated(ctx, coordinator, func() {
		readyCalls++
		if readyCalls == 2 {
			cancel()
		}
	}); err != nil {
		t.Fatal(err)
	}
	bases := []time.Duration{time.Millisecond, 2 * time.Millisecond, 4 * time.Millisecond,
		4 * time.Millisecond, 4 * time.Millisecond, time.Millisecond, time.Millisecond}
	if len(delays) != len(bases) {
		t.Fatalf("retry schedule = %v, want %d waits", delays, len(bases))
	}
	for i, base := range bases {
		limit := min(base+base/5, runner.maxRetryDelay)
		if i == 5 { // Healthy followers poll; polling is not a failure.
			limit = base
		}
		if delays[i] < base || delays[i] > limit {
			t.Fatalf("wait %d = %s, want [%s, %s]", i, delays[i], base, limit)
		}
	}
}

func TestCoordinatedCancellationInterruptsLongBackoff(t *testing.T) {
	health := &fakeHealth{}
	coordinator := &recoveringCoordinator{acquireErrors: []error{errors.New("database unavailable")}}
	runner := newRecoveryTestRunner(t, &recoveringSource{}, health)
	runner.retryDelay, runner.maxRetryDelay = time.Hour, time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	coordinator.beforeAcquire = func() { close(entered) }
	result := make(chan error, 1)
	go func() { result <- runner.RunCoordinated(ctx, coordinator, func() { t.Error("unexpected readiness") }) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("monitor did not attempt leadership")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil || coordinator.acquireCalls != 1 {
			t.Fatalf("cancellation retried or failed: attempts=%d err=%v", coordinator.acquireCalls, err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt backoff")
	}
}

func newRecoveryTestRunner(t *testing.T, source *recoveringSource, health *fakeHealth) *Runner {
	t.Helper()
	runner, err := New(source, &fakeSink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, 30*time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

type recoveringSource struct {
	listErrors []error
	listCalls  int
	beforeList func()
	watchError error
}

func (s *recoveringSource) List(context.Context) ([]deployment.Inspection, error) {
	if s.beforeList != nil {
		s.beforeList()
	}
	call := s.listCalls
	s.listCalls++
	if call < len(s.listErrors) {
		return nil, s.listErrors[call]
	}
	return nil, nil
}

func (s *recoveringSource) Watch(ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	if s.watchError != nil {
		return s.watchError
	}
	if err := ready(ctx); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

type recoveringCoordinator struct {
	acquireErrors   []error
	readinessErrors []error
	acquireCalls    int
	readinessCalls  int
	follower        bool
	leases          []*fakeLeadership
	beforeAcquire   func()
}

func (c *recoveringCoordinator) TryAcquireObservationLeadership(context.Context) (repository.Leadership, bool, error) {
	if c.beforeAcquire != nil {
		c.beforeAcquire()
	}
	call := c.acquireCalls
	c.acquireCalls++
	if call < len(c.acquireErrors) && c.acquireErrors[call] != nil {
		return nil, false, c.acquireErrors[call]
	}
	if c.follower {
		return nil, false, nil
	}
	lease := newFakeLeadership()
	c.leases = append(c.leases, lease)
	return lease, true, nil
}

func (c *recoveringCoordinator) ObservationMonitorReady(context.Context) (bool, error) {
	call := c.readinessCalls
	c.readinessCalls++
	if call < len(c.readinessErrors) && c.readinessErrors[call] != nil {
		return false, c.readinessErrors[call]
	}
	return true, nil
}
