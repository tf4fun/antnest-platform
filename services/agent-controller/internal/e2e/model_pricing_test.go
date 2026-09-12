package e2e

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

func assertModelPricingPublication(t *testing.T, handler http.Handler) {
	t.Helper()
	provider := createTestProvider(t, handler, "pricing-provider", "pricing-org", "https://api.deepseek.com", "synthetic")
	draft := map[string]any{
		"request_id": "pricing-create", "organization_id": "pricing-org", "profile_key": "priced",
		"display_name": "Priced", "provider_connection_id": provider["connection_id"],
	}
	baseline := map[string]any{"currency": "USD", "input_per_million": 2.0, "output_per_million": 8.0, "cache_read_per_million": 0.5}
	model := map[string]any{"model": "deepseek-v4-flash-vision-exp", "pricing": baseline,
		"context_window": 8192.0, "max_output_tokens": 1024.0, "supports_images": false}
	draft["model"] = model
	created := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusCreated)
	assertModelPrice(t, created, baseline)
	expected := map[string]any{}
	for key, value := range model {
		expected[key] = value
	}
	expected["base_url"] = "https://api.deepseek.com"
	if !reflect.DeepEqual(created["model"], expected) {
		t.Fatalf("submitted configuration changed: %v", created["model"])
	}
	path := "/internal/model-profiles/" + created["model_profile_id"].(string)
	oldPath := "/internal/model-profile-revisions/" + created["revision_id"].(string) + "?organization_id=pricing-org"
	replayed := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusCreated)
	assertModelPrice(t, replayed, baseline)
	delete(model, "pricing")
	serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusConflict)
	delete(draft, "profile_key")
	delete(draft, "provider_connection_id")
	draft["request_id"] = "pricing-revise"
	free := map[string]any{"currency": "USD", "input_per_million": 0.0, "output_per_million": 0.0}
	model["pricing"] = free
	revised := serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated)
	assertModelPrice(t, revised, free)
	if revised["revision"] != 2.0 {
		t.Fatal("pricing edit did not publish a model revision")
	}
	assertModelPrice(t, serveJSON(t, handler, http.MethodGet, oldPath, "", http.StatusOK), baseline)
	stored := serveJSON(t, handler, http.MethodGet, oldPath, "", http.StatusOK)["model"].(map[string]any)
	if stored["context_window"] != 8192.0 || stored["supports_images"] != false || stored["max_output_tokens"] != 1024.0 {
		t.Fatalf("persisted parameters changed to defaults: %v", stored)
	}
	assertModelPrice(t, serveJSON(t, handler, http.MethodGet, path+"?organization_id=pricing-org", "", http.StatusOK), free)
	assertModelPrice(t, serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated), free)
	model["pricing"] = baseline
	serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusConflict)
	assertInvalidModelPrices(t, handler, draft, model, path)
}

func assertInvalidModelPrices(t *testing.T, handler http.Handler, draft, model map[string]any, path string) {
	t.Helper()
	for index, invalid := range []any{
		nil,
		map[string]any{},
		map[string]any{"currency": "USD", "input_per_million": 0},
		map[string]any{"currency": "USD", "input_per_million": nil, "output_per_million": 0},
		map[string]any{"currency": "CNY", "input_per_million": 1, "output_per_million": 1},
		map[string]any{"currency": "USD", "input_per_million": -1, "output_per_million": 1},
		map[string]any{"currency": "USD", "input_per_million": "1", "output_per_million": 1},
		map[string]any{"currency": "USD", "input_per_million": 1, "output_per_million": 1, "cache_read_per_million": -1},
		map[string]any{"currency": "USD", "input_per_million": 1, "output_per_million": 1, "extra": true},
		map[string]any{"currency": "USD", "input_per_million": 1, "output_per_million": 1, "cache_read_per_million": nil},
		map[string]any{"currency": "USD", "input_per_million": 1, "output_per_million": 1, "cache_write_per_million": nil},
	} {
		model["pricing"] = invalid
		draft["request_id"] = fmt.Sprintf("invalid-pricing-%d", index)
		serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusBadRequest)
		draft["profile_key"] = fmt.Sprintf("invalid-%d", index)
		serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusBadRequest)
		delete(draft, "profile_key")
	}
	current := serveJSON(t, handler, http.MethodGet, path+"?organization_id=pricing-org", "", http.StatusOK)
	if current["revision"] != 2.0 {
		t.Fatal("invalid pricing published a revision")
	}
	delete(model, "pricing")
	model["Pricing"] = nil
	draft["request_id"] = "noncanonical-price"
	serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusBadRequest)
	draft["profile_key"] = "noncanonical-price"
	serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusBadRequest)
	delete(model, "Pricing")
	provider := createTestProvider(t, handler, "pricing-unknown-provider", "pricing-org", "https://company.example/v1", "synthetic")
	draft["provider_connection_id"] = provider["connection_id"]
	draft["request_id"], draft["profile_key"] = "unknown-price", "unknown-price"
	unknown := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusCreated)
	if _, exists := unknown["model"].(map[string]any)["pricing"]; exists {
		t.Fatal("custom endpoint acquired a price")
	}
	provider = createTestProvider(t, handler, "pricing-builtin-provider", "pricing-org", "https://api.deepseek.com", "synthetic")
	draft["provider_connection_id"] = provider["connection_id"]
	draft["request_id"], draft["profile_key"] = "builtin-unknown-price", "builtin-unknown-price"
	unknown = serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", mustJSON(t, draft), http.StatusCreated)
	unknownPath := "/internal/model-profiles/" + unknown["model_profile_id"].(string) + "?organization_id=pricing-org"
	unknown = serveJSON(t, handler, http.MethodGet, unknownPath, "", http.StatusOK)
	if _, exists := unknown["model"].(map[string]any)["pricing"]; exists {
		t.Fatal("known model acquired an unsubmitted price")
	}
}

func assertModelPrice(t *testing.T, response, want map[string]any) {
	t.Helper()
	if got := response["model"].(map[string]any)["pricing"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("price=%+v want=%+v", got, want)
	}
}
