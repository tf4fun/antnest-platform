package reconcileworker

import (
	"context"
	"fmt"
	"sync"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/application"
)

const candidateBatchSize = 500

type CandidateSource interface {
	ListReconcileCandidates(context.Context, time.Time, int) ([]string, error)
}

type Reconciler interface {
	Reconcile(context.Context, string) (application.ReconcileResult, error)
}

type SignalQueue struct {
	channel chan string
	mu      sync.Mutex
	pending map[string]struct{}
}

func NewSignalQueue(capacity int) *SignalQueue {
	if capacity <= 0 {
		capacity = 1
	}
	return &SignalQueue{channel: make(chan string, capacity), pending: make(map[string]struct{})}
}

func (q *SignalQueue) Notify(_ context.Context, agentID string) {
	if agentID == "" {
		return
	}
	q.mu.Lock()
	if _, exists := q.pending[agentID]; exists {
		q.mu.Unlock()
		return
	}
	q.pending[agentID] = struct{}{}
	q.mu.Unlock()
	select {
	case q.channel <- agentID:
	default:
		q.done(agentID)
	}
}

func (q *SignalQueue) done(agentID string) {
	q.mu.Lock()
	delete(q.pending, agentID)
	q.mu.Unlock()
}

type Runner struct {
	candidates       CandidateSource
	reconciler       Reconciler
	queue            *SignalQueue
	recoveryInterval time.Duration
	errorBackoff     time.Duration
	now              func() time.Time
}

func NewRunner(
	candidates CandidateSource,
	reconciler Reconciler,
	queue *SignalQueue,
	recoveryInterval time.Duration,
	errorBackoff time.Duration,
) (*Runner, error) {
	if candidates == nil || reconciler == nil || queue == nil ||
		recoveryInterval <= 0 || errorBackoff <= 0 {
		return nil, fmt.Errorf("candidate source, reconciler, queue, and positive intervals are required")
	}
	return &Runner{
		candidates: candidates, reconciler: reconciler, queue: queue,
		recoveryInterval: recoveryInterval, errorBackoff: errorBackoff,
		now: func() time.Time { return time.Now().UTC() },
	}, nil
}

func (r *Runner) Run(ctx context.Context) error {
	if err := r.recover(ctx); err != nil {
		return err
	}
	recovery := time.NewTicker(r.recoveryInterval)
	defer recovery.Stop()
	pending := make(map[string]time.Time)
	for {
		now := r.now()
		if agentID, due := nextDue(pending, now); due {
			result, err := r.reconciler.Reconcile(ctx, agentID)
			r.queue.done(agentID)
			switch {
			case err != nil:
				pending[agentID] = r.now().Add(r.errorBackoff)
			case !result.RetryAt.IsZero():
				pending[agentID] = result.RetryAt
			default:
				delete(pending, agentID)
			}
			continue
		}

		timer, timerChannel := nextTimer(pending, now)
		select {
		case <-ctx.Done():
			stopTimer(timer)
			return nil
		case agentID := <-r.queue.channel:
			stopTimer(timer)
			pending[agentID] = r.now()
		case <-timerChannel:
		case <-recovery.C:
			stopTimer(timer)
			_ = r.recover(ctx)
		}
	}
}

func (r *Runner) recover(ctx context.Context) error {
	agentIDs, err := r.candidates.ListReconcileCandidates(ctx, r.now(), candidateBatchSize)
	if err != nil {
		return fmt.Errorf("recover runtime reconciliation: %w", err)
	}
	for _, agentID := range agentIDs {
		r.queue.Notify(ctx, agentID)
	}
	return nil
}

func nextDue(pending map[string]time.Time, now time.Time) (string, bool) {
	var selected string
	var selectedAt time.Time
	for agentID, dueAt := range pending {
		if dueAt.After(now) {
			continue
		}
		if selected == "" || dueAt.Before(selectedAt) || dueAt.Equal(selectedAt) && agentID < selected {
			selected = agentID
			selectedAt = dueAt
		}
	}
	return selected, selected != ""
}

func nextTimer(pending map[string]time.Time, now time.Time) (*time.Timer, <-chan time.Time) {
	var earliest time.Time
	for _, dueAt := range pending {
		if earliest.IsZero() || dueAt.Before(earliest) {
			earliest = dueAt
		}
	}
	if earliest.IsZero() {
		return nil, nil
	}
	delay := earliest.Sub(now)
	if delay < 0 {
		delay = 0
	}
	timer := time.NewTimer(delay)
	return timer, timer.C
}

func stopTimer(timer *time.Timer) {
	if timer != nil && !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}
