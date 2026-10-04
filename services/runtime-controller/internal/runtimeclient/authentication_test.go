package runtimeclient

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
)

func TestStatusCredentialIsRereadAndNeverFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "antnest-runtime")
	token := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	count := 0
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		count++
		if r.Header.Get(serviceauth.Header) != "Bearer "+token {
			t.Fatal("missing instance status authority")
		}
		return &http.Response{StatusCode: 200, Status: "200 OK", Body: io.NopCloser(strings.NewReader(`{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready"}`))}, nil
	})
	client, err := NewAuthenticated(&http.Client{Transport: transport}, time.Second, func(context.Context, deployment.Inspection) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	inspection := deployment.Inspection{AgentID: "agent-1", Generation: 7, StatusEndpoint: "http://runtime.internal:8093/status"}
	if _, err := client.Verify(context.Background(), inspection); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Verify(context.Background(), inspection); err == nil || count != 1 {
		t.Fatal("cached or anonymous fallback used")
	}
	for _, target := range []string{"http://runtime.internal:8093/status/live", "http://runtime.internal:8093/status?x=1", "http://user@runtime.internal:8093/status"} {
		inspection.StatusEndpoint = target
		if _, err := client.Verify(context.Background(), inspection); err == nil || count != 1 {
			t.Fatal("untrusted status target used")
		}
	}
}
