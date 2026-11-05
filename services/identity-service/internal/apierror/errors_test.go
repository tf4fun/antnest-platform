package apierror

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestCommonErrorNewProjectsRegistryMetadata(t *testing.T) {
	for _, row := range []struct {
		code, category, message, requestID string
		retryable                          bool
		wantID                             string
	}{
		{"credential_busy", "unavailable", "Password verification is busy", "req-1", true, "req-1"},
		{"credential_rate_limited", "rate_limited", "Too many password attempts", "req-2", true, "req-2"},
		{"oidc_session_expired", "not_found", "Session expired", "req-3", false, "req-3"},
		{"version_conflict", "conflict", "Changed concurrently", "req-4", false, "req-4"},
		{"unauthenticated", "unauthenticated", "Authentication failed", "req-5", false, "req-5"},
		{"ghost_code", "internal", "private-canary", "req-6", false, "req-6"},
		{"invalid_argument", "invalid_request", "Rejected", "bad id!!", false, ""},
	} {
		envelope := New(row.code, row.message, row.requestID)
		if envelope.Code != func() string {
			if row.code == "ghost_code" {
				return Internal
			}
			return row.code
		}() || envelope.Category != row.category || envelope.Retryable != row.retryable {
			t.Fatalf("envelope for %s = %+v", row.code, envelope)
		}
		wantMessage := row.message
		if row.code == "ghost_code" {
			wantMessage = "Internal service error"
		}
		if envelope.Message != wantMessage {
			t.Fatalf("message for %s = %q want %q", row.code, envelope.Message, wantMessage)
		}
		if row.wantID == "" && envelope.RequestID == row.requestID {
			t.Fatalf("unsafe request id %q was preserved", row.requestID)
		}
		if row.wantID != "" && envelope.RequestID != row.wantID {
			t.Fatalf("request_id=%q want %q", envelope.RequestID, row.wantID)
		}
	}
}

func TestCommonErrorWriteErrorEmitsEnvelope(t *testing.T) {
	response := httptest.NewRecorder()
	WriteError(response, 503, CredentialBusy, "Password verification is busy", true)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 503 || body["code"] != CredentialBusy || body["category"] != "unavailable" ||
		body["message"] != "Password verification is busy" || body["retryable"] != true {
		t.Fatalf("body=%v status=%d", body, response.Code)
	}
	requestID, _ := body["request_id"].(string)
	if requestID == "" || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", body["request_id"], response.Header().Get("X-Request-ID"))
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control=%q", response.Header().Get("Cache-Control"))
	}
}

func TestCommonErrorContractCodeParity(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Error struct {
			Properties struct {
				Code struct {
					Enum []string `json:"enum"`
				} `json:"code"`
			} `json:"properties"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	for _, code := range contract.Error.Properties.Code.Enum {
		if got := New(code, "probe", "req-1").Code; got != code {
			t.Errorf("contract code %s falls back to %s", code, got)
		}
	}
}
