package server

import (
	"context"
	"errors"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStatusSeparatesLivenessAndReadiness(t *testing.T) {
	probe := &probeStub{}
	authentication, err := serviceauth.ParseReceiver("identity-service", []byte(`{}`), false)
	if err != nil {
		t.Fatal(err)
	}
	handler, readiness, err := NewHandler(probe, http.NotFoundHandler(), http.NotFoundHandler(), authentication)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"live":true`) {
		t.Fatalf("starting status=%d body=%s", response.Code, response.Body.String())
	}
	readiness.Set(true)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ready":true`) {
		t.Fatalf("ready status=%d body=%s", response.Code, response.Body.String())
	}
	probe.err = errors.New("database unavailable")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("dependency status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSCIMWorkloadCheckPreservesItsSeparateBearerCredential(t *testing.T) {
	authentication, err := serviceauth.ParseReceiver("identity-service", []byte(`{"edge-gateway":["sha256:ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	scim := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer scim-credential" {
			t.Fatal("SCIM credential changed")
		}
		w.WriteHeader(200)
	})
	handler, _, err := NewHandler(&probeStub{}, http.NotFoundHandler(), scim, authentication)
	if err != nil {
		t.Fatal(err)
	}
	for _, authenticated := range []bool{false, true} {
		request := httptest.NewRequest("GET", "/scim/v2/Users", nil)
		request.Header.Set("Authorization", "Bearer scim-credential")
		if authenticated {
			request.Header.Set(serviceauth.Header, "Bearer AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		want := 401
		if authenticated {
			want = 200
		}
		if response.Code != want {
			t.Fatalf("status=%d want=%d", response.Code, want)
		}
	}
	if calls != 1 {
		t.Fatalf("unauthenticated SCIM reached business handler: calls=%d", calls)
	}
}

type probeStub struct{ err error }

func (p *probeStub) Ping(context.Context) error { return p.err }
