package identity

import "crypto/sha256"

// ApplySessionRevocation receives a validated event from the process-owned
// feed. Unknown in-flight SIDs use a conservative barrier without tombstones.
func (client *Client) ApplySessionRevocation(event SessionRevocation) {
	if cache := client.cache; cache != nil {
		cache.mu.Lock()
		defer cache.mu.Unlock()
		cache.epoch++
		for key := range cache.bySID[event.TokenID] {
			cache.removeEntry(cache.entries[key])
		}
	}
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
		for key := range cache.bySID[sid] {
			cache.invalidateToken(key.token)
		}
		for flight := range cache.retained {
			if flight.knownSID == sid || flight.completed && flight.principal.SessionID == sid {
				flight.invalidated = true
				flight.cancel()
			}
		}
		// Activity must not advance the global generation: ordinary activity
		// cannot starve unrelated Users. A truly cold unknown SID may deliver
		// its still-valid older idle observation, never a patched CCT/deadline.
	}
}
