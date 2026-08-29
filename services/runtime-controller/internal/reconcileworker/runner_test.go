package reconcileworker

import (
	"context"
	"sync"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/application"
)

func TestRunnerDeduplicatesSignalsAndStopsPollingSettledRuntime(t *testing.T) {
	queue := NewSignalQueue(8)
	reconciler := &fakeReconciler{results: []application.ReconcileResult{{Settled: true}}, called: make(chan struct{}, 4)}
	runner, err := NewRunner(&fakeCandidates{}, reconciler, queue, time.Hour, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	queue.Notify(context.Background(), "agent-1")
	queue.Notify(context.Background(), "agent-1")
	queue.Notify(context.Background(), "agent-1")
	select {
	case <-reconciler.called:
	case <-time.After(time.Second):
		t.Fatal("reconcile was not called")
	}
	time.Sleep(30 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}
	if reconciler.calls() != 1 {
		t.Fatalf("reconcile calls = %d", reconciler.calls())
	}
}

func TestRunnerRestoresCandidatesAndHonorsRetryAt(t *testing.T) {
	queue := NewSignalQueue(8)
	reconciler := &fakeReconciler{
		results: []application.ReconcileResult{
			{RetryAt: time.Now().Add(25 * time.Millisecond)}, {Settled: true},
		},
		called: make(chan struct{}, 4),
	}
	runner, err := NewRunner(
		&fakeCandidates{agentIDs: []string{"agent-1"}}, reconciler, queue,
		time.Hour, 10*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	for call := 0; call < 2; call++ {
		select {
		case <-reconciler.called:
		case <-time.After(time.Second):
			t.Fatalf("reconcile call %d did not arrive", call+1)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}
}

type fakeCandidates struct {
	agentIDs []string
}

func (f *fakeCandidates) ListReconcileCandidates(context.Context, time.Time, int) ([]string, error) {
	result := append([]string(nil), f.agentIDs...)
	f.agentIDs = nil
	return result, nil
}

type fakeReconciler struct {
	mu      sync.Mutex
	results []application.ReconcileResult
	count   int
	called  chan struct{}
}

func (f *fakeReconciler) Reconcile(context.Context, string) (application.ReconcileResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.count++
	result := application.ReconcileResult{Settled: true}
	if len(f.results) > 0 {
		result = f.results[0]
		f.results = f.results[1:]
	}
	f.called <- struct{}{}
	return result, nil
}

func (f *fakeReconciler) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.count
}
