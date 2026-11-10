package telemetry

import (
	"context"
	"errors"
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

type httpTransport struct {
	base    http.RoundTripper
	service string
}

func HTTPClient(client *http.Client, service string) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	copy := *client
	if _, ok := copy.Transport.(*httpTransport); !ok {
		base := copy.Transport
		if base == nil {
			base = http.DefaultTransport
		}
		copy.Transport = &httpTransport{base: base, service: service}
	}
	return &copy
}

type httpCallKey struct{}

// HTTPCall attaches protocol results to an actual HTTP exchange. It creates no
// span itself. Bounded synchronous decoders finish the exchange after EOF/close;
// streaming callers use the transport directly and end at EOF/close/cancel.
type HTTPCall struct {
	method  string
	attrs   []attribute.KeyValue
	current *httpExchange
}

func StartHTTPCall(ctx context.Context, method string, attrs []attribute.KeyValue) (context.Context, *HTTPCall) {
	call := &HTTPCall{method: method, attrs: attrs}
	return context.WithValue(ctx, httpCallKey{}, call), call
}

func (call *HTTPCall) Finish(err error) {
	if call.current == nil {
		return
	}
	if err != nil {
		call.current.fail("protocol", err)
	}
	call.current.finish()
}

func (call *HTTPCall) SetAttributes(attrs ...attribute.KeyValue) {
	if call.current != nil {
		call.current.span.SetAttributes(semconv.AliasAttributes(attrs...)...)
	}
}

type httpExchange struct {
	ctx                         context.Context
	span                        trace.Span
	requestBytes, responseBytes atomic.Int64
	done                        sync.Once
	failure                     sync.Once
	watchMu                     sync.Mutex
	ended                       bool
	stop                        func() bool
	responseSeen                bool
}

func (exchange *httpExchange) fail(phase string, err error) {
	exchange.failure.Do(func() { RecordBoundaryError(exchange.ctx, err, phase, "", "", true) })
}

func (exchange *httpExchange) finish() {
	exchange.done.Do(func() {
		exchange.watchMu.Lock()
		exchange.ended = true
		if exchange.stop != nil {
			exchange.stop()
		}
		exchange.watchMu.Unlock()
		exchange.span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", exchange.requestBytes.Load()))...)
		if exchange.responseSeen {
			exchange.span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.response.body.size", exchange.responseBytes.Load()))...)
		}
		exchange.span.End()
	})
}

func (exchange *httpExchange) watchCancellation() {
	stop := context.AfterFunc(exchange.ctx, func() {
		exchange.fail("cancellation", exchange.ctx.Err())
		exchange.finish()
	})
	exchange.watchMu.Lock()
	if exchange.ended {
		stop()
	} else {
		exchange.stop = stop
	}
	exchange.watchMu.Unlock()
}

func (transport *httpTransport) RoundTrip(original *http.Request) (*http.Response, error) {
	call, _ := original.Context().Value(httpCallKey{}).(*HTTPCall)
	if call != nil && call.current != nil {
		call.current.finish()
	}
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(original.Context(), "HTTP "+original.Method+" "+transport.service, trace.WithSpanKind(trace.SpanKindClient))
	exchange := &httpExchange{ctx: ctx, span: span}
	if call != nil {
		call.current = exchange
		span.SetAttributes(semconv.AliasAttributes(call.attrs...)...)
		span.SetAttributes(semconv.AliasAttributes(attribute.String("rpc.system.name", "antnest.http-json"), attribute.String("rpc.service", transport.service), attribute.String("rpc.method", call.method))...)
	}
	request := semconv.CloneRequest(original, ctx, nil)
	span.SetAttributes(semconv.AliasAttributes(attribute.String("http.request.method", request.Method), attribute.String("server.address", request.URL.Hostname()), attribute.String(semconv.AntnestTargetService, transport.service))...)
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int("server.port", port))...)
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
	}

	span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestRequestTransportInvoked, true))...)
	if request.Body != nil {
		request.Body = semconv.WrapBody(request.Body, semconv.BodyCallbacks{
			Read: func(n int, _ error) { exchange.requestBytes.Add(int64(n)) },
		})
	}
	response, err := transport.base.RoundTrip(request)
	if err != nil {
		exchange.fail("send", err)
		exchange.finish()
		return response, err
	}
	if response == nil {
		err = errors.New("HTTP transport returned no response")
		exchange.fail("send", err)
		exchange.finish()
		return nil, err
	}
	exchange.responseSeen = true
	span.SetAttributes(semconv.AliasAttributes(attribute.Int("http.response.status_code", response.StatusCode))...)
	if response.StatusCode >= 400 {
		span.SetStatus(codes.Error, strconv.Itoa(response.StatusCode))
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "error"), attribute.String("error.type", strconv.Itoa(response.StatusCode)))...)
	}
	if response.Body == nil || response.Body == http.NoBody {
		if call == nil {
			exchange.finish()
		}
		return response, nil
	}
	protocol := call != nil
	response.Body = semconv.WrapBody(response.Body, semconv.BodyCallbacks{
		Read: func(n int, err error) {
			exchange.responseBytes.Add(int64(n))
			if err == nil {
				return
			}
			if !errors.Is(err, io.EOF) {
				exchange.fail("read_response", err)
			}
			if !protocol || !errors.Is(err, io.EOF) {
				exchange.finish()
			}
		},
		Close: func(err error) {
			if err != nil {
				exchange.fail("close_response", err)
			}
			if !protocol || err != nil {
				exchange.finish()
			}
		},
		Write: func(n int, err error) {
			exchange.requestBytes.Add(int64(n))
			if err != nil {
				exchange.fail("write_upgrade", err)
				exchange.finish()
			}
		},
	})
	if call == nil {
		exchange.watchCancellation()
	}
	return response, nil
}

func (transport *httpTransport) CloseIdleConnections() {
	if closer, ok := transport.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
