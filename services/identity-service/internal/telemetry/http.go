package telemetry

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var (
	httpMeter    = otel.Meter(instrumentationName + "/http")
	httpRequests = mustCounter(httpMeter.Int64Counter("antnest.identity.http.requests"))
	httpDuration = mustHistogram(httpMeter.Float64Histogram("antnest.identity.http.duration", metric.WithUnit("s")))
)

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	captureRPC := strings.EqualFold(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")), "true")
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer))
		started := time.Now()
		instrumented := request.WithContext(ctx)
		body := &countedBody{ReadCloser: request.Body}
		if request.Body != nil {
			instrumented.Body = body
		}
		observed := &statusWriter{ResponseWriter: response, span: span, captureRPC: captureRPC}

		if deadline, ok := ctx.Deadline(); ok {
			span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
		}
		defer func() {
			failure := recover()
			if failure != nil && observed.err == nil {
				observed.err = errors.New("handler aborted")
			}
			if observed.err == nil && ctx.Err() != nil {
				observed.err = ctx.Err()
			}
			if observed.status == 0 && failure == nil {
				observed.status = http.StatusOK
			}

			span.SetAttributes(attribute.Int64("http.request.body.size", body.bytes.Load()))

			finishHTTPRequest(ctx, span, logger, instrumented, observed, started)
			if failure != nil {
				panic(failure)
			}
		}()
		next.ServeHTTP(observed, instrumented)
	})
}

func finishHTTPRequest(ctx context.Context, span trace.Span, logger *slog.Logger, request *http.Request, observed *statusWriter, started time.Time) {
	defer span.End()
	route := routePattern(request)
	result := "success"
	if observed.status >= 400 {
		result = "rejected"
	}
	if observed.status >= 500 || (observed.err != nil && observed.status < 400) {
		result = "error"
	}
	if errors.Is(observed.err, context.Canceled) {
		result = "cancelled"
	}
	attributes := []attribute.KeyValue{attribute.String("http.request.method", request.Method), attribute.String("http.route", route), attribute.String("antnest.result", result)}
	if observed.status != 0 {
		attributes = append(attributes, attribute.Int("http.response.status_code", observed.status))
	}
	span.SetName("HTTP " + request.Method + " " + route)
	span.SetAttributes(attributes...)
	span.SetAttributes(attribute.String("antnest.outcome", result), attribute.Int64("http.response.body.size", observed.bytes))

	if observed.err != nil {
		rejected := observed.status >= 400 && observed.status < 500 && !errors.Is(observed.err, context.Canceled) && observed.writeErr == nil
		recordError(span, "protocol", observed.err, !rejected)
		if rejected {
			span.SetAttributes(attribute.String("antnest.outcome", "rejected"))
		}
	} else if observed.status >= 500 {
		span.SetStatus(codes.Error, strconv.Itoa(observed.status))
		span.SetAttributes(attribute.String("error.type", strconv.Itoa(observed.status)))
	}
	httpRequests.Add(ctx, 1, metric.WithAttributes(attributes...))
	httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	if route != "/status" || result != "success" {
		fields := []any{"method", request.Method, "route", route, "status_code", observed.status, "result", result, "duration_ms", time.Since(started).Milliseconds(), "trace_id", span.SpanContext().TraceID().String(), "span_id", span.SpanContext().SpanID().String()}
		if observed.err != nil {
			code, message := ErrorSummary(observed.err)
			fields = append(fields, "error_type", code, "error_message", message, "cause_types", causeTypes(observed.err))
		}
		logger.InfoContext(ctx, "Identity HTTP request completed", fields...)
	}
}

func routePattern(request *http.Request) string {
	pattern := strings.TrimSpace(request.Pattern)
	if pattern == "" {
		return "unmatched"
	}
	if _, route, ok := strings.Cut(pattern, " "); ok {
		pattern = strings.TrimSpace(route)
	}
	return pattern
}

type countedBody struct {
	io.ReadCloser
	bytes atomic.Int64
}

func (b *countedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytes.Add(int64(n))
	return n, err
}

type statusWriter struct {
	http.ResponseWriter
	span       trace.Span
	status     int
	bytes      int64
	err        error
	writeErr   error
	rpc        bool
	captureRPC bool
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 100 && status < 200 && status != 101 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status

	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	if err != nil {
		w.writeErr = err
		if w.err == nil {
			w.err = err
		}
	}
	return n, err
}
func (w *statusWriter) Flush() { _ = w.FlushError() }
func (w *statusWriter) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.writeErr = err
		if w.err == nil {
			w.err = err
		}
	}
	return err
}
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.status = http.StatusSwitchingProtocols

	}
	return connection, buffer, err
}
func (w *statusWriter) Push(target string, options *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, options)
	}
	return http.ErrNotSupported
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
