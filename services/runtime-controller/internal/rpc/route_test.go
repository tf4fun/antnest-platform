package rpc

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestDeadlinePreservesMatchedRouteForObservability(t *testing.T) {
	handler := newTestHandler(t, &fakeService{})
	for _, item := range []struct {
		method  string
		path    string
		pattern string
	}{
		{http.MethodGet, "/status", "GET /status"},
		{http.MethodGet, "/internal/runtimes/agent-1", "GET /internal/runtimes/{agent_id}"},
		{http.MethodPost, "/internal/runtimes/agent-1/disable", "POST /internal/runtimes/{agent_id}/disable"},
		{http.MethodDelete, "/internal/runtimes/agent-1/disable", "/internal/runtimes/{agent_id}/disable"},
		{http.MethodGet, "/not-a-route", "/"},
	} {
		t.Run(item.method+item.path, func(t *testing.T) {
			request := httptest.NewRequest(item.method, item.path, nil)
			handler.ServeHTTP(httptest.NewRecorder(), request)
			if request.Pattern != item.pattern {
				t.Fatalf("matched route = %q, want %q", request.Pattern, item.pattern)
			}
		})
	}
}
