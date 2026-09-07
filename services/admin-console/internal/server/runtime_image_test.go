package server

import (
	"net/http"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/upstream"
)

func TestTemplateTagChoiceDelegatesToCatalogWithoutResolvingInConsole(t *testing.T) {
	for _, path := range []string{"/api/admin/templates", "/api/admin/templates/template-1/revisions"} {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, `{"template_id":"template-1","runtime":{"image_ref":"sha256:`+strings.Repeat("a", 64)+`","image_source":"antnest/runtime:local","registry_password":"must-not-reach-browser","resources":{}}}`)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path, `{
				"name":"Template","model_profile_revision_id":"model-1","max_model_requests":32,
				"runtime":{"image_ref":"antnest/runtime:local"}
			}`)
			if response.Code != http.StatusCreated {
				t.Fatalf("response=%d %s", response.Code, response.Body)
			}
			call := backend.singleCall(t)
			var payload map[string]any
			decodeBytes(t, call.Body, &payload)
			if call.Target != upstream.AgentController || payload["runtime"].(map[string]any)["image_ref"] != "antnest/runtime:local" {
				t.Fatalf("tag choice was not passed to its owner: %+v", call)
			}
			if !strings.Contains(response.Body.String(), `"image_source":"antnest/runtime:local"`) {
				t.Fatalf("safe image source was not projected: %s", response.Body)
			}
			if strings.Contains(response.Body.String(), "must-not-reach-browser") {
				t.Fatal("unapproved Runtime metadata reached the browser")
			}
		})
	}
}

func TestTemplateRejectsForgedImageSourceBeforeForwarding(t *testing.T) {
	backend := newBackendStub()
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/templates", `{
		"name":"Template","model_profile_revision_id":"model-1",
		"runtime":{"image_ref":"antnest/runtime:local","image_source":"forged:source"}
	}`)
	if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
		t.Fatalf("forged source reached the owner: %d %s", response.Code, response.Body)
	}
}
