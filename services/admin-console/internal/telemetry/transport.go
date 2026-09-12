package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
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
	r := original.Clone(ctx)
	r.Header.Del("Baggage")
	span.SetAttributes(attribute.String("http.request.method", r.Method), attribute.String("server.address", r.URL.Hostname()), attribute.String("antnest.peer.service", target), attribute.String("url.scheme", r.URL.Scheme), attribute.String("antnest.outcome", "success"))
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
		span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
	}

	requestCapture := &bodyObservation{}
	if r.Body != nil {
		r.Body = &capturedBody{ReadCloser: r.Body, capture: requestCapture}
	}

	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(r.Header))
	span.SetAttributes(attribute.Bool("antnest.request.dispatched", true))
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
		span.SetAttributes(attribute.String("error.type", strconv.Itoa(response.StatusCode)), attribute.String("antnest.outcome", "failure"))
	}
	capture := &bodyObservation{}
	outcome := &requestOutcome{}
	finish := sync.OnceFunc(func() {

		span.SetAttributes(attribute.Int64("http.request.body.size", requestCapture.size()), attribute.Int64("http.response.body.size", capture.size()))
		if err := outcome.get(); err != nil {
			recordFailure(span, "read_response", err)
		}
		span.End()
	})
	if response.Body == nil || response.Body == http.NoBody {
		finish()
		return response, nil
	}
	body := &capturedBody{ReadCloser: response.Body, capture: capture, finish: finish, outcome: outcome}
	response.Body = body
	if writer, ok := body.ReadCloser.(io.Writer); ok {
		response.Body = &duplexBody{capturedBody: body, writer: writer}
	}
	return response, nil
}

func (t *httpTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

type capturedBody struct {
	io.ReadCloser
	capture *bodyObservation
	finish  func()
	outcome *requestOutcome
}

func (b *capturedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.capture.add(p[:n])
	if err != nil && b.finish != nil {
		if err != io.EOF {
			b.outcome.set(err)
		}
		b.finish()
	}
	return n, err
}

func (b *capturedBody) Close() error {
	err := b.ReadCloser.Close()
	if b.finish != nil {
		b.outcome.set(err)
		b.finish()
	}
	return err
}

type duplexBody struct {
	*capturedBody
	writer io.Writer
}

func (b *duplexBody) Write(p []byte) (int, error) {
	n, err := b.writer.Write(p)
	if err != nil {
		b.outcome.set(err)
		b.finish()
	}
	return n, err
}
