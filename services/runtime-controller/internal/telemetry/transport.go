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

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
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
	span.SetAttributes(semconv.AliasAttributes(attribute.String("http.request.method", request.Method), attribute.String("peer.service", t.target), attribute.String("server.address", SafeValue(request.URL.Hostname())))...)
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int("server.port", port))...)
	}
	setDeadline(span, ctx)
	var sent atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			sent.Store(true)
		}
	}})
	cloned := semconv.CloneRequest(request, ctx, nil)

	requestBody := &outboundRequestBody{}
	if cloned.Body != nil {
		cloned.Body = semconv.WrapBody(cloned.Body, semconv.BodyCallbacks{
			Read: func(n int, _ error) { requestBody.bytes.Add(int64(n)) },
		})
	}
	response, err := t.base.RoundTrip(cloned)
	state := &httpObservation{span: span}
	if err != nil {
		span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestRequestSent, sent.Load()), attribute.Int64("http.request.body.size", requestBody.bytes.Load()))...)
		RecordFailure(ctx, span, err, "http_send", "transport_failed", "HTTP request transport failed")

		span.End()
		return response, err
	}
	span.SetAttributes(semconv.AliasAttributes(attribute.Int("http.response.status_code", response.StatusCode))...)
	expectedAbsence, _ := request.Context().Value(expectedDockerAbsenceKey{}).(bool)
	body := &outboundBody{ctx: ctx, state: state, request: requestBody, status: response.StatusCode, sent: &sent,
		expectedAbsence: expectedAbsence && t.target == "docker" && request.Method == http.MethodGet}
	if response.Body == nil || response.Body == http.NoBody {
		body.finish(nil)
		return response, nil
	}
	response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
		Read: func(n int, err error) {
			body.bytes.Add(int64(n))
			if err == nil {
				return
			}
			if errors.Is(err, io.EOF) {
				body.finish(nil)
			} else {
				body.finish(err)
			}
		},
		Close: func(err error) { body.finish(err) },
	})
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
	bytes atomic.Int64
}

type outboundBody struct {
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
	span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestRequestSent, b.sent.Load()), attribute.Int64("http.request.body.size", b.request.bytes.Load()), attribute.Int64("http.response.body.size", b.bytes.Load()))...)
	switch {
	case err != nil:
		RecordFailure(b.ctx, span, err, "http_response", "response_failed", "HTTP response read, close or cancellation failed")
	case b.status == http.StatusNotFound && b.expectedAbsence:
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "absent"))...)
	case b.status >= 400:
		RecordFailure(b.ctx, span, nil, "http_response", strconv.Itoa(b.status), "HTTP peer returned an error status")
	default:
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "completed"))...)
	}

	span.End()
}
