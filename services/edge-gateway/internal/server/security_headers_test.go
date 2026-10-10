package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"reflect"
	"strings"
	"testing"
	"time"
)

const gatewayDefaultCSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'"

func assertDefaultSecurityHeaders(t *testing.T, header http.Header) {
	t.Helper()
	for name, expected := range map[string]string{
		"Content-Security-Policy":      gatewayDefaultCSP,
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "same-origin",
		"X-Frame-Options":              "DENY",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
	} {
		if values := header.Values(name); !reflect.DeepEqual(values, []string{expected}) {
			t.Errorf("%s=%q; want exactly one %q", name, values, expected)
		}
	}
}

func TestSecurityHeadersPreserveUpstreamPolicy(t *testing.T) {
	const nonce = "workspace-document-nonce"
	const policy = "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-ancestors 'none'"
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			upstream := http.Header{
				"Content-Security-Policy": {policy},
				"X-Content-Type-Options":  {"nosniff"},
				"Referrer-Policy":         {"no-referrer"},
				"X-Frame-Options":         {"SAMEORIGIN"},
			}
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
				http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
					for name, values := range upstream {
						for _, value := range values {
							response.Header().Add(name, value)
						}
					}
					response.Header().Set("Content-Type", "text/html; charset=utf-8")
					response.WriteHeader(http.StatusOK)
					if method == http.MethodGet {
						_, _ = fmt.Fprintf(response, `<script nonce="%s">window.revealed=true</script>`, nonce)
					}
				}), time.Now())
			request := httptest.NewRequest(method, "/workspace/agent-1/sessions/session-1", nil)
			addSessionCookies(request, "token-1", testCSRFToken)
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			for name, expected := range upstream {
				if values := response.Result().Header.Values(name); !reflect.DeepEqual(values, expected) {
					t.Errorf("proxied %s=%q; want unchanged upstream %q", name, values, expected)
				}
			}
			if method == http.MethodGet && !strings.Contains(response.Body.String(), `nonce="`+nonce+`"`) {
				t.Fatal("proxied document lost its nonce-tagged script")
			}
		})
	}
}

func TestSecurityHeadersDefaultOnGatewayResponses(t *testing.T) {
	h := newTestHandler(t, &identityServiceStub{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("Gateway-generated response reached an upstream")
	}), time.Now())
	for _, test := range []struct {
		name, method, path string
		status             int
	}{
		{"status", http.MethodGet, "/status", http.StatusOK},
		{"not found", http.MethodGet, "/api/not-found", http.StatusNotFound},
		{"workspace redirect", http.MethodGet, "/workspace", http.StatusTemporaryRedirect},
		{"login redirect", http.MethodGet, "/workspace/agent-1/", http.StatusSeeOther},
		{"unauthenticated API", http.MethodGet, "/api/session", http.StatusUnauthorized},
		{"method rejection", http.MethodPost, "/workspace/", http.StatusMethodNotAllowed},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			h.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != test.status {
				t.Fatalf("status=%d; want %d", response.Code, test.status)
			}
			assertDefaultSecurityHeaders(t, response.Result().Header)
		})
	}
}

func TestSecurityHeadersDefaultOnProxiedAssets(t *testing.T) {
	for _, path := range []string{"/assets/console.js", "/workspace/assets/entry-client.js"} {
		t.Run(path, func(t *testing.T) {
			h := newTestHandler(t, &identityServiceStub{}, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "text/javascript")
				_, _ = response.Write([]byte("export const ready = true;"))
			}), time.Now())
			response := httptest.NewRecorder()
			h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusOK || response.Body.String() != "export const ready = true;" {
				t.Fatalf("proxied asset status=%d body=%s", response.Code, response.Body.String())
			}
			assertDefaultSecurityHeaders(t, response.Result().Header)
		})
	}
}

func TestSecurityHeadersPreserveMultipleUpstreamPoliciesAndDefaultMissingHeaders(t *testing.T) {
	policies := []string{"default-src 'self'", "script-src 'self' 'nonce-second-policy'"}
	h := newTestHandler(t, &identityServiceStub{}, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		for _, policy := range policies {
			response.Header().Add("Content-Security-Policy", policy)
		}
		response.WriteHeader(http.StatusNoContent)
	}), time.Now())
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/workspace/assets/no-body.js", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d", response.Code)
	}
	header := response.Result().Header
	if values := header.Values("Content-Security-Policy"); !reflect.DeepEqual(values, policies) {
		t.Errorf("upstream policies=%q; want unchanged %q", values, policies)
	}
	for name, expected := range map[string]string{
		"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
	} {
		if values := header.Values(name); !reflect.DeepEqual(values, []string{expected}) {
			t.Errorf("missing upstream %s=%q; want default %q once", name, values, expected)
		}
	}
}

func TestSecurityHeadersCoverImplicitCommits(t *testing.T) {
	for _, test := range []struct {
		name   string
		handle http.HandlerFunc
	}{
		{"write", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("body")) }},
		{"empty", func(http.ResponseWriter, *http.Request) {}},
		{"flush", func(w http.ResponseWriter, _ *http.Request) {
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Errorf("flush: %v", err)
			}
		}},
		{"flusher", func(w http.ResponseWriter, _ *http.Request) { w.(http.Flusher).Flush() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newTestHandler(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now()).(*handler)
			h.mux.HandleFunc("GET /test-security-commit", test.handle)
			response := httptest.NewRecorder()
			h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/test-security-commit", nil))
			assertDefaultSecurityHeaders(t, response.Result().Header)
		})
	}
}

func TestSecurityHeadersWaitForFinalResponseAfterEarlyHints(t *testing.T) {
	const policy = "script-src 'self' 'nonce-final-document'"
	h := newTestHandler(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now()).(*handler)
	h.mux.HandleFunc("GET /test-security-hints", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", "</workspace/assets/app.js>; rel=preload; as=script")
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Set("Content-Security-Policy", policy)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("document"))
	})
	edge := httptest.NewServer(h)
	defer edge.Close()
	hints := make(chan http.Header, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		Got1xxResponse: func(status int, header textproto.MIMEHeader) error {
			if status != http.StatusEarlyHints {
				t.Errorf("interim status=%d", status)
			}
			hints <- http.Header(header).Clone()
			return nil
		},
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, edge.URL+"/test-security-hints", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := edge.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || string(body) != "document" {
		t.Fatalf("final status=%d body=%q err=%v", response.StatusCode, body, err)
	}
	if values := response.Header.Values("Content-Security-Policy"); !reflect.DeepEqual(values, []string{policy}) {
		t.Errorf("final CSP=%q; want %q once", values, policy)
	}
	select {
	case header := <-hints:
		if values := header.Values("Content-Security-Policy"); len(values) != 0 {
			t.Errorf("Gateway default was committed on interim 103: %q", values)
		}
	default:
		t.Fatal("early hints were not forwarded")
	}
}
