package tunnelclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

func TestPrivateRegistrationRejectsRedirectAndClassifiesOutage(t *testing.T) {
	status := http.StatusNoContent
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { destinationCalls++; w.WriteHeader(204) }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" || r.URL.Path != "/internal/agent-tunnel-keys/agent_a" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Antnest-Caller-Context") != "" {
			t.Error("wrong private registration boundary")
		}
		if status == 302 {
			w.Header().Set("Location", destination.URL)
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	client, err := New(server.URL, server.Client(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Register(context.Background(), "agent_a", instanceauth.TunnelRegistration{}); err != nil {
		t.Fatal(err)
	}
	status = 503
	if err := client.Register(context.Background(), "agent_a", instanceauth.TunnelRegistration{}); !errors.Is(err, instanceauth.ErrTunnelRegistrationUnavailable) {
		t.Fatal("outage was not retryable", err)
	}
	status = 302
	if err := client.Register(context.Background(), "agent_a", instanceauth.TunnelRegistration{}); !errors.Is(err, instanceauth.ErrTunnelRegistrationRejected) {
		t.Fatal("redirect followed", err)
	}
	if destinationCalls != 0 {
		t.Fatal("private material sent to redirect target")
	}
}
