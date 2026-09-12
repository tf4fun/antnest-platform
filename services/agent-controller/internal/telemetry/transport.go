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

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
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
		call.current.span.SetAttributes(attrs...)
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
		exchange.span.SetAttributes(attribute.Int64("http.request.body.size", exchange.requestBytes.Load()))
		if exchange.responseSeen {
			exchange.span.SetAttributes(attribute.Int64("http.response.body.size", exchange.responseBytes.Load()))
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
		span.SetAttributes(call.attrs...)
		span.SetAttributes(attribute.String("rpc.system.name", "antnest.http-json"), attribute.String("rpc.service", transport.service), attribute.String("rpc.method", call.method))
	}
	request := original.Clone(ctx)
	request.Header.Del("Baggage")
	span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("server.address", request.URL.Hostname()), attribute.String("antnest.target.service", transport.service))
	if port, err := strconv.Atoi(request.URL.Port()); err == nil {
		span.SetAttributes(attribute.Int("server.port", port))
	}
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
	}

	span.SetAttributes(attribute.Bool("antnest.request.transport_invoked", true))
	if request.Body != nil {
		request.Body = &requestCounter{ReadCloser: request.Body, observed: &exchange.requestBytes}
	}
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
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
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	if response.StatusCode >= 400 {
		span.SetStatus(codes.Error, strconv.Itoa(response.StatusCode))
		span.SetAttributes(attribute.String("antnest.outcome", "error"), attribute.String("error.type", strconv.Itoa(response.StatusCode)))
	}
	if response.Body == nil || response.Body == http.NoBody {
		if call == nil {
			exchange.finish()
		}
		return response, nil
	}
	body := &responseCounter{ReadCloser: response.Body, exchange: exchange, protocol: call != nil}
	response.Body = body
	if writer, ok := body.ReadCloser.(io.Writer); ok {
		response.Body = &duplexCounter{responseCounter: body, writer: writer}
	}
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

type requestCounter struct {
	io.ReadCloser
	observed *atomic.Int64
}

func (body *requestCounter) Read(p []byte) (int, error) {
	n, err := body.ReadCloser.Read(p)
	body.observed.Add(int64(n))
	return n, err
}

type responseCounter struct {
	io.ReadCloser
	exchange *httpExchange
	protocol bool
}

func (body *responseCounter) Read(p []byte) (int, error) {
	n, err := body.ReadCloser.Read(p)
	body.exchange.responseBytes.Add(int64(n))
	if err != nil {
		if !errors.Is(err, io.EOF) {
			body.exchange.fail("read_response", err)
		}
		if !body.protocol || !errors.Is(err, io.EOF) {
			body.exchange.finish()
		}
	}
	return n, err
}
func (body *responseCounter) Close() error {
	err := body.ReadCloser.Close()
	if err != nil {
		body.exchange.fail("close_response", err)
	}
	if !body.protocol || err != nil {
		body.exchange.finish()
	}
	return err
}

type duplexCounter struct {
	*responseCounter
	writer io.Writer
}

func (body *duplexCounter) Write(p []byte) (int, error) {
	n, err := body.writer.Write(p)
	body.exchange.requestBytes.Add(int64(n))
	if err != nil {
		body.exchange.fail("write_upgrade", err)
		body.exchange.finish()
	}
	return n, err
}
