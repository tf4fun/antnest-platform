package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

// Messages are service-owned summaries; neither Error() nor database Detail is
// safe to export. Cause types and SQLSTATE retain the real failure boundary.
var safeErrorMessages = map[string]string{
	"bad_request": "The protocol request is invalid", "invalid_argument": "An identity argument is invalid",
	"unauthenticated": "Authentication failed", "forbidden": "The principal lacks the required permission",
	"not_found": "The identity resource does not exist", "conflict": "The identity resource conflicts with an existing resource",
	"last_organization_admin": "An organization must retain an active administrator",
	"version_conflict":        "The identity resource changed concurrently", "invalid_reference": "The identity reference is invalid",
	"inactive_principal": "The principal is inactive", "invalid_filter": "The SCIM filter is unsupported",
	"oidc_authorization_failed": "OIDC authorization was not granted", "oidc_exchange_failed": "OIDC token exchange or verification failed",
	"oidc_identity_failed": "OIDC identity matching failed", "oidc_session_failed": "OIDC session processing failed",
	"oidc_provider_failed": "OIDC provider lookup failed", "oidc_provider_secret_failed": "OIDC provider credential could not be opened",
	"oidc_token_failed": "OIDC local credential issuance failed", "oidc_persistence_failed": "OIDC completion could not be persisted",
	"oidc_session_expired": "OIDC login session expired", "oidc_expired_failed": "OIDC login completion deadline elapsed",
	"oidc_provider_changed": "OIDC provider changed; restart login", "oidc_membership_required": "OIDC requires an active organization membership",
	"oidc_exchange_in_progress":         "OIDC callback exchange is already in progress",
	"oidc_provider_issuer_immutable":    "OIDC provider issuer cannot be changed",
	"oidc_provider_client_id_immutable": "OIDC provider client ID cannot be changed",
	"oidc_exchange_claim_invalid":       "OIDC callback claim is invalid",
	"oidc_completed_token_unavailable":  "The completed OIDC credential is no longer available",
	"scim_protocol_error":               "SCIM rejected the protocol request",
}

func ErrorSummary(err error) (string, string) {
	var business *domain.Error
	if errors.As(err, &business) {
		if message, ok := safeErrorMessages[business.Code]; ok {
			return business.Code, message
		}
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled", "The request was cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", "The request deadline elapsed"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "timeout", "The network operation timed out"
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "unexpected_eof", "The response ended before completion"
	}
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) {
		return "postgresql_error", "PostgreSQL rejected the storage operation"
	}
	return "internal_error", "The operation failed; inspect the safe cause types and failing boundary"
}

func causeTypes(err error) []string {
	var result []string
	var visit func(error)
	visit = func(current error) {
		if current == nil || len(result) >= 4 {
			return
		}
		result = append(result, fmt.Sprintf("%T", current))
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, cause := range joined.Unwrap() {
				visit(cause)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	return result
}

func RecordFailure(span trace.Span, phase string, err error) {
	recordError(span, phase, err, true)
}

func recordError(span trace.Span, phase string, err error, failure bool) {
	if err == nil {
		return
	}
	code, message := ErrorSummary(err)
	attrs := []attribute.KeyValue{
		attribute.String("error.type", code), attribute.String("antnest.error.code", code),
		attribute.String("antnest.error.stage", phase), attribute.String("antnest.error.type", code), attribute.String("antnest.error.message", message),
		attribute.StringSlice("antnest.error.cause_types", causeTypes(err)),
	}
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) && validSQLState(postgres.Code) {
		attrs = append(attrs, attribute.String("db.response.status_code", postgres.Code))
	}
	span.SetAttributes(attrs...)
	span.AddEvent("antnest.error", trace.WithAttributes(attrs...))
	outcome := "error"
	if code == "cancelled" {
		outcome = "cancelled"
	}
	span.SetAttributes(attribute.String("antnest.outcome", outcome))
	if failure {
		span.SetStatus(codes.Error, code)
	}
}

func validSQLState(value string) bool {
	return len(value) == 5 && strings.Trim(value, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") == ""
}
