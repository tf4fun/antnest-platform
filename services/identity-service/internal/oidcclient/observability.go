package oidcclient

import (
	"context"
	"errors"
	"strconv"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/oauth2"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
)

func startOperation(ctx context.Context, operation string) (context.Context, func(error)) {
	ctx, span := otel.Tracer("github.com/tf4fun/antnest-platform/identity-service/oidcclient").Start(ctx, operation, trace.WithSpanKind(trace.SpanKindInternal))
	span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOperationPhase, operation), attribute.String(semconv.AntnestIdentityAuthenticationMethod, "oidc"))...)
	return ctx, func(err error) {
		if err == nil {
			span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "success"))...)
		} else {
			telemetry.RecordFailure(span, operation, err)
			var oauthError *oauth2.RetrieveError
			if errors.As(err, &oauthError) {
				switch oauthError.ErrorCode {
				case "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable":
					span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestErrorProtocolCode, oauthError.ErrorCode))...)
				}
			}
		}
		span.End()
	}
}

func providerFacts(ctx context.Context, provider oidcflow.Provider) {
	span := trace.SpanFromContext(ctx)
	if domain.ValidID(provider.ID) {
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestIdentityProviderId, provider.ID))...)
	}
	if domain.ValidID(provider.OrganizationID) {
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOrganizationId, provider.OrganizationID))...)
	}
	span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestIdentityProviderRevision, strconv.FormatInt(provider.Revision, 10)))...)
}
