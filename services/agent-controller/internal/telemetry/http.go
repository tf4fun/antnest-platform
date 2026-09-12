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
	httpRequests = mustCounter(httpMeter.Int64Counter("antnest.agent_controller.http.requests"))
	httpDuration = mustHistogram(httpMeter.Float64Histogram(
		"antnest.agent_controller.http.duration", metric.WithUnit("s"),
	))
)

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	captureRPC := strings.EqualFold(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")), "true")
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		if request.Method == http.MethodGet && isStatusRoute(request.URL.Path) && !trace.SpanContextFromContext(ctx).IsValid() {
			observeReadinessFailure(next, response, request, logger)
			return
		}
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(
			ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer),
		)
		started := time.Now()
		observed := &statusWriter{ResponseWriter: response, status: http.StatusOK, ctx: ctx, captureRPC: captureRPC}
		instrumented := request.WithContext(ctx)
		var requestBytes atomic.Int64
		if instrumented.Body != nil {
			instrumented.Body = &requestCounter{ReadCloser: instrumented.Body, observed: &requestBytes}
		}

		if deadline, ok := ctx.Deadline(); ok {
			span.SetAttributes(attribute.Int64("antnest.request.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
		}
		defer func() {
			panicValue := recover()
			status := observed.status
			if panicValue != nil && !observed.wroteHeader {
				status = http.StatusInternalServerError
			}
			if panicValue != nil {
				RecordBoundaryError(ctx, errors.New("handler panic"), "handler_panic", "internal_error", "handler panicked; panic value omitted", true)
			}
			if ctx.Err() != nil {
				RecordBoundaryError(ctx, ctx.Err(), "request", "", "", true)
			}

			span.SetAttributes(attribute.Int64("http.request.body.size", requestBytes.Load()), attribute.Int64("http.response.body.size", observed.written))
			finishHTTPRequest(
				ctx, span, logger, request.Method, routePattern(instrumented), status,
				panicValue != nil || observed.writeErr != nil || ctx.Err() != nil || observed.outcome == "error", started,
			)
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(observed, instrumented)
	})
}

func observeReadinessFailure(
	next http.Handler,
	response http.ResponseWriter,
	request *http.Request,
	logger *slog.Logger,
) {
	started := time.Now()
	observed := &statusWriter{ResponseWriter: response, status: http.StatusOK}
	var panicValue any
	func() {
		defer func() { panicValue = recover() }()
		next.ServeHTTP(observed, request)
	}()
	if observed.status < http.StatusBadRequest && panicValue == nil {
		return
	}
	status := observed.status
	if panicValue != nil && !observed.wroteHeader {
		status = http.StatusInternalServerError
	}
	ctx := otel.GetTextMapPropagator().Extract(
		request.Context(), propagation.HeaderCarrier(request.Header),
	)
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(
		ctx, "HTTP "+request.Method+" "+request.URL.Path,
		trace.WithSpanKind(trace.SpanKindServer), trace.WithTimestamp(started),
	)
	finishHTTPRequest(
		ctx, span, logger, request.Method, request.URL.Path, status, panicValue != nil, started,
	)
	if panicValue != nil {
		panic(panicValue)
	}
}

func finishHTTPRequest(
	ctx context.Context,
	span trace.Span,
	logger *slog.Logger,
	method string,
	route string,
	status int,
	executionFailed bool,
	started time.Time,
) {
	result := "success"
	if status >= http.StatusBadRequest || executionFailed {
		result = "error"
	}
	attributes := []attribute.KeyValue{
		attribute.String("http.request.method", method),
		attribute.String("http.route", route),
		attribute.Int("http.response.status_code", status),
		attribute.String("antnest.result", result),
	}
	span.SetName("HTTP " + method + " " + route)
	span.SetAttributes(attributes...)
	if status >= http.StatusInternalServerError {
		span.SetStatus(codes.Error, strconv.Itoa(status))
	} else if executionFailed {
		span.SetStatus(codes.Error, "request_failed")
	}
	span.End()
	httpRequests.Add(ctx, 1, metric.WithAttributes(attributes...))
	httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	if !isStatusRoute(route) || result == "error" {
		logger.InfoContext(ctx, "Agent Controller HTTP request completed",
			"method", method, "route", route, "status_code", status, "result", result,
		)
	}
}

func routePattern(request *http.Request) string {
	pattern := strings.TrimSpace(request.Pattern)
	if pattern == "" {
		return "unmatched"
	}
	if _, path, ok := strings.Cut(pattern, " "); ok {
		pattern = strings.TrimSpace(path)
	}
	return pattern
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	ctx         context.Context
	captureRPC  bool
	rpc         bool
	written     int64
	writeErr    error
	outcome     string
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *statusWriter) HTTPStatus() int { return writer.status }

func (writer *statusWriter) TraceContext() context.Context {
	if writer.ctx == nil {
		return context.Background()
	}
	return writer.ctx
}

func RecordHTTPOutcome(response http.ResponseWriter, outcome string) {
	if writer, ok := response.(*statusWriter); ok {
		writer.outcome = outcome
	}
}

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(writer.ResponseWriter).Hijack()
}

func (writer *statusWriter) WriteHeader(status int) {
	if writer.wroteHeader {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		writer.ResponseWriter.WriteHeader(status)
		return
	}
	writer.wroteHeader = true
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Write(payload []byte) (int, error) {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	n, err := writer.ResponseWriter.Write(payload)
	writer.written += int64(n)
	if err != nil && writer.writeErr == nil {
		writer.writeErr = err
		if writer.ctx != nil {
			RecordBoundaryError(writer.ctx, err, "write_response", "", "", true)
		}
	}
	return n, err
}

func (writer *statusWriter) FlushError() error {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

func (writer *statusWriter) Flush() {
	if err := writer.FlushError(); err != nil {
		writer.writeErr = err
	}
}

// ReaderFrom must traverse Write so streaming byte counts and failures remain
// visible without aggregating the stream.
func (writer *statusWriter) ReadFrom(reader io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{writer}, reader)
}

func isStatusRoute(path string) bool {
	return path == "/status" || path == "/rpc/agent-controller/status"
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
