package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/browserstream"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/streamio"
)

type browserStreamStartKey struct{}

func browserStreamRequest(request *http.Request) bool {
	if request.Method != http.MethodGet {
		return false
	}
	if isAgentEventWatch(request) {
		return true
	}
	path := request.PathValue("path")
	agent, valid := workspaceBridgeAgentID(path)
	return strings.HasPrefix(request.URL.Path, "/api/app/workspace/v1/") && valid && agent != "" && path == "agents/"+agent+"/events"
}

func (h *handler) guardBrowserStream(response http.ResponseWriter, request *http.Request, token string, principal identity.Principal) (http.ResponseWriter, *http.Request, func(), error) {
	started, _ := request.Context().Value(browserStreamStartKey{}).(time.Time)
	profile, agent := callerSelection(request)
	parent := identity.WithResolution(request.Context(), profile, agent)
	parent, cancelLease := context.WithTimeout(parent, h.streamLease)
	guard, err := browserstream.Start(parent, h.browserStreams, browserstream.Config{
		MaximumStale: h.maximumSessionStale, InitialStarted: started, Original: principal,
		Resolve: func(ctx context.Context) (identity.Principal, error) {
			ctx, cancel := context.WithTimeout(ctx, h.requestTimeout)
			defer cancel()
			return h.identity.Resolve(identity.WithResolution(ctx, profile, agent), token)
		},
	})
	if err != nil {
		cancelLease()
		status, code := http.StatusServiceUnavailable, apierror.IdentityUnavailable
		if errors.Is(err, browserstream.ErrRejected) {
			status, code = http.StatusUnauthorized, apierror.Unauthenticated
		}
		writeError(response, status, code, "Session could not be verified")
		return response, request, nil, err
	}
	response, finishWrites := streamio.CancelHTTPWrites(guard.Context(), response, h.logger)
	finish := func() {
		guard.Close()
		finishWrites()
		if receipt, ok := guard.FeedTermination(); ok {
			attributes := []attribute.KeyValue{
				attribute.String("source", "identity-session-feed"), attribute.String("reason", "session_revoked"),
				attribute.String(semconv.AntnestRevocationReason, receipt.Reason), attribute.Int64(semconv.AntnestRevocationSequence, receipt.Sequence),
				attribute.String(semconv.AntnestOrganizationId, principal.OrganizationID), attribute.String(semconv.AntnestPrincipalId, principal.UserID),
				attribute.String(semconv.AntnestMembershipId, principal.MembershipID), attribute.String(semconv.AntnestAgentId, agent),
			}
			if receipt.Source.IsValid() {
				attributes = append(attributes, attribute.String(semconv.AntnestRevocationTraceId, receipt.Source.TraceID().String()),
					attribute.String(semconv.AntnestRevocationSpanId, receipt.Source.SpanID().String()))
			}
			trace.SpanFromContext(request.Context()).AddEvent(semconv.AntnestStreamTermination, trace.WithTimestamp(receipt.At), trace.WithAttributes(semconv.AliasAttributes(attributes...)...))
		}
		cancelLease()
	}
	return response, request.WithContext(guard.Context()), finish, nil
}
