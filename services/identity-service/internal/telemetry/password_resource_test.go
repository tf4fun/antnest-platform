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

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestPasswordAdmissionDiagnosticsOnlyExportBoundedPrivateReasons(t *testing.T) {
	for _, reason := range []string{"queue_full", "wait_expired", "weight_exceeds_budget", "shutdown", "SECRET-CANARY", ""} {
		t.Run(reason, func(t *testing.T) {
			recorder := recordSpans(t)
			var failure error = domain.ErrCredentialBusy
			if reason != "" {
				failure = domain.WithCause(domain.ErrCredentialBusy, &credentials.PasswordAdmissionError{Reason: reason})
			}
			_, span := otel.Tracer("test").Start(t.Context(), "password")
			RecordFailure(span, "password", fmt.Errorf("PRIVATE-CANARY: %w", failure))
			span.End()
			ended := recorder.Ended()[0]
			wantReason := reason
			if reason == "SECRET-CANARY" {
				wantReason = ""
			}
			if attributeValue(ended.Attributes(), "antnest.error.code") != "credential_busy" || attributeValue(ended.Attributes(), "antnest.error.message") != "Password verification is busy" || attributeValue(ended.Attributes(), "antnest.password.admission_reason") != wantReason || eventValue(ended, "antnest.error", "antnest.password.admission_reason") != wantReason {
				t.Fatal("password admission lost safe code or KDF cause attribution")
			}
			for _, attr := range ended.Attributes() {
				if strings.Contains(attr.Value.String(), "CANARY") {
					t.Fatal("private admission input escaped in telemetry")
				}
			}
		})
	}
}

func TestPasswordAdmissionHTTPLogsAttributeOnlyRealBoundedKDFReasons(t *testing.T) {
	for _, reason := range []string{"queue_full", "wait_expired", "weight_exceeds_budget", "shutdown", "SECRET-CANARY", "untyped", "database-lock"} {
		t.Run(reason, func(t *testing.T) {
			recordSpans(t)
			failure := domain.WithCause(domain.ErrCredentialBusy, &credentials.PasswordAdmissionError{Reason: reason})
			want := reason
			switch reason {
			case "SECRET-CANARY":
				want = ""
			case "untyped":
				failure, want = domain.ErrCredentialBusy, ""
			case "database-lock":
				failure = domain.WithCause(domain.ErrCredentialBusy, &pgconn.PgError{Code: "55P03", Message: "SECRET-CANARY", Detail: "SECRET-CANARY"})
				want = ""
			}
			var output bytes.Buffer
			mux := http.NewServeMux()
			mux.HandleFunc("POST /rpc/identity/local-login", func(w http.ResponseWriter, _ *http.Request) {
				ProtocolError(w, fmt.Errorf("PRIVATE-CANARY: %w", failure))
				w.WriteHeader(http.StatusServiceUnavailable)
			})
			request := httptest.NewRequest(http.MethodPost, "http://identity.test/rpc/identity/local-login", strings.NewReader(`{"password":"PASSWORD-CANARY"}`))
			request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
			request.Header.Set("Antnest-Service-Authorization", "Bearer TOKEN-CANARY")
			HTTPHandler(mux, slog.New(slog.NewJSONHandler(&output, nil))).ServeHTTP(httptest.NewRecorder(), request)
			var row map[string]any
			if err := json.Unmarshal(output.Bytes(), &row); err != nil {
				t.Fatal(err)
			}
			got, present := row["password_admission_reason"]
			if want != "" && got != want || want == "" && present {
				t.Fatal("HTTP completion log misattributed KDF admission")
			}
			if row["trace_id"] != "4bf92f3577b34da6a3ce929d0e0e4736" || row["error_type"] != "credential_busy" || row["error_message"] != "Password verification is busy" {
				t.Fatal("HTTP completion log lost its correlation or safe error summary")
			}
			if strings.Contains(output.String(), "CANARY") {
				t.Fatal("HTTP completion log leaked private input")
			}
		})
	}
}
