package telemetry

import (
	"bufio"
	"context"
	"errors"
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
	"go.opentelemetry.io/otel/trace"
)

var (
	httpMeter    = otel.Meter(instrumentationName + "/http")
	httpRequests = mustCounter(httpMeter.Int64Counter(semconv.AntnestIdentityHttpRequests))
	httpDuration = mustHistogram(httpMeter.Float64Histogram(semconv.AntnestIdentityHttpDuration, metric.WithUnit("s")))
)

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	captureRPC := strings.EqualFold(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")), "true")
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx, span := semconv.StartServer(request, instrumentationName+"/http", nil)
		started := time.Now()
		instrumented := request.WithContext(ctx)
		body := &countedBody{}
		if instrumented.Body != nil {
			instrumented.Body = semconv.WrapBody(instrumented.Body, semconv.BodyCallbacks{
				Read: func(n int, _ error) { body.bytes.Add(int64(n)) },
			})
		}
		observed := &statusWriter{span: span, captureRPC: captureRPC}
		observed.ServerWriter = semconv.NewServerWriter(response, ctx, func(err error) {
			if observed.err == nil {
				observed.err = err
			}
		})

		if deadline, ok := ctx.Deadline(); ok {
			span.SetAttributes(semconv.AliasAttributes(attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
		}
		defer func() {
			failure := recover()
			if failure != nil && observed.err == nil {
				observed.err = errors.New("handler aborted")
			}
			if observed.err == nil && ctx.Err() != nil {
				observed.err = ctx.Err()
			}
			if failure != nil && !observed.WroteHeader {
				observed.Status = 0
			}

			span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", body.bytes.Load()))...)

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
	if observed.Status >= 400 {
		result = "rejected"
	}
	if observed.Status >= 500 || (observed.err != nil && observed.Status < 400) {
		result = "error"
	}
	if errors.Is(observed.err, context.Canceled) {
		result = "cancelled"
	}
	attributes := []attribute.KeyValue{attribute.String("http.request.method", request.Method), attribute.String("http.route", route), attribute.String(semconv.AntnestOutcome, result)}
	if observed.Status != 0 {
		attributes = append(attributes, attribute.Int("http.response.status_code", observed.Status))
	}
	span.SetName("HTTP " + request.Method + " " + route)
	span.SetAttributes(semconv.AliasAttributes(attributes...)...)
	span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, result), attribute.Int64("http.response.body.size", observed.Written))...)

	if observed.err != nil {
		rejected := observed.Status >= 400 && observed.Status < 500 && !errors.Is(observed.err, context.Canceled) && observed.WriteErr == nil
		recordError(span, "protocol", observed.err, !rejected)
		if rejected {
			span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "rejected"))...)
		}
	} else if observed.Status >= 500 {
		span.SetStatus(codes.Error, strconv.Itoa(observed.Status))
		span.SetAttributes(semconv.AliasAttributes(attribute.String("error.type", strconv.Itoa(observed.Status)))...)
	}
	httpRequests.Add(ctx, 1, metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
	httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
	if route != "/status" || result != "success" {
		fields := []any{"method", request.Method, "route", route, "status_code", observed.Status, "result", result, "duration_ms", time.Since(started).Milliseconds(), "trace_id", span.SpanContext().TraceID().String(), "span_id", span.SpanContext().SpanID().String()}
		if observed.err != nil {
			code, message := ErrorSummary(observed.err)
			fields = append(fields, "error_type", code, "error_message", message, "cause_types", causeTypes(observed.err))
			if reason := passwordAdmissionReason(observed.err); reason != "" {
				fields = append(fields, "password_admission_reason", reason)
			}
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
	bytes atomic.Int64
}

type statusWriter struct {
	*semconv.ServerWriter
	span       trace.Span
	err        error
	rpc        bool
	captureRPC bool
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := w.ServerWriter.Hijack()
	if err == nil {
		w.Status = http.StatusSwitchingProtocols
		w.WroteHeader = true
	}
	return connection, buffer, err
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
