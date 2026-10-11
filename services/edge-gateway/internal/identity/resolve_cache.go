package identity

import (
	"container/list"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"sync"
	"time"

	"go.opentelemetry.io/otel/trace"
)

const (
	resolveCacheMaximumBytes = 64 << 20
	resolveCacheEntryBytes   = 16 << 10
	resolveCacheEntryCharge  = 1024
	resolveCacheScopes       = 32
	resolveCacheScopeWaiters = 128
	resolveCacheWaiters      = 1024
)

type ResolveCacheConfig struct {
	TTL            time.Duration
	Size           int
	RequestTimeout time.Duration
}

type resolveKey struct {
	token   [sha256.Size]byte
	profile string
	agent   string
}

type resolveEntry struct {
	key         resolveKey
	principal   Principal
	position    *list.Element
	charge      int
	nextRefresh time.Time
}

type resolveCache struct {
	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	workers sync.WaitGroup
	closed  bool
	config  ResolveCacheConfig

	entries map[resolveKey]*resolveEntry
	lru     list.List
	bytes   int
	bySID   map[string]map[resolveKey]struct{}
	byUser  map[string]map[resolveKey]struct{}
	byToken map[[sha256.Size]byte]map[resolveKey]struct{}

	flights  map[resolveKey]*resolveFlight
	retained map[*resolveFlight]struct{}
	active   int
	waiters  int
	epoch    uint64
	proof    time.Time
}

// NewCachedClient owns one issuer's cache and shared RPCs. Construction starts
// no goroutine; main must call Close before tearing down its HTTP transport.
func NewCachedClient(parent context.Context, rawBaseURL string, httpClient *http.Client, config ResolveCacheConfig) (*Client, error) {
	if parent == nil || config.TTL < 0 || config.TTL > 30*time.Second || config.Size < 1 || config.Size > 50000 || config.RequestTimeout <= 0 {
		return nil, fmt.Errorf("invalid Identity resolve cache configuration")
	}
	client, err := NewClient(rawBaseURL, httpClient)
	if err != nil || config.TTL == 0 {
		return client, err
	}
	ctx, cancel := context.WithCancel(parent)
	client.cache = &resolveCache{ctx: ctx, cancel: cancel, config: config,
		entries: make(map[resolveKey]*resolveEntry), bySID: make(map[string]map[resolveKey]struct{}),
		byUser: make(map[string]map[resolveKey]struct{}), byToken: make(map[[sha256.Size]byte]map[resolveKey]struct{}),
		flights: make(map[resolveKey]*resolveFlight), retained: make(map[*resolveFlight]struct{})}
	if err := client.metrics.observeCache(client.cache); err != nil {
		cancel()
		return nil, fmt.Errorf("observe Identity Resolve cache: %w", err)
	}
	return client, nil
}

func (client *Client) Resolve(ctx context.Context, accessToken string) (principal Principal, err error) {
	selection, ok := ctx.Value(resolutionKey{}).(resolution)
	if !ok {
		selection.Profile = "workspace"
	}
	decision := newResolveDecision(ctx, selection.Profile)
	defer func() {
		decision.finish(principal, err)
		client.metrics.decision(ctx, decision.source, decision.profile, resolveOutcome(principal, err))
	}()
	if selection.Profile != "workspace" && selection.Profile != "console" && selection.Profile != "acp" && selection.Profile != "session" ||
		selection.Agent != "" && (selection.Profile == "session" || !ValidPublicID(selection.Agent)) {
		return Principal{}, fmt.Errorf("invalid server-owned audience profile or Agent scope")
	}
	if err := ctx.Err(); err != nil {
		return Principal{}, err
	}
	if client.cache == nil {
		return client.resolveLive(ctx, accessToken, selection)
	}
	return client.cachedResolve(ctx, accessToken, selection, decision)
}

func (client *Client) cachedResolve(ctx context.Context, accessToken string, selection resolution, decision *resolveDecision) (Principal, error) {
	cache := client.cache
	key := resolveKey{sha256.Sum256([]byte(accessToken)), selection.Profile, selection.Agent}
	cache.mu.Lock()
	if err := ctx.Err(); err != nil {
		cache.mu.Unlock()
		return Principal{}, err
	}
	if cache.closed || cache.ctx.Err() != nil {
		cache.mu.Unlock()
		return Principal{}, resolveUnavailable()
	}
	now := time.Now()
	knownSID := ""
	if entry := cache.entries[key]; entry != nil {
		knownSID = entry.principal.SessionID
		if entry.principal.ResolveValidUntil.After(now) && cache.freshProof(now) {
			cache.lru.MoveToFront(entry.position)
			principal := entry.principal
			principal.ResolveCacheHit = true
			decision.cacheHit(principal, cache.proof, now)
			if !entry.nextRefresh.After(now) && cache.joinable(key) == nil && cache.active < resolveCacheScopes {
				entry.nextRefresh = now.Add(cache.config.TTL / 2)
				client.startResolveLocked(trace.ContextWithSpanContext(ctx, decision.span.SpanContext()), key, accessToken, knownSID, true)
			}
			cache.mu.Unlock()
			return principal, nil
		}
		if !entry.principal.ResolveValidUntil.After(now) {
			cache.removeEntry(entry)
		}
	}
	flight := cache.joinable(key)
	if cache.waiters >= resolveCacheWaiters || cache.scopeWaiters(key) >= resolveCacheScopeWaiters || flight == nil && cache.active >= resolveCacheScopes {
		cache.mu.Unlock()
		return Principal{}, resolveUnavailable()
	}
	if flight == nil {
		if knownSID == "" {
			for other := range cache.byToken[key.token] {
				knownSID = cache.entries[other].principal.SessionID
				break
			}
		}
		flight = client.startResolveLocked(ctx, key, accessToken, knownSID, false)
	} else {
		decision.source = "shared"
	}
	flight.waiters++
	cache.waiters++
	cache.mu.Unlock()
	return cache.wait(ctx, flight, decision)
}

func (cache *resolveCache) freshProof(now time.Time) bool {
	return !cache.proof.IsZero() && !cache.proof.After(now) && now.Sub(cache.proof) < cache.config.TTL
}

// The feed owner calls this only after a validated short terminal page has
// reached every consumer. The timestamp is the actual page RPC's start.
func (client *Client) SessionFeedCaughtUp(started time.Time) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		if !cache.closed && !started.IsZero() && !started.After(time.Now()) && started.After(cache.proof) {
			cache.proof = started
		}
	}
}

func (cache *resolveCache) store(key resolveKey, principal Principal) {
	charge := resolveCacheEntryCharge
	for _, value := range []string{key.profile, key.agent, principal.UserID, principal.OrganizationID,
		principal.MembershipID, principal.OrganizationSlug, principal.OrganizationName, principal.SystemRole,
		principal.OrganizationRole, principal.CallerContext, principal.SessionID} {
		charge += len(value)
	}
	if previous := cache.entries[key]; previous != nil {
		cache.removeEntry(previous)
	}
	if charge > resolveCacheEntryBytes {
		return // A valid larger live result is still returned to its waiters.
	}
	for len(cache.entries) >= cache.config.Size || cache.bytes+charge > resolveCacheMaximumBytes {
		cache.removeEntry(cache.lru.Back().Value.(*resolveEntry))
	}
	entry := &resolveEntry{key: key, principal: principal, charge: charge, nextRefresh: principal.ResolveStartedAt.Add(cache.config.TTL / 2)}
	entry.position = cache.lru.PushFront(entry)
	cache.entries[key] = entry
	cache.bytes += charge
	indexResolveEntry(cache.bySID, principal.SessionID, key)
	indexResolveEntry(cache.byUser, principal.UserID, key)
	indexResolveEntry(cache.byToken, key.token, key)
}

func indexResolveEntry[T comparable](index map[T]map[resolveKey]struct{}, subject T, key resolveKey) {
	if index[subject] == nil {
		index[subject] = make(map[resolveKey]struct{})
	}
	index[subject][key] = struct{}{}
}

func unindexResolveEntry[T comparable](index map[T]map[resolveKey]struct{}, subject T, key resolveKey) {
	delete(index[subject], key)
	if len(index[subject]) == 0 {
		delete(index, subject)
	}
}

func (cache *resolveCache) removeEntry(entry *resolveEntry) {
	delete(cache.entries, entry.key)
	cache.lru.Remove(entry.position)
	cache.bytes -= entry.charge
	unindexResolveEntry(cache.bySID, entry.principal.SessionID, entry.key)
	unindexResolveEntry(cache.byUser, entry.principal.UserID, entry.key)
	unindexResolveEntry(cache.byToken, entry.key.token, entry.key)
}

func earliestTime(first time.Time, others ...time.Time) time.Time {
	for _, value := range others {
		if value.Before(first) {
			first = value
		}
	}
	return first
}

func resolveUnavailable() error {
	return &RemoteError{StatusCode: http.StatusServiceUnavailable, Code: "identity_unavailable", Message: "Identity resolution unavailable", Retryable: true}
}
