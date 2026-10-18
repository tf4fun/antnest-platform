package server

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestNetworkPolicyProjectsPendingWithoutPrivatePeerOrTrafficClaim(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, strings.Replace(networkViewFixture(), `"closed"`, `"pending"`, 1))
	response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	want := map[string]any{"agent_id": "agent-1", "action": "deny_all", "resource_version": float64(7), "attachment": map[string]any{"state": "pending", "resource_version": float64(4)}}
	if !reflect.DeepEqual(value, want) || len(backend.calls) != 1 {
		t.Fatalf("projection=%v calls=%v", value, backend.calls)
	}
}

func TestPendingNetworkProjectionStillRejectsUnsafeVersions(t *testing.T) {
	for _, version := range []string{"0", "9007199254740992"} {
		backend := newBackendStub()
		body := strings.Replace(networkViewFixture(), `"closed"`, `"pending"`, 1)
		body = strings.Replace(body, `"resource_version":4`, `"resource_version":`+version, 1)
		backend.enqueue(http.StatusOK, body)
		response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
		if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "private") || len(backend.calls) != 1 {
			t.Fatalf("unsafe pending version: %d %s", response.Code, response.Body.String())
		}
	}
}
