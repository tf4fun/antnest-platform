package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type httpTransport struct {
	base http.RoundTripper
}

func NewHTTPTransport(base http.RoundTripper) http.RoundTripper {
	if wrapped, ok := base.(*httpTransport); ok {
		base = wrapped.base
	}
	if base == nil {
		base = http.DefaultTransport
	}
	return &httpTransport{base: base}
}

type targetKey struct{}

// WithTarget is used by the typed HTTP adapter during request construction.
func WithTarget(ctx context.Context, target string) context.Context {
	return context.WithValue(ctx, targetKey{}, target)
}

func (t *httpTransport) RoundTrip(original *http.Request) (*http.Response, error) {
	target, _ := original.Context().Value(targetKey{}).(string)
	if target == "" {
		target = original.URL.Hostname()
	}
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(original.Context(), "HTTP "+original.Method+" "+target, trace.WithSpanKind(trace.SpanKindClient))
	r := semconv.CloneRequest(original, ctx, nil)
	span.SetAttributes(semconv.AliasAttributes(attribute.String("http.request.method", r.Method), attribute.String("server.address", r.URL.Hostname()), attribute.String(semconv.AntnestPeerService, target), attribute.String("url.scheme", r.URL.Scheme), attribute.String(semconv.AntnestOutcome, "success"))...)
	port := r.URL.Port()
	if port == "" {
		if r.URL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if number, err := strconv.Atoi(port); err == nil {
		span.SetAttributes(attribute.Int("server.port", number))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
	}

	requestCapture := &bodyObservation{}
	if r.Body != nil {
		r.Body = semconv.WrapBody(r.Body, semconv.BodyCallbacks{
			Read: func(n int, _ error) { requestCapture.add(n) },
		})
	}

	span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestRequestDispatched, true))...)
	response, err := t.base.RoundTrip(r)
	if response == nil && err == nil {
		err = errors.New("HTTP transport returned no response")
	}
	if err != nil {

		span.SetAttributes(attribute.Int64("http.request.body.size", requestCapture.size()))
		recordFailure(span, "send", err)
		span.End()
		return response, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	if response.StatusCode >= 400 {
		span.SetStatus(codes.Error, "HTTP status "+strconv.Itoa(response.StatusCode))
		span.SetAttributes(semconv.AliasAttributes(attribute.String("error.type", strconv.Itoa(response.StatusCode)), attribute.String(semconv.AntnestOutcome, "failure"))...)
	}
	capture := &bodyObservation{}
	outcome := &requestOutcome{}
	finish := sync.OnceFunc(func() {

		span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", requestCapture.size()), attribute.Int64("http.response.body.size", capture.size()))...)
		if err := outcome.get(); err != nil {
			recordFailure(span, "read_response", err)
		}
		span.End()
	})
	if response.Body == nil || response.Body == http.NoBody {
		finish()
		return response, nil
	}
	response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
		Read: func(n int, err error) {
			capture.add(n)
			if err == nil {
				return
			}
			if err != io.EOF {
				outcome.set(err)
			}
			finish()
		},
		Close: func(err error) {
			outcome.set(err)
			finish()
		},
		Write: func(_ int, err error) {
			if err != nil {
				outcome.set(err)
				finish()
			}
		},
	})
	return response, nil
}

func (t *httpTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
