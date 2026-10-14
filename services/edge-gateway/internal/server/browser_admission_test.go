package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type browserAdmissionIdentity struct {
	identityServiceStub
	resolve func(context.Context) identity.Principal
}

func (s *browserAdmissionIdentity) Resolve(ctx context.Context, _ string) (identity.Principal, error) {
	return s.resolve(ctx), nil
}

func TestBrowserAdmissionChecksAuthorityAfterResolveReturns(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/session"}, {"GET", "/api/admin/directory"},
		{"GET", "/api/app/workspace/v1/bootstrap"}, {"GET", "/workspace/agent-1"},
		{"DELETE", "/api/session"},
	} {
		for _, reason := range []string{"idle-equality", "idle-crossed", "absolute-equality", "absolute-crossed", "missing-deadline", "missing-hint", "late-success"} {
			t.Run(route.method+route.path+"/"+reason, func(t *testing.T) {
				now := time.Now()
				current := now
				principal := administratorPrincipal()
				principal.ExpiresAt, principal.IdleExpiresAt = now.Add(time.Hour), now.Add(time.Minute)
				stub := &browserAdmissionIdentity{}
				stub.resolve = func(ctx context.Context) identity.Principal {
					switch reason {
					case "idle-equality":
						current = principal.IdleExpiresAt
					case "idle-crossed":
						current = principal.IdleExpiresAt.Add(time.Nanosecond)
					case "absolute-equality", "absolute-crossed":
						principal.IdleExpiresAt = principal.ExpiresAt
						current = principal.ExpiresAt
						if reason == "absolute-crossed" {
							current = current.Add(time.Nanosecond)
						}
					case "missing-deadline":
						principal.IdleExpiresAt = time.Time{}
					case "missing-hint":
						principal.ActivityIntervalMS = 0
					case "late-success":
						<-ctx.Done()
					}
					return principal
				}
				h := newTestHandler(t, stub, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
					t.Error("invalid authority reached upstream")
				}), now).(*handler)
				h.now = func() time.Time { return current }
				h.requestTimeout = 5 * time.Millisecond
				r := newBrowserRequest(route.method, route.path, nil)
				addSessionCookies(r, "token", testCSRFToken)
				r.Header.Set(session.CSRFHeaderName, testCSRFToken)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				want, cookies := http.StatusUnauthorized, 0
				if strings.HasPrefix(route.path, "/workspace/") {
					want = http.StatusSeeOther
				}
				if route.method == "DELETE" {
					cookies = 2
				}
				if strings.HasPrefix(reason, "missing-") || reason == "late-success" {
					want, cookies = http.StatusServiceUnavailable, 0
				}
				if w.Code != want || len(w.Result().Cookies()) != cookies || stub.revokedAccessToken != "" {
					t.Fatalf("post-resolve admission: status=%d want=%d cookies=%d want=%d revoked=%v", w.Code, want, len(w.Result().Cookies()), cookies, stub.revokedAccessToken != "")
				}
			})
		}
	}
}
