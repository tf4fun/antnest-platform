package telemetry

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
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
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/status" {
			observeReadinessFailure(next, response, request, logger)
			return
		}
		ctx := otel.GetTextMapPropagator().Extract(
			request.Context(), propagation.HeaderCarrier(request.Header),
		)
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(
			ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer),
		)
		started := time.Now()
		observed := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		instrumented := request.WithContext(ctx)
		defer func() {
			panicValue := recover()
			if panicValue != nil {
				observed.status = http.StatusInternalServerError
			}
			finishHTTPRequest(
				ctx, span, logger, request.Method, routePattern(instrumented), observed.status, started,
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
	next.ServeHTTP(observed, request)
	if observed.status < http.StatusInternalServerError {
		return
	}
	ctx := otel.GetTextMapPropagator().Extract(
		request.Context(), propagation.HeaderCarrier(request.Header),
	)
	ctx, span := otel.Tracer(instrumentationName+"/http").Start(
		ctx, "HTTP "+request.Method+" /status",
		trace.WithSpanKind(trace.SpanKindServer), trace.WithTimestamp(started),
	)
	finishHTTPRequest(ctx, span, logger, request.Method, "/status", observed.status, started)
}

func finishHTTPRequest(
	ctx context.Context,
	span trace.Span,
	logger *slog.Logger,
	method string,
	route string,
	status int,
	started time.Time,
) {
	result := "success"
	if status >= http.StatusBadRequest {
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
	}
	span.End()
	httpRequests.Add(ctx, 1, metric.WithAttributes(attributes...))
	httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	if route != "/status" || result == "error" {
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
	if prefix := request.Method + " "; strings.HasPrefix(pattern, prefix) {
		pattern = strings.TrimSpace(strings.TrimPrefix(pattern, prefix))
	}
	return pattern
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *statusWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
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
