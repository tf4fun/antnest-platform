package oidcclient

import (
	"context"
	"errors"
	"strconv"

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
	span.SetAttributes(attribute.String("antnest.operation.phase", operation), attribute.String("antnest.identity.authentication_method", "oidc"))
	return ctx, func(err error) {
		if err == nil {
			span.SetAttributes(attribute.String("antnest.outcome", "success"))
		} else {
			telemetry.RecordFailure(span, operation, err)
			var oauthError *oauth2.RetrieveError
			if errors.As(err, &oauthError) {
				switch oauthError.ErrorCode {
				case "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable":
					span.SetAttributes(attribute.String("antnest.error.protocol_code", oauthError.ErrorCode))
				}
			}
		}
		span.End()
	}
}

func providerFacts(ctx context.Context, provider oidcflow.Provider) {
	span := trace.SpanFromContext(ctx)
	if domain.ValidID(provider.ID) {
		span.SetAttributes(attribute.String("antnest.identity.provider.id", provider.ID))
	}
	if domain.ValidID(provider.OrganizationID) {
		span.SetAttributes(attribute.String("antnest.organization.id", provider.OrganizationID))
	}
	span.SetAttributes(attribute.String("antnest.identity.provider.revision", strconv.FormatInt(provider.Revision, 10)))
}
