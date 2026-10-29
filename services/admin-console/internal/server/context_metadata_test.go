package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestModelContextMetadataCommandsPreserveIntentAndOwnerValidation(t *testing.T) {
	for _, path := range []string{"/api/admin/model-profiles", "/api/admin/model-profiles/model-1/revisions"} {
		for _, metadata := range []string{``, `,"tokenizer":"o200k","compaction_model_profile_id":"compactor-1"`, `,"tokenizer":"cl100k"`, `,"tokenizer":"none"`} {
			for _, status := range []int{http.StatusCreated, http.StatusBadRequest} {
				backend := newBackendStub()
				request := `{"model":"meta","context_window":8192,"max_output_tokens":1024,"supports_images":false` + metadata + `}`
				reply := `{"code":"invalid_model_spec","message":"Rejected"}`
				if status == http.StatusCreated {
					reply = `{"model_profile_id":"model-1","model":{"model":"meta","context_window":8192,"max_output_tokens":1024,"supports_images":false` + metadata + `,"credential_ref":"model-secret"}}`
				}
				backend.enqueue(status, reply)
				result := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
					modelCommandBody(path, "Meta", request))
				if result.Code != status {
					t.Fatalf("owner status lost: %d", result.Code)
				}
				var sent struct {
					Model json.RawMessage `json:"model"`
				}
				decodeBytes(t, backend.singleCall(t).Body, &sent)
				var sentModel, wantModel map[string]json.RawMessage
				if err := json.Unmarshal(sent.Model, &sentModel); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal([]byte(request), &wantModel); err != nil {
					t.Fatal(err)
				}
				for key, want := range wantModel {
					if string(sentModel[key]) != string(want) {
						t.Fatalf("context metadata intent changed for %s", key)
					}
				}
				if _, ok := sentModel["credential_ref"]; ok {
					t.Fatal("credential forwarded upstream")
				}
				if strings.Contains(result.Body.String(), "model-secret") {
					t.Fatal("credential projected")
				}
			}
		}
	}
}

func TestModelContextMetadataProjectionPreservesFieldsAndStripsPrivateMetadata(t *testing.T) {
	for _, metadata := range []string{``, `,"tokenizer":"o200k","compaction_model_profile_id":"compactor-1"`, `,"tokenizer":"cl100k"`, `,"tokenizer":"none"`} {
		model := `{"model":"meta"` + metadata + `,"credential_ref":"model-secret"}`
		for _, test := range []struct {
			name    string
			project func([]byte) ([]byte, error)
			body    string
		}{
			{"profile", projectModelProfile, `{"model":` + model + `}`},
			{"list", projectModelProfileList, `{"items":[{"model":` + model + `}]}`},
			{"agent", projectAgent, `{"configuration":{"model_profile":{"model":` + model + `}}}`},
		} {
			t.Run(test.name+metadata, func(t *testing.T) {
				result, err := test.project([]byte(test.body))
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(result), "model-secret") || strings.Contains(string(result), "private") {
					t.Fatalf("private data leaked: %s", result)
				}
				for _, field := range []string{`"tokenizer":"o200k"`, `"tokenizer":"cl100k"`, `"tokenizer":"none"`, `"compaction_model_profile_id":"compactor-1"`} {
					if strings.Contains(string(result), field) != strings.Contains(metadata, field) {
						t.Fatalf("lost context field %s: %s", field, result)
					}
				}
			})
		}
	}
}

func TestModelContextMetadataCommandsRejectMalformedFieldsBeforeUpstream(t *testing.T) {
	for _, path := range []string{"/api/admin/model-profiles", "/api/admin/model-profiles/model-1/revisions"} {
		for _, metadata := range []string{
			`,"tokenizer":"bogus"`, `,"tokenizer":"O200K"`, `,"tokenizer":" o200k"`, `,"tokenizer":null`, `,"tokenizer":""`,
			`,"compaction_model_profile_id":""`, `,"compaction_model_profile_id":"has space"`, `,"compaction_model_profile_id":null`,
			`,"compaction_model_profile_id":"` + strings.Repeat("x", 201) + `"`,
		} {
			backend := newBackendStub()
			backend.enqueue(http.StatusBadRequest, `{"code":"invalid_model_spec","message":"Rejected"}`)
			model := `{"model":"meta","context_window":8192,"max_output_tokens":1024,"supports_images":false` + metadata + `}`
			result := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
				modelCommandBody(path, "Meta", model))
			if result.Code != http.StatusBadRequest {
				t.Fatalf("malformed context metadata reached upstream: %d", result.Code)
			}
		}
	}
}
