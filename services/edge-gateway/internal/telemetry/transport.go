package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
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
	if base == nil {
		base = http.DefaultTransport
	}
	return &httpTransport{base: base}
}

func (t *httpTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func startClient(ctx context.Context, method string, target *url.URL) (context.Context, trace.Span) {
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(ctx, "HTTP "+method+" "+target.Hostname(), trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", target.Hostname()), attribute.String("url.scheme", target.Scheme))
	if ctx.Value(identitySessionRevocationsKey{}) == true {
		span.SetAttributes(attribute.String("rpc.system.name", "antnest.http-json"),
			attribute.String("rpc.service", "identity"), attribute.String("rpc.method", "list_session_revocations"))
	}
	if port, err := strconv.Atoi(target.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
	}
	return ctx, span
}

func (t *httpTransport) RoundTrip(original *http.Request) (*http.Response, error) {
	ctx, span := startObservedClient(original.Context(), original.Method, original.URL)
	r := semconv.CloneRequest(original, ctx, otel.GetTextMapPropagator())
	request := &bodyObservation{}
	if r.Body != nil {
		r.Body = semconv.WrapBody(r.Body, semconv.BodyCallbacks{
			Read: func(n int, err error) { request.add(n, err) },
		})
	}
	response, err := t.base.RoundTrip(r)
	if response == nil && err == nil {
		err = errors.New("HTTP transport returned no response")
	}
	if err != nil {
		recordFailure(span, "send", err)
		span.End()
		return response, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	if response.StatusCode >= 400 {
		span.SetStatus(codes.Error, "HTTP status "+strconv.Itoa(response.StatusCode))
		span.SetAttributes(attribute.String("error.type", strconv.Itoa(response.StatusCode)))
	}
	capture := &bodyObservation{}
	finish := sync.OnceFunc(func() {
		span.SetAttributes(attribute.Int64("http.request.body.size", request.observedSize()), attribute.Int64("http.response.body.size", capture.observedSize()))
		span.End()
	})
	if response.Body == nil || response.Body == http.NoBody {
		finish()
		return response, nil
	}
	var failure sync.Once
	recordErr := func(stage string, err error) {
		failure.Do(func() { recordFailure(span, stage, err) })
	}
	response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
		Read: func(n int, err error) {
			capture.add(n, err)
			if err == nil {
				return
			}
			if err != io.EOF {
				recordErr("read_response", err)
			}
			finish()
		},
		Close: func(err error) {
			if err != nil {
				recordErr("close_response", err)
			}
			finish()
		},
		Write: func(_ int, err error) {
			if err != nil {
				recordErr("write_upgrade", err)
			}
		},
	})
	return response, nil
}

func (c *bodyObservation) observedSize() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.observed }
