package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestSessionAdmissionDistinguishesInvalidFromUnavailable(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		active bool
		status int
		clear  bool
	}{
		{"expired or revoked", &identity.RemoteError{Code: "unauthenticated", StatusCode: 401}, true, 401, true},
		{"inactive error", &identity.RemoteError{Code: "inactive_principal", StatusCode: 401}, true, 401, true},
		{"inactive principal", nil, false, 401, true},
		{"timeout", context.DeadlineExceeded, true, 503, false},
		{"transport", errors.New("upstream transport unavailable"), true, 503, false},
		{"server error", &identity.RemoteError{Code: "internal_error", StatusCode: 500}, true, 503, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			principal := ordinaryPrincipal()
			principal.Active = test.active
			upstream := &identityServiceStub{resolvePrincipal: principal, resolveErr: test.err}
			handler := newTestHandler(t, upstream, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("rejected request reached downstream")
			}), time.Now())
			for _, path := range []string{"/api/session", "/api/admin/directory", "/api/app/bootstrap"} {
				request := httptest.NewRequest(http.MethodGet, path, nil)
				request.Header.Set("Cookie", "antnest_session=token-1; antnest_csrf=csrf-1")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != test.status {
					t.Fatalf("%s status=%d, want=%d", path, response.Code, test.status)
				}
				cookies := response.Result().Cookies()
				wantCount := 0
				if test.clear {
					wantCount = 2
				}
				if len(cookies) != wantCount {
					t.Fatal("incorrect session cookie invalidation")
				}
				seen := map[string]bool{}
				for _, cookie := range cookies {
					if seen[cookie.Name] || (cookie.Name != "antnest_session" && cookie.Name != "antnest_csrf") || cookie.Value != "" || cookie.MaxAge >= 0 {
						t.Fatal("rejected session cookie was not expired")
					}
					seen[cookie.Name] = true
				}
			}
		})
	}
}
