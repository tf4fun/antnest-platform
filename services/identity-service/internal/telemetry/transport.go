package telemetry

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type httpTransport struct{ base http.RoundTripper }

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

func (t *httpTransport) RoundTrip(original *http.Request) (*http.Response, error) {
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(original.Context(), "HTTP "+original.Method+" "+original.URL.Hostname(), trace.WithSpanKind(trace.SpanKindClient))
	request := semconv.CloneRequest(original, ctx, nil)
	span.SetAttributes(semconv.AliasAttributes(attribute.String("http.request.method", request.Method), attribute.String("server.address", request.URL.Hostname()), attribute.String("url.scheme", request.URL.Scheme))...)
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
	}

	requestBody := &countedBody{}
	if request.Body != nil {
		request.Body = semconv.WrapBody(request.Body, semconv.BodyCallbacks{
			Read: func(n int, _ error) { requestBody.bytes.Add(int64(n)) },
		})
	}
	span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestHttpTransportInvoked, true))...)
	response, err := t.base.RoundTrip(request)
	if err != nil {
		RecordFailure(span, "send", err)
		span.SetAttributes(attribute.Int64("http.request.body.size", requestBody.bytes.Load()))
		span.End()
		return response, err
	}
	if response == nil {
		span.End()
		return response, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	outcome := "success"
	if response.StatusCode >= 400 {
		outcome = "error"
		span.SetStatus(codes.Error, strconv.Itoa(response.StatusCode))
		span.SetAttributes(attribute.String("error.type", strconv.Itoa(response.StatusCode)))
	}
	span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, outcome))...)
	body := &clientBody{span: span, ctx: ctx, request: requestBody}
	if response.Body == nil || response.Body == http.NoBody {
		body.finish("eof", nil)
		return response, nil
	}
	response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
		Read: func(n int, err error) {
			body.bytes.Add(int64(n))
			if err == io.EOF {
				body.finish("eof", nil)
			} else if err != nil {
				body.finish("read_response", err)
			}
			if err != nil && body.stopCancel != nil {
				body.stopCancel()
			}
		},
		Close: func(err error) {
			body.finish("close", err)
			if body.stopCancel != nil {
				body.stopCancel()
			}
		},
		Write: func(_ int, err error) {
			if err != nil {
				body.finish("write_upgrade", err)
			}
		},
	})
	body.stopCancel = context.AfterFunc(ctx, func() { body.finish("cancelled", ctx.Err()) })
	return response, nil
}

type clientBody struct {
	span       trace.Span
	ctx        context.Context
	request    *countedBody
	bytes      atomic.Int64
	once       sync.Once
	stopCancel func() bool
}

func (b *clientBody) finish(reason string, err error) {
	b.once.Do(func() {
		if err == nil {
			err = b.ctx.Err()
		}
		if err != nil {
			RecordFailure(b.span, reason, err)
		}
		b.span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", b.request.bytes.Load()), attribute.Int64("http.response.body.size", b.bytes.Load()), attribute.String(semconv.AntnestHttpTermination, reason))...)
		b.span.End()
	})
}
