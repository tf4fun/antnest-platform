// Package browserstream bounds the lifetime of output authorized by a browser
// session. Live Identity checks are authoritative; the private feed only
// accelerates cancellation of currently registered streams.
package browserstream

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

const DefaultMaximumStale = 30 * time.Second

var (
	ErrRejected    = errors.New("browser session rejected")
	ErrUnavailable = errors.New("browser session verification unavailable")
)

type Config struct {
	MaximumStale   time.Duration
	InitialStarted time.Time
	Original       identity.Principal
	Resolve        func(context.Context) (identity.Principal, error)
}

type Guard struct {
	ctx          context.Context
	cancel       context.CancelCauseFunc
	done         chan struct{}
	original     identity.Principal
	maximumStale time.Duration
	closeGrace   time.Duration
	hardCap      time.Time
	hardCause    error
}

func Interval(maximumStale time.Duration, hintMS int) time.Duration {
	return min(maximumStale/3, time.Duration(hintMS)*time.Millisecond)
}

func CloseGrace(maximumStale time.Duration) time.Duration {
	return min(time.Second, maximumStale/3)
}

// Validate preserves original identity and roles, allowing only the mutable
// idle observation and a newly issued CCT to change during a live check.
func Validate(current, original identity.Principal, now time.Time) error {
	if !current.Active || current.SessionID != original.SessionID || current.UserID != original.UserID ||
		current.OrganizationID != original.OrganizationID || current.MembershipID != original.MembershipID ||
		current.SystemRole != original.SystemRole || current.OrganizationRole != original.OrganizationRole {
		return ErrRejected
	}
	if current.CallerContext == "" || !callercontext.ValidID(current.SessionID) ||
		!callercontext.ValidID(current.UserID) || !callercontext.ValidID(current.OrganizationID) ||
		!callercontext.ValidID(current.MembershipID) || !current.SessionMetadata().Valid() ||
		!current.ExpiresAt.Equal(original.ExpiresAt) {
		return ErrUnavailable
	}
	if !current.ExpiresAt.After(now) || !current.IdleExpiresAt.After(now) {
		return ErrRejected
	}
	return nil
}

func resolveError(err error) error {
	if identity.IsCode(err, "unauthenticated") || identity.IsCode(err, "inactive_principal") {
		return ErrRejected
	}
	return ErrUnavailable
}

// Start must run before opening upstream. InitialStarted is the first probe's
// invocation start; private Principal provenance retains the actual RPC start.
func Start(parent context.Context, registry *Registry, cfg Config) (*Guard, error) {
	if cfg.MaximumStale == 0 {
		cfg.MaximumStale = DefaultMaximumStale
	}
	now := time.Now()
	if parent.Err() != nil || cfg.MaximumStale < 3*time.Nanosecond || cfg.Resolve == nil || registry == nil ||
		cfg.InitialStarted.IsZero() || cfg.InitialStarted.After(now) {
		return nil, ErrUnavailable
	}
	if err := Validate(cfg.Original, cfg.Original, now); err != nil {
		return nil, err
	}
	authorityStarted, err := ValidateTiming(cfg.Original, cfg.InitialStarted, cfg.MaximumStale, now)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancelCause(parent)
	guard := &Guard{ctx: ctx, cancel: cancel, done: make(chan struct{}), original: cfg.Original,
		maximumStale: cfg.MaximumStale, closeGrace: CloseGrace(cfg.MaximumStale),
		hardCap: cfg.Original.ExpiresAt, hardCause: ErrRejected}
	deadline, cause := guard.deadline(authorityStarted)
	if !deadline.After(now) {
		cancel(cause)
		return nil, cause
	}
	remove := registry.register(guard)
	go guard.run(cfg, authorityStarted, remove)
	return guard, nil
}

func (guard *Guard) Context() context.Context { return guard.ctx }

// Close cancels and joins all live checks; callers then join their socket/write
// cancellation callbacks before releasing the handler's response writer.
func (guard *Guard) Close() {
	guard.cancel(context.Canceled)
	<-guard.done
}

func (guard *Guard) deadline(lastSuccessfulStart time.Time) (time.Time, error) {
	deadline, cause := lastSuccessfulStart.Add(guard.maximumStale), ErrUnavailable
	if !guard.hardCap.After(deadline) {
		deadline, cause = guard.hardCap, guard.hardCause
	}
	return deadline.Add(-guard.closeGrace), cause
}

type checkResult struct {
	started   time.Time
	principal identity.Principal
	err       error
}

func (guard *Guard) run(cfg Config, lastAuthorityStart time.Time, remove func()) {
	var workers sync.WaitGroup
	var cancelCheck context.CancelFunc
	var checkDone <-chan struct{}
	var checkCtx context.Context
	var probeStarted, probeDeadline time.Time
	var rechecked bool
	defer func() {
		guard.cancel(context.Canceled)
		if cancelCheck != nil {
			cancelCheck()
		}
		workers.Wait()
		remove()
		close(guard.done)
	}()
	current := cfg.Original
	next := nextCheck(cfg.InitialStarted, guard.maximumStale, current)
	results := make(chan checkResult, 1)
	launch := func(ctx context.Context, started time.Time) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			principal, err := cfg.Resolve(ctx)
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			results <- checkResult{started: started, principal: principal, err: err}
		}()
	}
	pending := false
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		if guard.ctx.Err() != nil {
			return
		}
		deadline, cause := guard.deadline(lastAuthorityStart)
		now := time.Now()
		if !deadline.After(now) {
			guard.cancel(cause)
			return
		}
		if !pending && !next.After(now) {
			probeStarted = now
			probeDeadline = minTime(probeStarted.Add(Interval(guard.maximumStale, current.ActivityIntervalMS)), deadline)
			ctx, cancel := context.WithDeadline(guard.ctx, probeDeadline)
			checkCtx, cancelCheck = ctx, cancel
			checkDone = checkCtx.Done()
			pending = true
			rechecked = false
			launch(checkCtx, probeStarted)
		}
		wake := deadline
		if !pending {
			wake = minTime(wake, next)
		}
		timer.Reset(max(0, time.Until(wake)))
		select {
		case <-guard.ctx.Done():
			return
		case <-checkDone:
			if !deadline.After(time.Now()) {
				guard.cancel(cause)
			} else {
				guard.cancel(ErrUnavailable)
			}
			return
		case <-timer.C:
		case result := <-results:
			now := time.Now()
			// A ready result cannot outrun a simultaneous hard deadline.
			if !deadline.After(now) {
				guard.cancel(cause)
				return
			}
			if checkCtx.Err() != nil || !probeDeadline.After(now) {
				guard.cancel(ErrUnavailable)
				return
			}
			if result.err != nil {
				guard.cancel(resolveError(result.err))
				return
			}
			if err := Validate(result.principal, cfg.Original, now); err != nil {
				guard.cancel(err)
				return
			}
			authorityStarted, err := ValidateTiming(result.principal, result.started, guard.maximumStale, now)
			if err != nil {
				if !rechecked && recheckExpiredCacheHit(result.principal, result.started, guard.maximumStale, now) {
					rechecked = true
					launch(checkCtx, probeStarted)
					continue
				}
				guard.cancel(err)
				return
			}
			cancelCheck()
			cancelCheck = nil
			checkDone = nil
			pending = false
			lastAuthorityStart, current = authorityStarted, result.principal
			next = nextCheck(result.started, guard.maximumStale, current)
		}
	}
}

func nextCheck(started time.Time, maximumStale time.Duration, principal identity.Principal) time.Time {
	// An idle deadline is an observation, never a permanent close timer: a
	// different tab may have recorded explicit activity in the meantime.
	next := minTime(started.Add(Interval(maximumStale, principal.ActivityIntervalMS)), principal.IdleExpiresAt)
	if !principal.ResolveValidUntil.IsZero() {
		next = minTime(next, principal.ResolveValidUntil)
	}
	return next
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
