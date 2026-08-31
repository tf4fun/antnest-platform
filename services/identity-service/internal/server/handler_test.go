package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStatusSeparatesLivenessAndReadiness(t *testing.T) {
	probe := &probeStub{}
	handler, readiness, err := NewHandler(probe, http.NotFoundHandler(), http.NotFoundHandler())
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

type probeStub struct{ err error }

func (p *probeStub) Ping(context.Context) error { return p.err }
