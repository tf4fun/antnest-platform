package identity

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/trace"
)

type resolveFlight struct {
	key         resolveKey
	ctx         context.Context
	cancel      context.CancelFunc
	done        chan struct{}
	epoch       uint64
	knownSID    string
	waiters     int
	background  bool
	completed   bool
	invalidated bool
	// Activity retires reuse without revoking already-attached live readers.
	activityObsolete bool
	principal        Principal
	err              error
	rpcSpan          trace.SpanContext
	triggerSpan      trace.SpanContext
}

func (cache *resolveCache) joinable(key resolveKey) *resolveFlight {
	flight := cache.flights[key]
	if flight == nil || flight.completed || flight.invalidated || flight.activityObsolete || flight.epoch != cache.epoch || flight.ctx.Err() != nil {
		return nil
	}
	return flight
}

func (cache *resolveCache) scopeWaiters(key resolveKey) int {
	count := 0
	// At most 32 retained flights, including obsolete generations and ready
	// results whose waiters have not been scheduled to receive them yet.
	for flight := range cache.retained {
		if flight.key == key {
			count += flight.waiters
		}
	}
	return count
}

// The process owns shared work. Preserve the original request's trace parent
// without retaining its deadline/cancellation or arbitrary request values.
func (client *Client) startResolveLocked(trigger context.Context, key resolveKey, token, knownSID string, background bool) *resolveFlight {
	cache := client.cache
	parent := cache.ctx
	if !background {
		parent = trace.ContextWithSpanContext(parent, trace.SpanContextFromContext(trigger))
	}
	ctx, cancel := context.WithTimeout(parent, min(5*time.Second, cache.config.RequestTimeout, cache.config.TTL))
	flight := &resolveFlight{key: key, ctx: ctx, cancel: cancel, done: make(chan struct{}), epoch: cache.epoch,
		knownSID: knownSID, background: background}
	if background {
		flight.triggerSpan = trace.SpanContextFromContext(trigger)
	}
	cache.flights[key] = flight
	cache.retained[flight] = struct{}{}
	cache.active++
	cache.workers.Add(1)
	go client.runResolve(flight, token)
	return flight
}

func (client *Client) runResolve(flight *resolveFlight, token string) {
	cache := client.cache
	defer cache.workers.Done()
	defer flight.cancel()
	ctx, finish := flight.tracedWork(cache)
	var principal Principal
	var err error
	defer func() { finish(principal, err) }()
	principal, err = client.resolveLive(ctx, token, resolution{Profile: flight.key.profile, Agent: flight.key.agent})
	cache.mu.Lock()
	defer cache.mu.Unlock()
	denied := IsCode(err, "unauthenticated") || IsCode(err, "inactive_principal") || err == nil && !principal.Active
	if denied {
		cache.invalidateToken(flight.key.token)
	} else if flight.ctx.Err() != nil {
		principal, err = Principal{}, flight.ctx.Err()
	} else if err == nil {
		principal.ResolveValidUntil = earliestTime(principal.ResolveValidUntil, principal.ResolveStartedAt.Add(cache.config.TTL))
		if cache.closed || flight.invalidated || flight.epoch != cache.epoch || !principal.ResolveValidUntil.After(time.Now()) {
			principal, err = Principal{}, resolveUnavailable()
		} else if !flight.activityObsolete {
			cache.store(flight.key, principal)
		}
	}
	flight.principal, flight.err = principal, err
	flight.completed = true
	if cache.flights[flight.key] == flight {
		delete(cache.flights, flight.key)
	}
	if flight.waiters == 0 {
		cache.releaseFlight(flight)
	}
	close(flight.done)
}

func (cache *resolveCache) wait(ctx context.Context, flight *resolveFlight, decision *resolveDecision) (Principal, error) {
	select {
	case <-ctx.Done():
	case <-cache.ctx.Done():
	case <-flight.ctx.Done():
	case <-flight.done:
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	defer cache.releaseWaiter(flight)
	decision.sourceSnapshot(ctx, cache, flight)
	if err := ctx.Err(); err != nil {
		return Principal{}, err
	}
	if cache.closed || cache.ctx.Err() != nil {
		return Principal{}, resolveUnavailable()
	}
	if !flight.completed {
		return Principal{}, flight.ctx.Err()
	}
	if flight.err != nil {
		return Principal{}, flight.err
	}
	if !flight.principal.Active {
		return flight.principal, nil // Preserve an authoritative inactive response.
	}
	// A ready result does not authorize a late waiter after an intervening
	// revocation or deadline. Coalesced live replies need no cache/feed proof.
	if flight.invalidated || flight.epoch != cache.epoch || !flight.principal.ResolveValidUntil.After(time.Now()) {
		return Principal{}, resolveUnavailable()
	}
	return flight.principal, nil
}

func (cache *resolveCache) releaseWaiter(flight *resolveFlight) {
	flight.waiters--
	cache.waiters--
	if flight.waiters != 0 {
		return
	}
	if flight.completed {
		cache.releaseFlight(flight)
		return
	}
	if !flight.background {
		flight.invalidated = true
		flight.cancel()
		if cache.flights[flight.key] == flight {
			delete(cache.flights, flight.key)
		}
	}
}

func (cache *resolveCache) releaseFlight(flight *resolveFlight) {
	// Keep the work slot through transport cleanup AND final delivery. The
	// latter bounds live oversized results that cannot enter the LRU budget.
	delete(cache.retained, flight)
	cache.active--
}

func (client *Client) Close() {
	defer client.metrics.close()
	cache := client.cache
	if cache == nil {
		return
	}
	cache.mu.Lock()
	cache.closed = true
	cache.cancel()
	cache.mu.Unlock()
	cache.workers.Wait()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for _, entry := range cache.entries {
		cache.removeEntry(entry)
	}
}
