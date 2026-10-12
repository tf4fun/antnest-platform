package telemetry

import (
	"fmt"
	"strings"
	"testing"

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
