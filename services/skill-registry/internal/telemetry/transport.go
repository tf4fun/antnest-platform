package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type transport struct {
	base    http.RoundTripper
	service string
}

func HTTPClient(client *http.Client, service string) *http.Client {
	copy := *client
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	copy.Transport = &transport{base: base, service: service}
	return &copy
}

type exchange struct {
	span  trace.Span
	done  sync.Once
	mu    sync.Mutex
	ended bool
	stop  func() bool
}

func (e *exchange) finish() {
	e.done.Do(func() {
		e.mu.Lock()
		e.ended = true
		if e.stop != nil {
			e.stop()
		}
		e.mu.Unlock()
		e.span.End()
	})
}

func (e *exchange) watchCancellation(ctx context.Context) {
	stop := context.AfterFunc(ctx, func() {
		markError(e.span, ctx.Err(), "request_error")
		e.finish()
	})
	e.mu.Lock()
	if e.ended {
		stop()
	} else {
		e.stop = stop
	}
	e.mu.Unlock()
}

func (t *transport) RoundTrip(original *http.Request) (*http.Response, error) {
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(original.Context(), "HTTP "+original.Method+" "+t.service, trace.WithSpanKind(trace.SpanKindClient))
	e := &exchange{span: span}
	request := semconv.CloneRequest(original, ctx, nil)
	span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("server.address", request.URL.Hostname()), attribute.String(semconv.AntnestTargetService, t.service))
	response, err := t.base.RoundTrip(request)
	if err != nil {
		markError(span, err, "transport_error")
		e.finish()
		return response, err
	}
	if response == nil {
		err = errors.New("HTTP transport returned no response")
		markError(span, err, "transport_error")
		e.finish()
		return nil, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	if response.StatusCode >= http.StatusBadRequest {
		span.SetStatus(codes.Error, strconv.Itoa(response.StatusCode))
	}
	if response.Body == nil || response.Body == http.NoBody {
		e.finish()
	} else {
		response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
			Read: func(_ int, err error) {
				if err == nil {
					return
				}
				if !errors.Is(err, io.EOF) {
					markError(e.span, err, "read_error")
				}
				e.finish()
			},
			Close: func(err error) {
				if err != nil {
					markError(e.span, err, "close_error")
				}
				e.finish()
			},
			Write: func(_ int, err error) {
				if err != nil {
					markError(e.span, err, "write_error")
					e.finish()
				}
			},
		})
		e.watchCancellation(ctx)
	}
	return response, nil
}

func (t *transport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
