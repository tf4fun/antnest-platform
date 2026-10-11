package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/browserstream"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/streamio"
)

type browserStreamStartKey struct{}

func browserStreamRequest(request *http.Request) bool {
	if request.Method != http.MethodGet {
		return false
	}
	if isAgentEventWatch(request) || request.PathValue("acp_version") != "" {
		return true
	}
	if request.Pattern == "GET /api/app/agents/{agent_id}/state/watch" {
		return true
	}
	path := request.PathValue("path")
	agent, valid := workspaceBridgeAgentID(path)
	return strings.HasPrefix(request.URL.Path, "/api/app/workspace/v1/") && valid && agent != "" && path == "agents/"+agent+"/events"
}

func (h *handler) guardBrowserStream(response http.ResponseWriter, request *http.Request, token string, principal identity.Principal) (http.ResponseWriter, *http.Request, func(), error) {
	started, _ := request.Context().Value(browserStreamStartKey{}).(time.Time)
	profile, agent := callerSelection(request)
	parent := identity.WithResolution(request.Context(), profile, agent)
	cancelLease := func() {}
	websocket := webSocketUpgrade(request)
	if !websocket {
		parent, cancelLease = context.WithTimeout(parent, h.streamLease)
	}
	guard, err := browserstream.Start(parent, h.browserStreams, browserstream.Config{
		MaximumStale: h.maximumSessionStale, InitialStarted: started, Original: principal, DirectWebSocket: websocket,
		Resolve: func(ctx context.Context) (identity.Principal, error) {
			ctx, cancel := context.WithTimeout(ctx, h.requestTimeout)
			defer cancel()
			return h.identity.Resolve(identity.WithResolution(ctx, profile, agent), token)
		},
	})
	if err != nil {
		cancelLease()
		status, code := http.StatusServiceUnavailable, "identity_unavailable"
		if errors.Is(err, browserstream.ErrRejected) || errors.Is(err, browserstream.ErrCallerContextExpired) {
			status, code = http.StatusUnauthorized, "unauthenticated"
		}
		writeError(response, status, code, "Session could not be verified")
		return response, request, nil, err
	}
	finishWrites := func() {}
	if !websocket {
		response, finishWrites = streamio.CancelHTTPWrites(guard.Context(), response, h.logger)
	}
	finish := func() {
		guard.Close()
		finishWrites()
		cancelLease()
	}
	return response, request.WithContext(guard.Context()), finish, nil
}

// Existing per-message checks remain non-touch and preserve the same original
// authority. They do not refresh the background guard's stale deadline.
func (h *handler) validateStreamIdentity(ctx context.Context, token string, original identity.Principal) error {
	budget := min(h.requestTimeout, browserstream.Interval(h.maximumSessionStale, original.ActivityIntervalMS))
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	started := time.Now()
	current, err := h.identity.Resolve(ctx, token)
	if ctx.Err() != nil {
		return browserstream.ErrUnavailable
	}
	if err != nil {
		if identity.IsCode(err, "unauthenticated") || identity.IsCode(err, "inactive_principal") {
			return browserstream.ErrRejected
		}
		return browserstream.ErrUnavailable
	}
	if err := browserstream.Validate(current, original, time.Now()); err != nil {
		return err
	}
	_, err = browserstream.ValidateTiming(current, started, h.maximumSessionStale, time.Now())
	return err
}
