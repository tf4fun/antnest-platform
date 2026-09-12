package telemetry

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
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
	request := original.Clone(ctx)
	request.Header.Del("Baggage")
	span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("server.address", request.URL.Hostname()), attribute.String("url.scheme", request.URL.Scheme))
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
	}

	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
	requestBody := &countedBody{ReadCloser: request.Body}
	if request.Body != nil {
		request.Body = requestBody
	}
	span.SetAttributes(attribute.Bool("antnest.http.transport_invoked", true))
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
	span.SetAttributes(attribute.String("antnest.outcome", outcome))
	body := &clientBody{ReadCloser: response.Body, span: span, ctx: ctx, request: requestBody}
	if response.Body == nil || response.Body == http.NoBody {
		body.finish("eof", nil)
		return response, nil
	}
	response.Body = body
	body.stopCancel = context.AfterFunc(ctx, func() { body.finish("cancelled", ctx.Err()) })
	if writer, ok := body.ReadCloser.(io.Writer); ok {
		response.Body = &duplexBody{clientBody: body, writer: writer}
	}
	return response, nil
}

type clientBody struct {
	io.ReadCloser
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
		b.span.SetAttributes(attribute.Int64("http.request.body.size", b.request.bytes.Load()), attribute.Int64("http.response.body.size", b.bytes.Load()), attribute.String("antnest.http.termination", reason))
		b.span.End()
	})
}

func (b *clientBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytes.Add(int64(n))
	if err == io.EOF {
		b.finish("eof", nil)
	} else if err != nil {
		b.finish("read_response", err)
	}
	if err != nil && b.stopCancel != nil {
		b.stopCancel()
	}
	return n, err
}

func (b *clientBody) Close() error {
	err := b.ReadCloser.Close()
	b.finish("close", err)
	if b.stopCancel != nil {
		b.stopCancel()
	}
	return err
}

type duplexBody struct {
	*clientBody
	writer io.Writer
}

func (b *duplexBody) Write(p []byte) (int, error) {
	n, err := b.writer.Write(p)
	if err != nil {
		b.finish("write_upgrade", err)
	}
	return n, err
}
