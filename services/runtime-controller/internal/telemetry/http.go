package telemetry

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var (
	httpTracer   = otel.Tracer(instrumentationName)
	httpMeter    = otel.Meter(instrumentationName)
	httpRequests = mustCounter(httpMeter.Int64Counter("http.server.requests"))
	httpDuration = mustHistogram(httpMeter.Float64Histogram("http.server.request.duration", metric.WithUnit("s")))
)

func HTTPHandler(next http.Handler) http.Handler {
	captureRPC := strings.EqualFold(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")), "true")
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		ctx, span := httpTracer.Start(ctx, request.Method, trace.WithSpanKind(trace.SpanKindServer))
		started := time.Now()
		state := &httpObservation{span: span, captureRPC: captureRPC}
		ctx = context.WithValue(ctx, observationKey{}, state)
		observed := &statusWriter{ResponseWriter: response, observation: state, ctx: ctx}
		instrumented := request.WithContext(ctx)
		if request.Body != nil {
			instrumented.Body = &requestCounter{ReadCloser: request.Body, observation: state}
		}

		setDeadline(span, ctx)
		defer func() {
			panicValue := recover()
			route := normalizedRoute(instrumented.Pattern)
			span.SetName("HTTP " + request.Method + " " + route)

			attributes := []attribute.KeyValue{attribute.String("http.request.method", request.Method), attribute.String("http.route", route)}
			if observed.status != 0 {
				attributes = append(attributes, attribute.Int("http.response.status_code", observed.status))
			}
			span.SetAttributes(attributes...)

			span.SetAttributes(attribute.Int64("http.request.body.size", state.requestBytes), attribute.Int64("http.response.body.size", observed.bytes))

			switch {
			case panicValue != nil:
				RecordFailure(ctx, span, fmt.Errorf("panic value of type %T", panicValue), "handler", "panic", "HTTP handler panicked")
			case observed.err != nil:
				RecordFailure(ctx, span, observed.err, "response_write", "response_write_failed", "HTTP response delivery failed")
			case ctx.Err() != nil:
				RecordFailure(ctx, span, ctx.Err(), "handler", "request_canceled", "HTTP request ended by cancellation")
			case observed.status >= 500 && !state.failed:
				RecordFailure(ctx, span, nil, "handler", strconv.Itoa(observed.status), "HTTP server returned an error")
			case !state.failed && state.outcome == "":
				outcome := "completed"
				if observed.status >= 400 {
					outcome = "rejected"
				}
				span.SetAttributes(attribute.String("antnest.outcome", outcome))
			}
			span.End()
			httpRequests.Add(ctx, 1, metric.WithAttributes(attributes...))
			httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(observed, instrumented)
		if observed.status == 0 {
			observed.status = http.StatusOK
		}
	})
}

func normalizedRoute(pattern string) string {
	if _, route, found := strings.Cut(pattern, " "); found {
		pattern = route
	}
	if pattern == "" || pattern == "/" {
		return "unmatched"
	}
	return pattern
}

type requestCounter struct {
	io.ReadCloser
	observation *httpObservation
}

func (r *requestCounter) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	r.observation.requestBytes += int64(n)
	return n, err
}

type statusWriter struct {
	http.ResponseWriter
	observation *httpObservation
	ctx         context.Context
	status      int
	bytes       int64
	err         error
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	if err != nil {
		w.err = err
	}
	return n, err
}
func (w *statusWriter) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.err = err
	}
	return err
}
func (w *statusWriter) Flush() { _ = w.FlushError() }
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustHistogram(instrument metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return instrument
}
