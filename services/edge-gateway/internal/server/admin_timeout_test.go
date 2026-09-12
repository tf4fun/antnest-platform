package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"soft/antnest-platform/services/edge-gateway/internal/session"
)

func TestAdminProxyBoundsForwardingWithoutRetryingWrites(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			gateway := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.NotFoundHandler(), time.Now()).(*handler)
			gateway.requestTimeout = 20 * time.Millisecond
			calls := 0
			gateway.adminProxy.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				deadline, ok := request.Context().Deadline()
				if !ok || time.Until(deadline) > 50*time.Millisecond {
					t.Error("ordinary proxy has no configured deadline")
					return nil, context.DeadlineExceeded
				}
				<-request.Context().Done()
				return nil, request.Context().Err()
			})
			request := httptest.NewRequest(method, "/api/admin/agents", nil)
			addSessionCookies(request, "token-1", "csrf-1")
			request.Header.Set(session.CSRFHeaderName, "csrf-1")
			response := httptest.NewRecorder()
			gateway.ServeHTTP(response, request)
			if calls != 1 || response.Code != http.StatusServiceUnavailable {
				t.Fatalf("calls=%d status=%d", calls, response.Code)
			}
		})
	}
}

func TestAdminEventWatchUsesStreamLeaseNotOrdinaryTimeout(t *testing.T) {
	gateway := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.NotFoundHandler(), time.Now()).(*handler)
	gateway.requestTimeout = 10 * time.Millisecond
	gateway.streamLease = time.Minute
	gateway.adminProxy.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		deadline, ok := request.Context().Deadline()
		if !ok || time.Until(deadline) < 30*time.Second {
			t.Error("watch inherited ordinary request timeout")
		}
		return httptest.NewRecorder().Result(), nil
	})
	request := httptest.NewRequest(http.MethodGet, "/api/admin/agents/agent-1/events/watch", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	gateway.ServeHTTP(httptest.NewRecorder(), request)
}
