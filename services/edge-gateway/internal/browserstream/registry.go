package browserstream

import (
	"sync"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

// Registry stores only currently active streams, never historical revocations.
// Construction starts no goroutines; main separately owns the feed poller.
type Registry struct {
	mu       sync.Mutex
	sessions map[string]map[*Guard]struct{}
}

func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]map[*Guard]struct{})}
}

func (registry *Registry) register(guard *Guard) func() {
	sid := guard.original.SessionID
	registry.mu.Lock()
	if registry.sessions[sid] == nil {
		registry.sessions[sid] = make(map[*Guard]struct{})
	}
	registry.sessions[sid][guard] = struct{}{}
	registry.mu.Unlock()
	return func() {
		registry.mu.Lock()
		defer registry.mu.Unlock()
		delete(registry.sessions[sid], guard)
		if len(registry.sessions[sid]) == 0 {
			delete(registry.sessions, sid)
		}
	}
}

func (registry *Registry) Revoke(event identity.SessionRevocation) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for guard := range registry.sessions[event.TokenID] {
		if guard.original.UserID == event.UserID && guard.original.OrganizationID == event.OrganizationID {
			guard.cancel(ErrRejected)
		}
	}
}
