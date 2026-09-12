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
	if base == nil {
		base = http.DefaultTransport
	}
	return &httpTransport{base: base}
}

// Socket configuration belongs to the underlying transport, not its tracing
// decorator. Gorilla's WebSocket handshake does not use RoundTrip.
func BaseHTTPTransport(transport http.RoundTripper) http.RoundTripper {
	for {
		wrapped, ok := transport.(*httpTransport)
		if !ok {
			break
		}
		transport = wrapped.base
	}
	if transport == nil {
		return http.DefaultTransport
	}
	return transport
}

func (t *httpTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func startClient(ctx context.Context, method string, target *url.URL) (context.Context, trace.Span) {
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(ctx, "HTTP "+method+" "+target.Hostname(), trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", target.Hostname()), attribute.String("url.scheme", target.Scheme))
	if port, err := strconv.Atoi(target.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
	}
	return ctx, span
}

func (t *httpTransport) RoundTrip(original *http.Request) (*http.Response, error) {
	ctx, span := startClient(original.Context(), original.Method, original.URL)
	r := original.Clone(ctx)
	r.Header.Del("Baggage")
	request := &bodyObservation{}
	if r.Body != nil {
		r.Body = &capturedBody{ReadCloser: r.Body, capture: request}
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(r.Header))
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
	body := &capturedBody{ReadCloser: response.Body, capture: capture, finish: finish, span: span}
	response.Body = body
	if writer, ok := body.ReadCloser.(io.Writer); ok {
		response.Body = &duplexBody{capturedBody: body, writer: writer}
	}
	return response, nil
}

func (c *bodyObservation) observedSize() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.observed }

type capturedBody struct {
	io.ReadCloser
	capture *bodyObservation
	finish  func()
	span    trace.Span
	failure sync.Once
}

func (b *capturedBody) recordError(stage string, err error) {
	if err != nil && b.span != nil {
		b.failure.Do(func() { recordFailure(b.span, stage, err) })
	}
}

func (b *capturedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.capture.add(p[:n], err)
	if err != nil && b.finish != nil {
		if err != io.EOF {
			b.recordError("read_response", err)
		}
		b.finish()
	}
	return n, err
}

func (b *capturedBody) Close() error {
	err := b.ReadCloser.Close()
	if b.finish != nil {
		if err != nil {
			b.recordError("close_response", err)
		}
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
		b.recordError("write_upgrade", err)
	}
	return n, err
}
