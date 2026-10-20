package identity

import (
	"context"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const resolveInstrumentation = "github.com/tf4fun/antnest-platform/edge-gateway/identity"
const resolveAttribute = "antnest.identity.resolve."

type resolveDecision struct {
	span              trace.Span
	source            string
	profile           string
	snapshotAgeMS     float64
	proofAgeMS        float64
	validForMS        float64
	rpcSpan           trace.SpanContext
	sharedSourceState string
	cancelKind        string
}

func newResolveDecision(ctx context.Context, profile string) *resolveDecision {
	if profile != "workspace" && profile != "console" && profile != "acp" && profile != "session" {
		profile = "invalid"
	}
	_, span := otel.Tracer(resolveInstrumentation).Start(ctx, "gateway.identity.resolve", trace.WithSpanKind(trace.SpanKindInternal))
	return &resolveDecision{span: span, source: "rpc", profile: profile}
}

func resolveOutcome(principal Principal, err error) string {
	if IsCode(err, "unauthenticated") || IsCode(err, "inactive_principal") || err == nil && !principal.Active {
		return "rejected"
	}
	if err != nil {
		return "unavailable"
	}
	return "admitted"
}

func (decision *resolveDecision) finish(principal Principal, err error) {
	outcome := resolveOutcome(principal, err)
	decision.span.SetAttributes(attribute.String(resolveAttribute+"source", decision.source),
		attribute.String(resolveAttribute+"profile", decision.profile), attribute.String(resolveAttribute+"outcome", outcome))
	if outcome != "admitted" {
		decision.span.SetStatus(codes.Error, outcome)
	}
	if decision.source == "cache" {
		decision.span.SetAttributes(attribute.Float64(resolveAttribute+"snapshot_age_ms", decision.snapshotAgeMS),
			attribute.Float64(resolveAttribute+"proof_age_ms", decision.proofAgeMS), attribute.Float64(resolveAttribute+"valid_for_ms", decision.validForMS))
	}
	if decision.source == "shared" {
		if decision.rpcSpan.IsValid() {
			decision.span.AddLink(trace.Link{SpanContext: decision.rpcSpan})
		}
		if decision.sharedSourceState != "" {
			decision.span.SetAttributes(attribute.String(resolveAttribute+"shared_source_state", decision.sharedSourceState))
		}
	}
	if decision.cancelKind != "" {
		decision.span.SetAttributes(attribute.String(resolveAttribute+"cancel_kind", decision.cancelKind))
	}
	decision.span.End()
}

func (decision *resolveDecision) cacheHit(principal Principal, proof, now time.Time) {
	decision.source = "cache"
	decision.snapshotAgeMS = float64(now.Sub(principal.ResolveStartedAt)) / float64(time.Millisecond)
	decision.proofAgeMS = float64(now.Sub(proof)) / float64(time.Millisecond)
	decision.validForMS = float64(principal.ResolveValidUntil.Sub(now)) / float64(time.Millisecond)
}

// Called with the same lock used to create and publish the real CLIENT. A
// cancellation cannot confuse an unpublished context with an unstarted RPC.
func (decision *resolveDecision) sourceSnapshot(ctx context.Context, cache *resolveCache, flight *resolveFlight) {
	if decision == nil || decision.source != "shared" && decision.source != "rpc" {
		return
	}
	// A creator's cancellation marker proves that its real CLIENT existed at
	// this snapshot. A CLIENT published after cancellation cannot acquire it.
	if decision.source == "rpc" && !flight.rpcSpan.IsValid() {
		return
	}
	decision.rpcSpan = flight.rpcSpan
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		decision.cancelKind = "caller-deadline"
	case ctx.Err() != nil:
		decision.cancelKind = "caller-cancelled"
	case cache.closed || cache.ctx.Err() != nil:
		decision.cancelKind = "process-shutdown"
	case !flight.completed && errors.Is(flight.ctx.Err(), context.DeadlineExceeded) || errors.Is(flight.err, context.DeadlineExceeded):
		decision.cancelKind = "shared-deadline"
	case !flight.completed && flight.ctx.Err() != nil || errors.Is(flight.err, context.Canceled):
		decision.cancelKind = "shared-cancelled"
	}
	if decision.source != "shared" {
		return
	}
	if decision.rpcSpan.IsValid() {
		decision.sharedSourceState = "actual-client"
	} else if decision.cancelKind != "" {
		decision.sharedSourceState = "cancelled-before-client"
	}
}

func (flight *resolveFlight) tracedWork(cache *resolveCache) (context.Context, func(Principal, error)) {
	ctx := flight.ctx
	var refresh trace.Span
	if flight.background {
		options := []trace.SpanStartOption{trace.WithNewRoot(), trace.WithSpanKind(trace.SpanKindInternal)}
		if flight.triggerSpan.IsValid() {
			options = append(options, trace.WithLinks(trace.Link{SpanContext: flight.triggerSpan}))
		}
		ctx, refresh = otel.Tracer(resolveInstrumentation).Start(ctx, "gateway.identity.resolve.refresh", options...)
		refresh.SetAttributes(attribute.String(resolveAttribute+"profile", flight.key.profile))
	}
	ctx = telemetry.WithHTTPClientSpanObserver(ctx, &cache.mu, func(span trace.SpanContext) { flight.rpcSpan = span })
	return ctx, func(principal Principal, err error) {
		if refresh != nil {
			outcome := resolveOutcome(principal, err)
			refresh.SetAttributes(attribute.String(resolveAttribute+"outcome", outcome))
			if outcome != "admitted" {
				refresh.SetStatus(codes.Error, outcome)
			}
			refresh.End()
		}
	}
}
