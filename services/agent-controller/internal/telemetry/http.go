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

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var (
	httpMeter    = otel.Meter(instrumentationName + "/http")
	httpRequests = mustCounter(httpMeter.Int64Counter(semconv.AntnestAgentControllerHttpRequests))
	httpDuration = mustHistogram(httpMeter.Float64Histogram(
		semconv.AntnestAgentControllerHttpDuration, metric.WithUnit("s"),
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
		ctx, span := semconv.StartServer(request.WithContext(ctx), instrumentationName+"/http", nil)
		started := time.Now()
		observed := &statusWriter{captureRPC: captureRPC}
		observed.ServerWriter = semconv.NewServerWriter(response, ctx, func(err error) {
			if ctx != nil {
				RecordBoundaryError(ctx, err, "write_response", "", "", true)
			}
		})
		instrumented := request.WithContext(ctx)
		var requestBytes atomic.Int64
		if instrumented.Body != nil {
			instrumented.Body = semconv.WrapBody(instrumented.Body, semconv.BodyCallbacks{
				Read: func(n int, _ error) { requestBytes.Add(int64(n)) },
			})
		}

		if deadline, ok := ctx.Deadline(); ok {
			span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
		}
		defer func() {
			panicValue := recover()
			status := observed.Status
			if panicValue != nil && !observed.WroteHeader {
				status = http.StatusInternalServerError
			}
			if panicValue != nil {
				RecordBoundaryError(ctx, errors.New("handler panic"), "handler_panic", "internal_error", "handler panicked; panic value omitted", true)
			}
			if ctx.Err() != nil {
				RecordBoundaryError(ctx, ctx.Err(), "request", "", "", true)
			}

			span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", requestBytes.Load()), attribute.Int64("http.response.body.size", observed.Written))...)
			finishHTTPRequest(
				ctx, span, logger, request.Method, routePattern(instrumented), status,
				panicValue != nil || observed.WriteErr != nil || ctx.Err() != nil || observed.outcome == "error", started,
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
	observed := &statusWriter{}
	observed.ServerWriter = semconv.NewServerWriter(response, nil, nil)
	var panicValue any
	func() {
		defer func() { panicValue = recover() }()
		next.ServeHTTP(observed, request)
	}()
	if observed.Status < http.StatusBadRequest && panicValue == nil {
		return
	}
	status := observed.Status
	if panicValue != nil && !observed.WroteHeader {
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
		attribute.String(semconv.AntnestOutcome, result),
	}
	span.SetName("HTTP " + method + " " + route)
	span.SetAttributes(semconv.AliasAttributes(attributes...)...)
	if status >= http.StatusInternalServerError {
		span.SetStatus(codes.Error, strconv.Itoa(status))
	} else if executionFailed {
		span.SetStatus(codes.Error, "request_failed")
	}
	span.End()
	httpRequests.Add(ctx, 1, metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
	httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
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
	*semconv.ServerWriter
	captureRPC bool
	rpc        bool
	outcome    string
}

func (writer *statusWriter) HTTPStatus() int { return writer.Status }

func (writer *statusWriter) TraceContext() context.Context {
	if writer.Ctx == nil {
		return context.Background()
	}
	return writer.Ctx
}

func RecordHTTPOutcome(response http.ResponseWriter, outcome string) {
	if writer, ok := response.(*statusWriter); ok {
		writer.outcome = outcome
	}
}

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return writer.ServerWriter.Hijack()
}

// ReaderFrom must traverse Write so streaming byte counts and failures remain
// visible without aggregating the stream.
func (writer *statusWriter) ReadFrom(reader io.Reader) (int64, error) {
	return writer.ServerWriter.ReadFrom(reader)
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
