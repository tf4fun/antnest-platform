package identity

import "crypto/sha256"

// ApplySessionRevocation receives a validated event from the process-owned
// feed. The fixed digest window also fences work whose SID is not known yet.
func (client *Client) ApplySessionRevocation(event SessionRevocation) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		cache.recordSessionRevocation(event.TokenID)
		for key := range cache.bySID[event.TokenID] {
			cache.removeEntry(cache.entries[key])
		}
	}
}

// Called under the cache lock. Producer sequence gaps do not consume space;
// only an event actually applied to this client advances the local counter.
func (cache *resolveCache) recordSessionRevocation(sid string) {
	if cache.revocationCount == ^uint64(0) {
		// A reset must not make an old flight look newer than its history.
		// Keep ownership until its normal RPC cleanup and final delivery.
		for flight := range cache.retained {
			flight.invalidated = true
		}
		cache.revocationCount = 0
		clear(cache.revocations[:])
	}
	cache.revocationCount++
	cache.revocations[cache.revocationCount%resolveCacheRevocations] = sha256.Sum256([]byte(sid))
}

// Called under the cache lock with the original work-creation anchor. An
// unknown SID can be checked for overflow, then checked by its trusted value
// before storage and final delivery. The fixed window retains no SID strings.
func (cache *resolveCache) sessionRevokedSince(start uint64, sid string) bool {
	if start > cache.revocationCount || cache.revocationCount-start > resolveCacheRevocations {
		return true
	}
	if sid == "" {
		return false
	}
	digest := sha256.Sum256([]byte(sid))
	for sequence := cache.revocationCount; sequence > start; sequence-- {
		if cache.revocations[sequence%resolveCacheRevocations] == digest {
			return true
		}
	}
	return false
}

func (cache *resolveCache) invalidateToken(token [sha256.Size]byte) {
	for key := range cache.byToken[token] {
		cache.removeEntry(cache.entries[key])
	}
	for flight := range cache.retained {
		if flight.key.token == token {
			flight.invalidated = true
			flight.cancel()
		}
	}
}

func (client *Client) invalidateAccessToken(token string) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		cache.invalidateToken(sha256.Sum256([]byte(token)))
	}
}

func (client *Client) invalidateUser(userID string) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		// A cold in-flight token may belong to this User in any Organization.
		// Fence those unknown results without retaining unbounded tombstones.
		cache.epoch++
		for key := range cache.byUser[userID] {
			cache.invalidateToken(key.token)
		}
	}
}

func (client *Client) invalidateActivity(sid string) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		// SID evidence may survive only in retained work after the first
		// activity has evicted entries. Collect it before removing anything;
		// the temporary set is bounded by existing entries and work slots.
		tokens := make(map[[sha256.Size]byte]struct{})
		for key := range cache.bySID[sid] {
			tokens[key.token] = struct{}{}
			cache.removeEntry(cache.entries[key])
		}
		for flight := range cache.retained {
			if flight.knownSID == sid || flight.completed && flight.principal.SessionID == sid {
				tokens[flight.key.token] = struct{}{}
			}
		}
		for flight := range cache.retained {
			if _, known := tokens[flight.key.token]; known {
				// Existing readers keep their original authority and deadlines.
				// Later readers start new work; old results cannot refill cache.
				flight.activityObsolete = true
			}
		}
		// Activity must not advance the global generation: ordinary activity
		// cannot starve unrelated Users. A truly cold unknown SID may deliver
		// its still-valid older idle observation, never a patched CCT/deadline.
	}
}
