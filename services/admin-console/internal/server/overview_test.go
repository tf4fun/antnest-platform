package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestOverviewPreservesFailureStatusAtBrowserBoundary(t *testing.T) {
	for _, section := range []struct {
		key  string
		path string
	}{
		{key: "agents", path: "/internal/agents"},
		{key: "directory", path: "/rpc/identity/list-directory"},
		{key: "model_profiles", path: "/internal/model-profiles"},
		{key: "templates", path: "/internal/agent-templates"},
	} {
		for _, status := range []int{403, 404, 410, 429, 503} {
			t.Run(fmt.Sprintf("%s/%d", section.key, status), func(t *testing.T) {
				backend := newBackendStub()
				for path, body := range map[string]string{
					"/internal/agents":             `{"items":[],"next_cursor":"more-agents"}`,
					"/rpc/identity/list-directory": `{"users":[],"groups":[]}`,
					"/internal/model-profiles":     `{"items":[]}`,
					"/internal/agent-templates":    `{"items":[]}`,
				} {
					if path == section.path {
						backend.enqueueFor(path, status, `{"message":"private.internal credential-detail"}`)
					} else {
						backend.enqueueFor(path, http.StatusOK, body)
					}
				}
				response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/overview", "")
				wantStatus := http.StatusOK
				if section.key == "agents" {
					wantStatus = status
				}
				if response.Code != wantStatus {
					t.Fatalf("status=%d want=%d body=%s", response.Code, wantStatus, response.Body.String())
				}
				if strings.Contains(response.Body.String(), "private.internal") || strings.Contains(response.Body.String(), "credential-detail") {
					t.Fatalf("upstream diagnostic leaked: %s", response.Body.String())
				}
				if section.key == "agents" {
					return
				}
				var payload map[string]struct {
					Status string `json:"status"`
					Error  *struct {
						Status  int    `json:"status"`
						Message string `json:"message"`
					} `json:"error"`
				}
				decodeBytes(t, response.Body.Bytes(), &payload)
				failure := payload[section.key]
				if failure.Error == nil || failure.Error.Status != status || failure.Error.Message == "" {
					t.Fatalf("missing safe failure status: %s", response.Body.String())
				}
				if payload["agents"].Status != "available" || !strings.Contains(response.Body.String(), "more-agents") {
					t.Fatalf("optional failure erased fleet snapshot: %s", response.Body.String())
				}
			})
		}
	}
}

func TestOverviewRejectsMalformedRequiredProjection(t *testing.T) {
	backend := newBackendStub()
	backend.enqueueFor("/internal/agents", http.StatusOK, `not-json`)
	backend.enqueueFor("/rpc/identity/list-directory", http.StatusOK, `{"users":[],"groups":[]}`)
	backend.enqueueFor("/internal/model-profiles", http.StatusOK, `{"items":[]}`)
	backend.enqueueFor("/internal/agent-templates", http.StatusOK, `{"items":[]}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/overview", "")
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
