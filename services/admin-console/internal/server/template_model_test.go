package server

import (
	"net/http"
	"reflect"
	"testing"
)

func TestTemplateCommandsForwardStableModelIdentity(t *testing.T) {
	for _, path := range []string{"/api/admin/templates", "/api/admin/templates/template-1/revisions"} {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":2,"model_profile_id":"model-1","fallback_model_profile_ids":["backup-2","backup-1"]}`)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path, `{
				"name":"Support","model_profile_id":"model-1","max_model_requests":32,
				"fallback_model_profile_ids":["backup-2","backup-1"],
				"runtime":{"image_ref":"runtime:local","resources":{"memory_bytes":1024,"pids_limit":128,"tmpfs_bytes":1024}}
			}`)
			if response.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var command, projection map[string]any
			decodeBytes(t, backend.singleCall(t).Body, &command)
			decodeBytes(t, response.Body.Bytes(), &projection)
			for _, payload := range []map[string]any{command, projection} {
				if !reflect.DeepEqual(payload["fallback_model_profile_ids"], []any{"backup-2", "backup-1"}) {
					t.Fatalf("fallback order lost: %v", payload)
				}
				if payload["model_profile_id"] != "model-1" {
					t.Fatalf("stable reference lost: %v", payload)
				}
				if _, exists := payload["model_profile_revision_id"]; exists {
					t.Fatalf("template pinned a model revision: %v", payload)
				}
			}
			if command["organization_id"] != "org-1" {
				t.Fatalf("organization missing: %v", command)
			}
		})
	}
}

func TestTemplateCommandsRejectObsoleteRevisionReference(t *testing.T) {
	for _, path := range []string{"/api/admin/templates", "/api/admin/templates/template-1/revisions"} {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
				`{"name":"Support","model_profile_id":"model-1","model_profile_revision_id":"revision-1","max_model_requests":32}`)
			if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
				t.Fatalf("obsolete input reached Controller: status=%d calls=%d", response.Code, len(backend.calls))
			}
		})
	}
}
