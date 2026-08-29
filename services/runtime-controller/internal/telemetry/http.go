package telemetry

import (
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
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
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(
			request.Context(), propagation.HeaderCarrier(request.Header),
		)
		ctx, span := httpTracer.Start(ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer))
		started := time.Now()
		observed := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		instrumented := request.WithContext(ctx)
		next.ServeHTTP(observed, instrumented)
		route := instrumented.Pattern
		if route == "" {
			route = "unmatched"
		}
		attributes := []attribute.KeyValue{
			attribute.String("http.request.method", request.Method),
			attribute.String("http.route", route),
			attribute.Int("http.response.status_code", observed.status),
		}
		span.SetName("HTTP " + request.Method + " " + route)
		span.SetAttributes(attributes...)
		if observed.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, strconv.Itoa(observed.status))
		}
		span.End()
		httpRequests.Add(ctx, 1, metric.WithAttributes(attributes...))
		httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
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
