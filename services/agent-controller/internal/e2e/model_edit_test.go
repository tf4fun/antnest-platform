package e2e

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func assertModelEditConcurrency(t *testing.T, handler http.Handler) {
	t.Helper()
	provider := createTestProvider(t, handler, "model-edit-provider", "model-edit-org", "https://api.deepseek.com", "synthetic")
	draft := map[string]any{
		"request_id": "model-edit-create", "organization_id": "model-edit-org",
		"provider_connection_id": provider["connection_id"], "profile_key": "model-edit",
		"display_name": "Original", "model": map[string]any{
			"model": "deepseek-chat", "context_window": 8192, "max_output_tokens": 1024, "supports_images": false,
		},
	}
	created := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusCreated)
	path := "/internal/model-profiles/" + created["model_profile_id"].(string)
	delete(draft, "provider_connection_id")
	delete(draft, "profile_key")
	draft["request_id"], draft["display_name"] = "model-edit-first", "First admin"
	serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusBadRequest)
	draft["expected_version"] = created["revision"]
	body := mustJSON(t, draft)
	first := serveJSON(t, handler, http.MethodPost, path+"/revisions", body, http.StatusCreated)
	draft["request_id"], draft["display_name"] = "model-edit-second", "Stale admin"
	conflict := serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusConflict)
	if conflict["code"] != "lifecycle_conflict" {
		t.Fatalf("unexpected stale edit error: %v", conflict)
	}
	current := serveJSON(t, handler, http.MethodGet, path+"?organization_id=model-edit-org", "", http.StatusOK)
	if !reflect.DeepEqual(current, first) {
		t.Fatal("stale HTTP form overwrote the current model")
	}
	draft["expected_version"] = first["revision"]
	second := serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated)
	replayed := serveJSON(t, handler, http.MethodPost, path+"/revisions", body, http.StatusCreated)
	if !reflect.DeepEqual(replayed, first) || second["revision"] != float64(3) {
		t.Fatal("replay drifted or a fresh edit did not advance the version")
	}
	draft["expected_version"] = second["revision"]
	draft["request_id"], draft["display_name"] = "model-edit-too-long", strings.Repeat("\u6a21", 201)
	serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusBadRequest)
	draft["request_id"], draft["display_name"] = "model-edit-boundary", strings.Repeat("\u6a21", 200)
	serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated)
}
