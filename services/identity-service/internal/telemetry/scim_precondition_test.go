package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/codes"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestSCIMPreconditionSafeSummary(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		t.Run(fmt.Sprint(wrapped), func(t *testing.T) {
			var failure error = domain.ErrPreconditionFailed
			if wrapped {
				failure = fmt.Errorf("PRIVATE-CANARY: %w", failure)
			}
			code, message := ErrorSummary(failure)
			if code != "precondition_failed" || message != "The SCIM resource version does not match" {
				t.Fatalf("safe SCIM precondition summary = %q, %q", code, message)
			}
		})
	}
	code, message := ErrorSummary(domain.NewError("unknown_private_code", "PRIVATE-CANARY", false))
	if code != "internal_error" || strings.Contains(message, "CANARY") {
		t.Fatal("unknown domain errors must retain the private fallback")
	}
}

func TestSCIMPreconditionHTTPRejectionDiagnostics(t *testing.T) {
	recorder := recordSpans(t)
	var output bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /scim/v2/Users/{id}", func(w http.ResponseWriter, _ *http.Request) {
		ProtocolError(w, fmt.Errorf("PRIVATE-CANARY: %w", domain.ErrPreconditionFailed))
		w.WriteHeader(http.StatusPreconditionFailed)
	})
	request := httptest.NewRequest(http.MethodPatch, "/scim/v2/Users/user-fixture", strings.NewReader(`{"displayName":"BODY-CANARY"}`))
	request.Header.Set("Authorization", "Bearer TOKEN-CANARY")
	response := httptest.NewRecorder()
	HTTPHandler(mux, slog.New(slog.NewJSONHandler(&output, nil))).ServeHTTP(response, request)
	if response.Code != http.StatusPreconditionFailed {
		t.Fatal("precondition rejection changed the HTTP status")
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatal("missing SCIM HTTP server span")
	}
	span := spans[0]
	if span.Status().Code == codes.Error || attributeValue(span.Attributes(), "antnest.outcome") != "rejected" {
		t.Fatal("expected SCIM rejection was classified as a server failure")
	}
	if attributeValue(span.Attributes(), "antnest.error.code") != "precondition_failed" || eventValue(span, "antnest.error", "antnest.error.code") != "precondition_failed" {
		t.Fatal("SCIM span and event lost the precondition rejection code")
	}
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["error_type"] != "precondition_failed" || row["error_message"] != "The SCIM resource version does not match" {
		t.Fatal("SCIM completion log lost the safe precondition summary")
	}
	metadata, err := json.Marshal(struct {
		Attributes any
		Events     any
	}{span.Attributes(), span.Events()})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(metadata), "CANARY") || strings.Contains(output.String(), "CANARY") {
		t.Fatal("SCIM rejection diagnostics leaked private input")
	}
}
