package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"sync"
	"sync/atomic"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type Transport struct {
	base   http.RoundTripper
	target string
}

type expectedDockerAbsenceKey struct{}

// WithExpectedDockerAbsence applies only to the caller's single existence GET.
// Never pass the returned context to required-resource or post-create checks.
func WithExpectedDockerAbsence(ctx context.Context) context.Context {
	return context.WithValue(ctx, expectedDockerAbsenceKey{}, true)
}

// NewTransport instruments an existing client without changing its timeout,
// proxy, socket dialer, redirect policy, or retry behavior.
func NewTransport(base http.RoundTripper, target string) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	if _, ok := base.(*Transport); ok {
		return base
	}
	return &Transport{base: base, target: SafeValue(target)}
}

func (t *Transport) RoundTrip(request *http.Request) (*http.Response, error) {
	ctx, span := httpTracer.Start(request.Context(), "HTTP "+request.Method+" "+t.target, trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("peer.service", t.target), attribute.String("server.address", SafeValue(request.URL.Hostname())))
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	setDeadline(span, ctx)
	var sent atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			sent.Store(true)
		}
	}})
	cloned := request.Clone(ctx)
	if cloned.Header == nil {
		cloned.Header = make(http.Header)
	}
	cloned.Header.Del("Baggage")
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(cloned.Header))

	requestBody := &outboundRequestBody{ReadCloser: cloned.Body}
	if cloned.Body != nil {
		cloned.Body = requestBody
	}
	response, err := t.base.RoundTrip(cloned)
	state := &httpObservation{span: span}
	if err != nil {
		span.SetAttributes(attribute.Bool("antnest.request.sent", sent.Load()), attribute.Int64("http.request.body.size", requestBody.bytes.Load()))
		RecordFailure(ctx, span, err, "http_send", "transport_failed", "HTTP request transport failed")

		span.End()
		return response, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	expectedAbsence, _ := request.Context().Value(expectedDockerAbsenceKey{}).(bool)
	body := &outboundBody{ReadCloser: response.Body, ctx: ctx, state: state, request: requestBody, status: response.StatusCode, sent: &sent,
		expectedAbsence: expectedAbsence && t.target == "docker" && request.Method == http.MethodGet}
	if response.Body == nil || response.Body == http.NoBody {
		body.finish(nil)
		return response, nil
	}
	if writer, ok := response.Body.(io.ReadWriteCloser); ok {
		response.Body = &outboundUpgrade{outboundBody: body, writer: writer}
	} else {
		response.Body = body
	}
	body.mu.Lock()
	body.stop = context.AfterFunc(ctx, func() { body.finish(ctx.Err()) })
	body.mu.Unlock()
	return response, nil
}

func (t *Transport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

type outboundRequestBody struct {
	io.ReadCloser
	bytes atomic.Int64
}

func (b *outboundRequestBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytes.Add(int64(n))
	return n, err
}

type outboundBody struct {
	io.ReadCloser
	ctx             context.Context
	state           *httpObservation
	request         *outboundRequestBody
	status          int
	expectedAbsence bool
	sent            *atomic.Bool
	bytes           atomic.Int64
	mu              sync.Mutex
	ended           bool
	stop            func() bool
}

func (b *outboundBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytes.Add(int64(n))
	if err != nil {
		if errors.Is(err, io.EOF) {
			b.finish(nil)
		} else {
			b.finish(err)
		}
	}
	return n, err
}
func (b *outboundBody) Close() error {
	err := b.ReadCloser.Close()
	b.finish(err)
	return err
}
func (b *outboundBody) finish(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ended {
		return
	}
	b.ended = true
	if b.stop != nil {
		b.stop()
	}
	span := b.state.span
	span.SetAttributes(attribute.Bool("antnest.request.sent", b.sent.Load()), attribute.Int64("http.request.body.size", b.request.bytes.Load()), attribute.Int64("http.response.body.size", b.bytes.Load()))
	switch {
	case err != nil:
		RecordFailure(b.ctx, span, err, "http_response", "response_failed", "HTTP response read, close or cancellation failed")
	case b.status == http.StatusNotFound && b.expectedAbsence:
		span.SetAttributes(attribute.String("antnest.outcome", "absent"))
	case b.status >= 400:
		RecordFailure(b.ctx, span, nil, "http_response", strconv.Itoa(b.status), "HTTP peer returned an error status")
	default:
		span.SetAttributes(attribute.String("antnest.outcome", "completed"))
	}

	span.End()
}

type outboundUpgrade struct {
	*outboundBody
	writer io.Writer
}

func (b *outboundUpgrade) Write(p []byte) (int, error) { return b.writer.Write(p) }
