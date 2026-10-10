package server

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestPublicOriginAdmissionUsesConfiguredBoundary(t *testing.T) {
	for _, fixture := range []struct {
		name, public, origin, host string
		tls, allowed               bool
	}{
		{"proxy HTTPS", "https://antnest.example", "https://antnest.example", "edge.internal:8080", false, true},
		{"canonical HTTPS default port", "https://Antnest.Example:0443", "https://antnest.example", "edge.internal:8080", false, true},
		{"canonical HTTP default port", "http://127.0.0.1:80", "http://127.0.0.1", "edge.internal:8080", false, true},
		{"native TLS", "https://antnest.example", "https://antnest.example", "wrong.example", true, true},
		{"loopback public port", "http://127.0.0.1:8090", "http://127.0.0.1:8090", "edge.internal:8080", false, true},
		{"wrong scheme", "https://antnest.example", "http://antnest.example", "antnest.example", false, false},
		{"wrong port", "https://antnest.example", "https://antnest.example:444", "antnest.example:444", true, false},
		{"forged Host", "https://antnest.example", "https://evil.example", "evil.example", true, false},
		{"origin path", "https://antnest.example", "https://antnest.example/", "antnest.example", true, false},
		{"empty query", "https://antnest.example", "https://antnest.example?", "antnest.example", true, false},
		{"opaque null", "https://antnest.example", "null", "antnest.example", true, false},
		{"direct loopback", "", "http://127.0.0.1:8080", "127.0.0.1:8080", false, true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			h := newTestHandlerWithConfig(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now(), Config{PublicOrigin: fixture.public})
			r := httptest.NewRequest(http.MethodGet, "http://"+fixture.host+"/api/app/workspace/v1/bootstrap", nil)
			r.Header.Set("Origin", fixture.origin)
			r.Header.Set("X-Forwarded-Host", "evil.example")
			r.Header.Set("X-Forwarded-Proto", "https")
			if fixture.tls {
				r.TLS = &tls.ConnectionState{}
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			want := http.StatusForbidden
			if fixture.allowed {
				want = http.StatusUnauthorized
			}
			if w.Code != want {
				t.Fatalf("status=%d want=%d", w.Code, want)
			}
		})
	}
}

func TestPublicEntryRebuildsForwardingHeaders(t *testing.T) {
	for _, path := range []string{"/", "/scim/v2/Users", "/api/admin/overview", "/workspace/", "/api/app/workspace/v1/bootstrap", "/api/app/agents/agent-1/v1/acp"} {
		t.Run(path, func(t *testing.T) {
			var headers http.Header
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				headers = r.Header.Clone()
				w.Header().Add("Strict-Transport-Security", "max-age=0")
				w.Header().Add("Strict-Transport-Security", "malicious")
				w.WriteHeader(http.StatusOK)
			})
			h := newTestHandlerWithConfig(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, upstream, time.Now(), Config{
				PublicOrigin: "https://antnest.example:8443", TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.1.0.0/24")},
			})
			r := httptest.NewRequest(http.MethodGet, "http://edge.internal:8080"+path, nil)
			r.RemoteAddr = "10.1.0.2:43100"
			r.Header.Set("Origin", "https://antnest.example:8443")
			r.Header.Set("X-Forwarded-For", "198.51.100.99, 192.0.2.10, 10.1.0.3")
			r.Header.Set("X-Forwarded-Host", "evil.example")
			r.Header.Set("X-Forwarded-Proto", "http")
			r.Header.Set("X-Forwarded-Secret", "forged")
			r.Header.Set("Forwarded", "for=evil;proto=http")
			r.Header.Set("X-Real-IP", "198.51.100.99")
			addSessionCookies(r, "token-1", testCSRFToken)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusOK || headers == nil {
				t.Fatalf("status=%d, upstream=%v", w.Code, headers != nil)
			}
			for name, want := range map[string]string{"X-Forwarded-For": "192.0.2.10", "X-Forwarded-Host": "antnest.example:8443", "X-Forwarded-Proto": "https"} {
				values := headers.Values(name)
				if len(values) != 1 || values[0] != want {
					t.Errorf("%s=%v want=%s", name, values, want)
				}
			}
			for _, name := range []string{"Forwarded", "X-Real-IP", "X-Forwarded-Secret"} {
				if headers.Get(name) != "" {
					t.Errorf("untrusted %s survived", name)
				}
			}
			if got := w.Header().Values("Strict-Transport-Security"); len(got) != 1 || got[0] != "max-age=31536000" {
				t.Errorf("HSTS=%v", got)
			}
		})
	}
}

func TestProxyClientAddressControlsLoginSourceAdmission(t *testing.T) {
	for _, fixture := range []struct {
		name, peer, first, second string
		distinct                  bool
	}{
		{"two clients", "10.1.0.2:8080", "192.0.2.10", "192.0.2.11", true},
		{"trusted chain", "10.1.0.2:8080", "198.51.100.99, 192.0.2.10, 10.1.0.3", "198.51.100.98, 192.0.2.11, 10.1.0.3", true},
		{"spoofed prefix", "10.1.0.2:8080", "198.51.100.99, 192.0.2.10", "198.51.100.98, 192.0.2.10", false},
		{"untrusted peer", "192.0.2.10:8080", "198.51.100.99", "198.51.100.98", false},
		{"malformed nearest hop", "10.1.0.2:8080", "192.0.2.10, invalid", "192.0.2.11, invalid", false},
		{"empty nearest hop", "10.1.0.2:8080", "192.0.2.10,", "192.0.2.11,", false},
		{"all trusted", "10.1.0.2:8080", "10.1.0.3", "10.1.0.4", false},
		{"IPv4 mapped", "[::ffff:10.1.0.2]:8080", "::ffff:192.0.2.10", "192.0.2.10", false},
		{"IPv6 clients", "[fd00::2]:8080", "2001:db8::10", "2001:db8::11", true},
		{"zone rejected", "10.1.0.2:8080", "fe80::1%eth0", "fe80::2%eth0", false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			h := newTestHandlerWithConfig(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now(), Config{
				PublicOrigin: "https://antnest.example", TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.1.0.0/24"), netip.MustParsePrefix("fd00::/64")}, LoginSourceMax: 1, LoginAccountMax: 100,
			})
			for index, chain := range []string{fixture.first, fixture.second} {
				r := httptest.NewRequest(http.MethodPost, "/api/session/login", strings.NewReader(fmt.Sprintf(`{"organization_slug":"demo","email":"user%d@example.com","password":"wrong"}`, index)))
				r.Header.Set("Origin", "https://antnest.example")
				r.RemoteAddr = fixture.peer
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("X-Forwarded-For", chain)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				want := http.StatusUnauthorized
				if index == 1 && !fixture.distinct {
					want = http.StatusTooManyRequests
				}
				if w.Code != want {
					t.Fatalf("attempt=%d status=%d want=%d", index, w.Code, want)
				}
			}
		})
	}
}

func TestPublicEntryRejectsDuplicateOrigin(t *testing.T) {
	h := newTestHandlerWithConfig(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now(), Config{PublicOrigin: "https://antnest.example"})
	r := httptest.NewRequest(http.MethodGet, "https://antnest.example/api/app/workspace/v1/bootstrap", nil)
	r.Header.Add("Origin", "https://antnest.example")
	r.Header.Add("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("duplicate Origin status=%d", w.Code)
	}
}

func TestPublicEntryDistinguishesAbsentAndEmptyOrigin(t *testing.T) {
	for _, path := range []string{"/api/app/workspace/v1/bootstrap", "/api/app/agents/agent-1/state", "/api/app/agents/agent-1/v1/acp"} {
		for _, fixture := range []struct {
			name    string
			origins []string
			status  int
		}{
			{"absent", nil, http.StatusUnauthorized},
			{"empty", []string{""}, http.StatusForbidden},
			{"first empty duplicate", []string{"", "https://evil.example"}, http.StatusForbidden},
		} {
			t.Run(path+"/"+fixture.name, func(t *testing.T) {
				h := newTestHandlerWithConfig(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now(), Config{PublicOrigin: "https://antnest.example"})
				r := httptest.NewRequest(http.MethodGet, "https://antnest.example"+path, nil)
				for _, origin := range fixture.origins {
					r.Header.Add("Origin", origin)
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != fixture.status {
					t.Fatalf("status=%d want=%d", w.Code, fixture.status)
				}
			})
		}
	}
}
