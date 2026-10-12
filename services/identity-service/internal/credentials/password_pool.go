package credentials

import (
	"context"
	"sync"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

const (
	passwordMaximumQueued = 32
	passwordWaitLimit     = 2 * time.Second
)

// PasswordAdmissionError records a bounded private cause; the HTTP projection
// remains credential_busy. A database-lock busy is not KDF pressure evidence.
type PasswordAdmissionError struct{ Reason string }

func (e *PasswordAdmissionError) Error() string { return "password resource admission: " + e.Reason }

func passwordBusy(reason string) error {
	return domain.WithCause(domain.ErrCredentialBusy, &PasswordAdmissionError{Reason: reason})
}

type PasswordStats struct {
	Active        int
	MemoryKiB     uint32
	Queued        int
	PeakActive    int
	PeakMemoryKiB uint32
	QueueRejected uint64
	WaitExpired   uint64
	OverBudget    uint64
}

type passwordWaiter struct {
	ctx      context.Context
	memory   uint32
	ready    chan struct{}
	admitted bool
}

func (e *Engine) Stats() PasswordStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	stats := e.stats
	stats.Queued = len(e.queue)
	return stats
}

func (e *Engine) acquire(ctx context.Context, memory uint32) (func(), error) {
	waitCtx, cancel := context.WithTimeout(ctx, passwordWaitLimit)
	defer cancel()
	e.mu.Lock()
	if err := ctx.Err(); err != nil {
		e.mu.Unlock()
		return nil, err
	}
	if e.closed {
		e.mu.Unlock()
		return nil, passwordBusy("shutdown")
	}
	if memory > e.config.MemoryBudgetKiB {
		e.stats.OverBudget++
		e.mu.Unlock()
		return nil, passwordBusy("weight_exceeds_budget")
	}
	if len(e.queue) == 0 && e.fitsLocked(memory) {
		e.admitLocked(memory)
		e.mu.Unlock()
		return e.permit(memory), nil
	}
	if len(e.queue) == passwordMaximumQueued {
		e.stats.QueueRejected++
		e.mu.Unlock()
		return nil, passwordBusy("queue_full")
	}
	waiter := &passwordWaiter{ctx: waitCtx, memory: memory, ready: make(chan struct{})}
	e.queue = append(e.queue, waiter)
	e.mu.Unlock()
	select {
	case <-waiter.ready:
	case <-waitCtx.Done():
	}
	e.mu.Lock()
	admitted := waiter.admitted
	if admitted && waitCtx.Err() == nil && !e.closed {
		e.mu.Unlock()
		return e.permit(memory), nil
	}
	for index, candidate := range e.queue {
		if candidate == waiter {
			e.queue = append(e.queue[:index], e.queue[index+1:]...)
			break
		}
	}
	closed := e.closed
	requestErr := ctx.Err()
	if !closed && requestErr == nil {
		e.stats.WaitExpired++
	}
	e.dispatchLocked()
	e.mu.Unlock()
	if admitted {
		e.release(memory)
	}
	if requestErr != nil {
		return nil, requestErr
	}
	if closed {
		return nil, passwordBusy("shutdown")
	}
	return nil, passwordBusy("wait_expired")
}

func (e *Engine) fitsLocked(memory uint32) bool {
	return e.stats.Active < e.config.MaxConcurrent && memory <= e.config.MemoryBudgetKiB-e.stats.MemoryKiB
}

func (e *Engine) admitLocked(memory uint32) {
	e.stats.Active++
	e.stats.MemoryKiB += memory
	e.stats.PeakActive = max(e.stats.PeakActive, e.stats.Active)
	e.stats.PeakMemoryKiB = max(e.stats.PeakMemoryKiB, e.stats.MemoryKiB)
	e.running.Add(1)
}

func (e *Engine) dispatchLocked() {
	for !e.closed && len(e.queue) > 0 {
		waiter := e.queue[0]
		if waiter.ctx.Err() != nil {
			e.queue = e.queue[1:]
			close(waiter.ready)
			continue
		}
		if !e.fitsLocked(waiter.memory) {
			return
		}
		e.queue = e.queue[1:]
		e.admitLocked(waiter.memory)
		waiter.admitted = true
		close(waiter.ready)
	}
}

func (e *Engine) permit(memory uint32) func() {
	var once sync.Once
	return func() { once.Do(func() { e.release(memory) }) }
}

func (e *Engine) release(memory uint32) {
	e.mu.Lock()
	e.stats.Active--
	e.stats.MemoryKiB -= memory
	e.dispatchLocked()
	e.mu.Unlock()
	e.running.Done()
}

// Stop prevents new admission and removes queued work without waiting for the
// running kernels. The HTTP server can start draining while those finish.
func (e *Engine) Stop() {
	e.mu.Lock()
	if !e.closed {
		e.closed = true
		for _, waiter := range e.queue {
			close(waiter.ready)
		}
		e.queue = nil
	}
	e.mu.Unlock()
}

// Close joins all admitted kernels, even after Stop or caller cancellation.
// Composition must call it before closing the backing repository.
func (e *Engine) Close() {
	e.Stop()
	e.running.Wait()
}
