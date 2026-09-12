package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestModelPriceProjectionPreservesKnownValuesAndStripsPrivateMetadata(t *testing.T) {
	for _, price := range []string{``, `,"pricing":{"currency":"USD","input_per_million":0,"output_per_million":0}`,
		`,"pricing":{"currency":"USD","input_per_million":2,"output_per_million":8,"cache_read_per_million":0.00001234567,"cache_write_per_million":0,"private":"rate-secret"}`} {
		model := `{"model":"priced"` + price + `,"credential_ref":"model-secret"}`
		for _, test := range []struct {
			name    string
			project func([]byte) ([]byte, error)
			body    string
		}{
			{"profile", projectModelProfile, `{"model":` + model + `}`},
			{"list", projectModelProfileList, `{"items":[{"model":` + model + `}]}`},
			{"agent", projectAgent, `{"configuration":{"model_profile":{"model":` + model + `}}}`},
		} {
			t.Run(test.name+price, func(t *testing.T) {
				result, err := test.project([]byte(test.body))
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(result), "secret") || strings.Contains(string(result), "private") {
					t.Fatalf("private data leaked: %s", result)
				}
				for _, field := range []string{`"pricing"`, `"input_per_million":0`, `"output_per_million":0`, `"input_per_million":2`, `"cache_read_per_million":0.00001234567`, `"cache_write_per_million":0`} {
					if strings.Contains(string(result), field) != strings.Contains(price, field) {
						t.Fatalf("lost price field %s: %s", field, result)
					}
				}
			})
		}
	}
}

func TestModelPriceCommandsPreserveIntentAndOwnerValidation(t *testing.T) {
	for _, path := range []string{"/api/admin/model-profiles", "/api/admin/model-profiles/model-1/revisions"} {
		for _, price := range []string{``, `,"pricing":{"currency":"USD","input_per_million":0,"output_per_million":0}`} {
			for _, status := range []int{http.StatusCreated, http.StatusBadRequest} {
				backend := newBackendStub()
				model := `{"model":"priced"` + price + `}`
				backend.enqueue(status, `{"model_profile_id":"model-1","model":`+model+`}`)
				result := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
					modelCommandBody(path, "Priced", model))
				if result.Code != status {
					t.Fatalf("owner status lost: %d", result.Code)
				}
				var sent struct {
					OrganizationID string          `json:"organization_id"`
					Model          json.RawMessage `json:"model"`
				}
				decodeBytes(t, backend.singleCall(t).Body, &sent)
				if sent.OrganizationID != "org-1" || string(sent.Model) != model {
					t.Fatal("price intent or trusted scope changed")
				}
				if strings.Contains(result.Body.String(), "synthetic-secret") {
					t.Fatal("credential projected")
				}
			}
		}
	}
}

func TestModelPriceProjectionRejectsInvalidUpstreamAmounts(t *testing.T) {
	for _, price := range []string{
		`null`,
		`{}`, `{"currency":"EUR","input_per_million":1,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":1}`, `{"currency":"USD","input_per_million":null,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":-1,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":1e309,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":1e-400,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":-1e-400,"output_per_million":1}`,
		`{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_read_per_million":-1}`,
		`{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_read_per_million":null}`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, `{"model":{"pricing":`+price+`}}`)
		result := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/model-profiles/model-1", "")
		if result.Code != http.StatusBadGateway || !strings.Contains(result.Body.String(), "invalid_upstream_response") {
			t.Fatalf("invalid owner pricing presented: %d %s", result.Code, result.Body)
		}
	}
}

func TestModelPriceProjectionRetainsSubnormalAndExponentZero(t *testing.T) {
	for _, amount := range []string{"5e-324", "0e-400"} {
		data := []byte(`{"model":{"pricing":{"currency":"USD","input_per_million":` + amount + `,"output_per_million":1}}}`)
		if _, err := projectModelProfile(data); err != nil {
			t.Fatal(err)
		}
	}
}

func TestModelPriceCommandsForwardInvalidAndPrecisePricesUnchanged(t *testing.T) {
	for _, path := range []string{"/api/admin/model-profiles", "/api/admin/model-profiles/model-1/revisions"} {
		for _, price := range []string{`null`, `{"currency":"USD","input_per_million":-1,"output_per_million":1}`,
			`{"currency":"USD","input_per_million":0.00001234567,"output_per_million":8,"cache_read_per_million":0,"cache_write_per_million":0.001}`} {
			backend := newBackendStub()
			backend.enqueue(http.StatusBadRequest, `{"code":"invalid_request","message":"Owner validation"}`)
			model := `{"model":"priced","pricing":` + price + `}`
			result := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
				modelCommandBody(path, "Priced", model))
			var sent struct {
				Model json.RawMessage `json:"model"`
			}
			decodeBytes(t, backend.singleCall(t).Body, &sent)
			if result.Code != http.StatusBadRequest || string(sent.Model) != model {
				t.Fatal("BFF changed owner validation input")
			}
		}
	}
}
