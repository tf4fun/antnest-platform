package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const providerCreateBody = `{"provider_key":"deepseek","display_name":"DeepSeek","base_url":"https://api.deepseek.com","credential":{"method":"api_key","api_key":"synthetic-key"},"models":[{"display_name":"Flash","model":{"model":"flash","context_window":8192,"max_output_tokens":1024}}]}`

func modelCommandBody(path, name, model string) string {
	connection := ""
	if path == "/api/admin/model-profiles" {
		connection = `,"provider_connection_id":"connection-1"`
	} else {
		connection = `,"expected_version":1`
	}
	return `{"display_name":"` + name + `","model":` + model + connection + `}`
}

func TestProviderConnectionCreationShapesAndReplays(t *testing.T) {
	backend := newBackendStub()
	for range 2 {
		backend.enqueue(http.StatusCreated, `{"connection_id":"connection-1","credential_version":"v1","api_key":"must-not-leak","credential":{"api_key":"must-not-leak"}}`)
		response := catalogCreationRequest(newTestHandler(t, backend), "/api/admin/provider-connections", providerCreateBody, "org-1", "connect-request-01")
		if response.Code != http.StatusCreated || strings.Contains(response.Body.String(), "must-not-leak") {
			t.Fatalf("response=%d %s", response.Code, response.Body.String())
		}
	}
	if string(backend.calls[0].Body) != string(backend.calls[1].Body) {
		t.Fatal("identical retry changed connection or model identity")
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[0].Body, &payload)
	model := payload["models"].([]any)[0].(map[string]any)
	if payload["organization_id"] != "org-1" || model["profile_key"] == "" || model["profile_key"] == nil {
		t.Fatalf("missing authoritative identity: %v", payload)
	}
	if payload["credential"].(map[string]any)["api_key"] != "synthetic-key" {
		t.Fatal("write-only credential not forwarded")
	}
}

func TestProviderReadsAndRotationRemainScoped(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"items":[{"connection_id":"connection-1","credential_version":"v1","secret":"hidden"}],"next_after_id":"connection-2"}`)
	backend.enqueue(http.StatusOK, `{"connection_id":"connection-1","credential_version":"v1","organization_id":"org-1"}`)
	backend.enqueue(http.StatusConflict, `{"code":"conflict","message":"stale version"}`)
	h := newTestHandler(t, backend)
	response := requestAdmin(t, h, http.MethodGet, "/api/admin/provider-connections?after_id=connection-0&limit=25", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "connection-2") || strings.Contains(response.Body.String(), "hidden") {
		t.Fatalf("list=%s", response.Body.String())
	}
	response = requestAdmin(t, h, http.MethodGet, "/api/admin/provider-connections/connection-1", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "v1") || strings.Contains(response.Body.String(), "org-1") {
		t.Fatalf("get=%s", response.Body.String())
	}
	response = requestAdmin(t, h, http.MethodPost, "/api/admin/provider-connections/connection-1/credentials", `{"expected_version":"v1","credential":{"method":"api_key","api_key":"new-key"}}`)
	if response.Code != http.StatusConflict || len(backend.calls) != 3 {
		t.Fatal("rotation conflict retried or lost")
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[2].Body, &payload)
	if payload["organization_id"] != "org-1" || payload["expected_version"] != "v1" || payload["model"] != nil {
		t.Fatalf("rotation shape=%v", payload)
	}
	if !strings.Contains(backend.calls[0].Query, "organization_id=org-1") || backend.calls[1].Query != "organization_id=org-1" {
		t.Fatal("unscoped connection reads")
	}
}

func TestProviderRejectsBrowserAuthorityAndMissingModels(t *testing.T) {
	for _, field := range []string{"organization_id", "request_id", "models"} {
		t.Run(field, func(t *testing.T) {
			var body map[string]any
			decodeBytes(t, []byte(providerCreateBody), &body)
			if field == "models" {
				delete(body, field)
			} else {
				body[field] = "injected"
			}
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			backend := newBackendStub()
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/provider-connections", string(encoded))
			if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
				t.Fatalf("invalid input reached owner: %d", response.Code)
			}
		})
	}
}
